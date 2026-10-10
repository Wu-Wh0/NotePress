'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const esbuild = require('esbuild');

const root = __dirname;
const artifactRoot = path.resolve(root, '../../../../publication-v1/direct-plugin');
const dist = path.join(artifactRoot, 'dist');

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function exists(file) { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function ensureDirectory(directory) {
  directory = path.resolve(directory);
  const parent = path.dirname(directory);
  // Validate existing ancestors too: an ordinary child can sit below a junction.
  if (parent !== directory) ensureDirectory(parent);
  if (!exists(directory)) fs.mkdirSync(directory);
  const stat = fs.lstatSync(directory);
  const real = path.resolve(fs.realpathSync(directory));
  const same = process.platform === 'win32' ? real.toLowerCase() === directory.toLowerCase() : real === directory;
  if (!stat.isDirectory() || stat.isSymbolicLink() || !same) throw new Error('unsafe_output_directory');
}
function safeWrite(relative, bytes) {
  const target = path.resolve(dist, ...relative.split('/'));
  const inside = path.relative(dist, target);
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error('unsafe_output_path');
  let directory = dist;
  for (const part of inside.split(path.sep).slice(0, -1)) {
    directory = path.join(directory, part);
    ensureDirectory(directory);
  }
  if (exists(target)) {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('unsafe_existing_output_file');
  }
  fs.writeFileSync(target, bytes);
}

async function build() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const expected = { 'markdown-it': '14.1.0', katex: '0.16.22', esbuild: '0.28.2' };
  if (packageJson.dependencies?.['markdown-it'] !== expected['markdown-it'] || packageJson.dependencies?.katex !== expected.katex
    || packageJson.devDependencies?.esbuild !== expected.esbuild) throw new Error('desktop_dependency_pin_mismatch');
  for (const [name, version] of Object.entries(expected)) {
    const metadataPath = path.join(root, 'node_modules', name, 'package.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (metadata.version !== version) throw new Error('desktop_dependency_install_mismatch');
  }
  const manifest = fs.readFileSync(path.join(root, 'manifest.json'));
  const manifestValue = JSON.parse(manifest.toString('utf8'));
  if (manifestValue.id !== 'blog-publisher-local' || manifestValue.minAppVersion !== '1.12.7' || manifestValue.isDesktopOnly !== true) {
    throw new Error('desktop_manifest_invalid');
  }
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [path.join(root, 'entry.js')],
    outfile: 'main.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['obsidian'],
    write: false,
    legalComments: 'none',
    sourcemap: false,
  });
  if (result.outputFiles.length !== 1) throw new Error('desktop_build_output_invalid');
  const main = result.outputFiles[0].contents;
  const cssPath = path.join(root, 'node_modules', 'katex', 'dist', 'katex.min.css');
  const css = fs.readFileSync(cssPath);
  const cssText = css.toString('utf8');
  if (!Buffer.from(cssText, 'utf8').equals(css)) throw new Error('katex_css_invalid');
  const resources = new Map([['assets/katex.min.css', css]]);
  const fontRefs = new Set();
  for (const match of cssText.matchAll(/url\(([^)]*)\)/gi)) {
    const raw = match[1].trim();
    const relative = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")) ? raw.slice(1, -1) : raw;
    const prefix = 'fonts/';
    if (!relative.startsWith(prefix)) throw new Error('katex_font_reference_invalid');
    const name = relative.slice(prefix.length);
    const extension = ['.woff2', '.woff', '.ttf'].find(value => name.endsWith(value));
    const stem = extension ? name.slice(0, -extension.length) : '';
    if (!stem.startsWith('KaTeX_') || ![...stem.slice(6)].every(char => /[A-Za-z0-9_-]/.test(char))) throw new Error('katex_font_reference_invalid');
    const resourcePath = `assets/${relative}`;
    if (fontRefs.has(resourcePath)) continue;
    fontRefs.add(resourcePath);
    const source = path.join(root, 'node_modules', 'katex', 'dist', ...relative.split('/'));
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > 4 * 1024 * 1024) throw new Error('katex_font_invalid');
    resources.set(resourcePath, fs.readFileSync(source));
  }
  if (fontRefs.size !== 60) throw new Error('katex_font_inventory_unexpected');
  ensureDirectory(artifactRoot);
  ensureDirectory(dist);
  const inventory = Object.create(null);
  safeWrite('main.js', main);
  inventory['main.js'] = { bytes: main.length, sha256: sha256(main), mime: 'application/javascript' };
  safeWrite('manifest.json', manifest);
  inventory['manifest.json'] = { bytes: manifest.length, sha256: sha256(manifest), mime: 'application/json' };
  for (const [relative, bytes] of resources) {
    safeWrite(relative, bytes);
    const mime = relative.endsWith('.css') ? 'text/css; charset=utf-8' : relative.endsWith('.woff2') ? 'font/woff2' : relative.endsWith('.woff') ? 'font/woff' : 'font/ttf';
    inventory[relative] = { bytes: bytes.length, sha256: sha256(bytes), mime };
  }
  process.stdout.write(JSON.stringify({ dist, bundle_sha256: sha256(main), inventory }) + '\n');
}

if (require.main === module) build().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { build };
