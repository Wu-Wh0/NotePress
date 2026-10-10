import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(ROOT, 'dist');
const PRODUCT_ENTRY = path.join(ROOT, 'src', 'main.js');
const DEFAULT_OUTPUT = path.join(DIST_ROOT, 'notepress');
const EXPECTED = Object.freeze({
  packageName: 'obsidian-notepress',
  packageVersion: '0.2.0',
  pluginId: 'notepress',
  pluginName: 'NotePress',
  minAppVersion: '1.11.4',
  markdownIt: '15.0.2',
  katex: '0.19.0',
  esbuild: '0.28.2',
});
const EXTERNALS = ['obsidian', 'electron', 'node:*'];
const SAFE_EXTERNAL = (specifier) => specifier === 'obsidian' || specifier === 'electron' || specifier.startsWith('node:');
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function fail(code) {
  throw new Error(code);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readJson(filename, code) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    return fail(code);
  }
}

function exists(filename) {
  try {
    fs.lstatSync(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function inspectDirectoryChain(directory) {
  const absolute = path.resolve(directory);
  const volumeRoot = path.parse(absolute).root;
  const parts = absolute.slice(volumeRoot.length).split(path.sep).filter(Boolean);
  let current = volumeRoot;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_output_directory');
    let real;
    try {
      real = fs.realpathSync(current);
    } catch {
      return fail('unsafe_output_directory');
    }
    if (!samePath(real, current)) fail('unsafe_output_directory');
  }
}

function ensureDirectorySafe(directory) {
  const absolute = path.resolve(directory);
  inspectDirectoryChain(absolute);
  const volumeRoot = path.parse(absolute).root;
  const parts = absolute.slice(volumeRoot.length).split(path.sep).filter(Boolean);
  let current = volumeRoot;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      fs.mkdirSync(current);
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'EISDIR') throw error;
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(current), current)) {
      fail('unsafe_output_directory');
    }
  }
}

function validateOutputFile(filename) {
  if (!exists(filename)) return;
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('unsafe_existing_output_file');
}

function resolveOutputPaths(outputDir) {
  if (typeof outputDir !== 'string' || !outputDir) fail('unsafe_output_path');
  const absolute = path.resolve(outputDir);
  if (!isWithin(DIST_ROOT, absolute)) fail('unsafe_output_path');
  const archivePath = path.join(DIST_ROOT, `${path.basename(absolute)}.zip`);
  inspectDirectoryChain(path.dirname(absolute));
  inspectDirectoryChain(path.dirname(archivePath));
  if (exists(absolute)) {
    const stat = fs.lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_output_directory');
  }
  validateOutputFile(archivePath);
  for (const name of ['main.js', 'manifest.json', 'styles.css']) validateOutputFile(path.join(absolute, name));
  return { outputDir: absolute, archivePath };
}

function writeSafe(filename, bytes) {
  ensureDirectorySafe(path.dirname(filename));
  validateOutputFile(filename);
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.closeSync(descriptor);
    descriptor = undefined;
    validateOutputFile(filename);
    fs.renameSync(temporary, filename);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve the original write error */ }
    throw error;
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const names = Object.keys(files).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (names.length > 0xffff) fail('zip_entry_count_invalid');
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const name of names) {
    if (!/^[A-Za-z0-9._-]+$/u.test(name) || name === '.' || name === '..') fail('zip_entry_name_invalid');
    const nameBytes = Buffer.from(name, 'utf8');
    const contents = Buffer.from(files[name]);
    if (contents.length > 0xffffffff || localOffset > 0xffffffff) fail('zip32_limit_exceeded');
    const checksum = crc32(contents);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12); // 1980-01-01, the ZIP epoch.
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, contents);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // Unix creator, version 2.0.
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0x81a40000, 38); // Regular file, mode 0644.
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + contents.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  if (centralDirectory.length > 0xffffffff || localOffset > 0xffffffff) fail('zip32_limit_exceeded');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function safeInputFile(filename, errorCode) {
  let stat;
  try {
    stat = fs.lstatSync(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return fail(errorCode);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(errorCode);
  return fs.readFileSync(filename);
}

function sameRecord(left, right) {
  if (!left || typeof left !== 'object' || Array.isArray(left) || !right || typeof right !== 'object' || Array.isArray(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function validateMetadata() {
  const packageJson = readJson(path.join(ROOT, 'package.json'), 'package_metadata_invalid');
  const lock = readJson(path.join(ROOT, 'package-lock.json'), 'package_lock_invalid');
  const manifestBytes = safeInputFile(path.join(ROOT, 'manifest.json'), 'manifest_invalid');
  const manifest = readJson(path.join(ROOT, 'manifest.json'), 'manifest_invalid');
  const versions = readJson(path.join(ROOT, 'versions.json'), 'versions_invalid');
  const expectedDeps = { 'markdown-it': EXPECTED.markdownIt, katex: EXPECTED.katex };
  const expectedDevDeps = { esbuild: EXPECTED.esbuild };

  if (packageJson.name !== EXPECTED.packageName || packageJson.version !== EXPECTED.packageVersion
      || packageJson.dependencies?.['markdown-it'] !== expectedDeps['markdown-it']
      || packageJson.dependencies?.katex !== expectedDeps.katex
      || packageJson.devDependencies?.esbuild !== expectedDevDeps.esbuild) fail('dependency_pin_mismatch');
  const locked = lock.packages?.[''];
  if (lock.lockfileVersion !== 3 || lock.name !== packageJson.name || locked?.name !== packageJson.name
      || locked?.version !== packageJson.version
      || !sameRecord(locked.dependencies, packageJson.dependencies)
      || !sameRecord(locked.devDependencies, packageJson.devDependencies)) fail('package_lock_mismatch');
  if (manifest.id !== EXPECTED.pluginId || manifest.name !== EXPECTED.pluginName
      || manifest.version !== EXPECTED.packageVersion || manifest.minAppVersion !== EXPECTED.minAppVersion
      || manifest.isDesktopOnly !== true) fail('manifest_invalid');
  if (!versions || Array.isArray(versions) || typeof versions !== 'object'
      || Object.keys(versions).length !== 1 || versions[EXPECTED.packageVersion] !== EXPECTED.minAppVersion) {
    fail('versions_invalid');
  }

  for (const [name, version] of Object.entries({ ...expectedDeps, ...expectedDevDeps })) {
    const metadata = readJson(path.join(ROOT, 'node_modules', name, 'package.json'), 'dependency_missing');
    if (metadata.version !== version) fail('installed_dependency_version_mismatch');
  }
  return { manifestBytes, packageVersion: packageJson.version };
}

function createKatexPlugin() {
  const importPath = 'katex/dist/katex.min.css?inline';
  return {
    name: 'inline-offline-katex-assets',
    setup(build) {
      build.onResolve({ filter: /^katex\/dist\/katex\.min\.css\?inline$/ }, () => ({ path: importPath, namespace: 'katex-inline' }));
      build.onLoad({ filter: /.*/, namespace: 'katex-inline' }, () => {
        const cssPath = path.join(ROOT, 'node_modules', 'katex', 'dist', 'katex.min.css');
        const cssBytes = safeInputFile(cssPath, 'katex_css_missing');
        let css = cssBytes.toString('utf8');
        if (!Buffer.from(css, 'utf8').equals(cssBytes)) fail('katex_css_invalid');
        const katexDist = path.dirname(cssPath);
        let fontReferenceCount = 0;
        const fontCache = new Map();
        css = css.replace(/url\(([^)]*)\)/giu, (_match, rawValue) => {
          let relative = rawValue.trim();
          if ((relative.startsWith('"') && relative.endsWith('"')) || (relative.startsWith("'") && relative.endsWith("'"))) {
            relative = relative.slice(1, -1);
          }
          if (!relative.startsWith('fonts/')) fail('katex_font_reference_invalid');
          const name = relative.slice('fonts/'.length);
          if (!/^KaTeX_[A-Za-z0-9_-]+\.(?:woff2?|ttf)$/u.test(name)) fail('katex_font_reference_invalid');
          let dataUri = fontCache.get(relative);
          if (!dataUri) {
            const fontPath = path.join(katexDist, ...relative.split('/'));
            const fontBytes = safeInputFile(fontPath, 'katex_font_missing');
            if (fontBytes.length < 1 || fontBytes.length > 4 * 1024 * 1024) fail('katex_font_invalid');
            const mime = name.endsWith('.woff2') ? 'font/woff2' : name.endsWith('.woff') ? 'font/woff' : 'font/ttf';
            dataUri = `data:${mime};base64,${fontBytes.toString('base64')}`;
            fontCache.set(relative, dataUri);
          }
          fontReferenceCount += 1;
          return `url("${dataUri}")`;
        });
        if (fontReferenceCount < 1 || /@import|https?:\/\//iu.test(css) || /url\((?!["']?data:)/iu.test(css)) {
          fail('katex_css_not_offline');
        }
        return { contents: `export const katexCss = ${JSON.stringify(css)};`, loader: 'js' };
      });
    },
  };
}

function validateEntry(entryFile) {
  if (typeof entryFile !== 'string' || !entryFile) fail('entry_missing');
  const absolute = path.resolve(entryFile);
  if (!samePath(absolute, ROOT) && !isWithin(ROOT, absolute)) fail('unsafe_entry_path');
  safeInputFile(absolute, 'entry_missing');
  return absolute;
}

async function build({ entryFile = PRODUCT_ENTRY, outputDir = DEFAULT_OUTPUT } = {}) {
  const paths = resolveOutputPaths(outputDir);
  const metadata = validateMetadata();
  const entry = validateEntry(entryFile);
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: EXTERNALS,
    write: false,
    metafile: true,
    legalComments: 'none',
    sourcemap: false,
    charset: 'utf8',
    plugins: [createKatexPlugin()],
  });
  if (result.outputFiles.length !== 1) fail('build_output_invalid');
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) {
      if (imported.external && !SAFE_EXTERNAL(imported.path)) fail('unexpected_external_dependency');
    }
  }

  const bundle = Buffer.from(result.outputFiles[0].contents);
  const styles = safeInputFile(path.join(ROOT, 'styles.css'), 'styles_missing');
  if (/@import|url\(["']?https?:/iu.test(styles.toString('utf8'))) fail('styles_not_offline');
  const files = { 'main.js': bundle, 'manifest.json': metadata.manifestBytes, 'styles.css': styles };
  const archive = makeZip(files);

  ensureDirectorySafe(paths.outputDir);
  ensureDirectorySafe(path.dirname(paths.archivePath));
  for (const [name, bytes] of Object.entries(files)) writeSafe(path.join(paths.outputDir, name), bytes);
  writeSafe(paths.archivePath, archive);

  return {
    packageDir: paths.outputDir,
    archivePath: paths.archivePath,
    files: Object.keys(files).sort(),
    bundleSha256: sha256(bundle),
    archiveSha256: sha256(archive),
    archiveBytes: archive.length,
    packageVersion: metadata.packageVersion,
  };
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== '--entry' && flag !== '--out') || !value || value.startsWith('--')) fail('usage: node build.mjs [--entry src/main.js] [--out dist/notepress]');
    const resolved = path.resolve(ROOT, value);
    if (flag === '--entry') options.entryFile = resolved;
    else options.outputDir = resolved;
    index += 1;
  }
  return options;
}

if (process.argv[1] && samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  build(parseArgs(process.argv.slice(2)))
    .then((summary) => process.stdout.write(`${JSON.stringify(summary)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message || 'build_failed'}\n`);
      process.exitCode = 1;
    });
}

export { build, DEFAULT_OUTPUT, DIST_ROOT, PRODUCT_ENTRY };
