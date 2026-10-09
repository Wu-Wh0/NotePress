'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { build } = require('../build.mjs');

const root = path.resolve(__dirname, '..');
const distRoot = path.join(root, 'dist');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readStoredZip(filename) {
  const archive = fs.readFileSync(filename);
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(eocd, -1, 'ZIP end-of-central-directory record exists');
  const count = archive.readUInt16LE(eocd + 10);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  const files = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50, 'central directory signature');
    const crc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    assert.equal(archive.readUInt32LE(localOffset), 0x04034b50, 'local file header signature');
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    assert.equal(compressedSize, uncompressedSize, 'ZIP entries use deterministic STORE compression');
    const bytes = archive.subarray(dataOffset, dataOffset + compressedSize);
    assert.equal(crc32(bytes), crc, `${name} CRC-32`);
    files.set(name, Buffer.from(bytes));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

test('plugin metadata, npm lock and Obsidian version compatibility stay synchronized', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const versions = JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8'));

  assert.equal(packageJson.version, '0.1.0');
  assert.equal(manifest.id, 'wordpress-publisher');
  assert.equal(manifest.name, '博客发布');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.minAppVersion, '1.11.4');
  assert.equal(manifest.isDesktopOnly, true);
  assert.deepEqual(versions, { '0.1.0': '1.11.4' });
  assert.deepEqual(packageLock.packages[''].dependencies, packageJson.dependencies);
  assert.deepEqual(packageLock.packages[''].devDependencies, packageJson.devDependencies);
  assert.equal(packageLock.packages['node_modules/esbuild'].version, '0.28.2');
  assert.equal(packageJson.scripts.build, 'node build.mjs');
});

test('real build wrapper bundles a synthetic entry and creates a deterministic offline install ZIP', async (t) => {
  const fixture = path.join(__dirname, `.build-fixture-${process.pid}.mjs`);
  const outputDir = path.join(distRoot, `.build-fixture-${process.pid}`);
  const archivePath = `${outputDir}.zip`;
  t.after(() => {
    fs.rmSync(fixture, { force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.rmSync(archivePath, { force: true });
    try { fs.rmdirSync(distRoot); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; }
  });

  fs.writeFileSync(fixture, `import { katexCss } from '../src/preview-assets.js';\nexport const syntheticFixture = 'synthetic-build-entry';\nexport const bundledKatexCss = katexCss;\n`);
  const options = { entryFile: fixture, outputDir };
  const first = await build(options);

  assert.deepEqual(first.files.sort(), ['main.js', 'manifest.json', 'styles.css']);
  assert.equal(first.archivePath, archivePath);
  const bundle = fs.readFileSync(path.join(outputDir, 'main.js'), 'utf8');
  assert.match(bundle, /synthetic-build-entry/);
  assert.match(bundle, /data:font\/(?:woff2|woff|ttf);base64,/);
  assert.doesNotMatch(bundle, /url\(["']?https?:/i);
  assert.doesNotMatch(bundle, /url\(["']?fonts\//i);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')));
  assert.equal(fs.readFileSync(path.join(outputDir, 'styles.css'), 'utf8'), fs.readFileSync(path.join(root, 'styles.css'), 'utf8'));

  const entries = readStoredZip(archivePath);
  assert.deepEqual([...entries.keys()].sort(), ['main.js', 'manifest.json', 'styles.css']);
  for (const name of entries.keys()) assert.deepEqual(entries.get(name), fs.readFileSync(path.join(outputDir, name)));
  const firstHash = sha256(fs.readFileSync(archivePath));
  const second = await build(options);
  assert.equal(second.archiveSha256, firstHash);
  assert.equal(sha256(fs.readFileSync(archivePath)), firstHash);
});

test('build rejects a missing entry before creating output', async (t) => {
  const outputDir = path.join(distRoot, `.missing-entry-${process.pid}`);
  t.after(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.rmSync(`${outputDir}.zip`, { force: true });
    try { fs.rmdirSync(distRoot); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; }
  });
  const missing = path.join(__dirname, `.missing-plugin-entry-${process.pid}.mjs`);
  await assert.rejects(build({ entryFile: missing, outputDir }), /entry_missing/);
  assert.equal(fs.existsSync(outputDir), false);
});

test('build refuses output outside its own dist directory without touching it', async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpress-build-boundary-'));
  const sentinel = path.join(scratch, 'protected.txt');
  fs.writeFileSync(sentinel, 'protected bytes');
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  await assert.rejects(build({ entryFile: path.join(__dirname, 'not-used.mjs'), outputDir: scratch }), /unsafe_output/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'protected bytes');
});

test('build rejects a linked output directory before following it', async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpress-linked-output-'));
  const target = path.join(scratch, 'target');
  const link = path.join(distRoot, `.linked-output-${process.pid}`);
  fs.mkdirSync(target);
  const sentinel = path.join(target, 'protected.txt');
  fs.writeFileSync(sentinel, 'junction target intact');
  try {
    fs.mkdirSync(distRoot, { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    fs.rmSync(scratch, { recursive: true, force: true });
    if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOTSUP') return t.skip(`directory link unavailable: ${error.code}`);
    throw error;
  }
  t.after(() => {
    fs.rmSync(link, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
    try { fs.rmdirSync(distRoot); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; }
  });
  await assert.rejects(build({ entryFile: path.join(__dirname, 'not-used.mjs'), outputDir: link }), /unsafe_output/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'junction target intact');
});

test('build rejects a hard-linked existing output file before truncating its peer', async (t) => {
  const scratch = path.join(distRoot, `.hardlink-scratch-${process.pid}`);
  const outputDir = path.join(distRoot, `.hardlink-output-${process.pid}`);
  const sentinel = path.join(scratch, 'protected.js');
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(sentinel, 'protected hard-link peer');
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.linkSync(sentinel, path.join(outputDir, 'main.js'));
  } catch (error) {
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
    try { fs.rmdirSync(distRoot); } catch { /* another test may own it */ }
    if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOTSUP') return t.skip(`hard link unavailable: ${error.code}`);
    throw error;
  }
  t.after(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
    try { fs.rmdirSync(distRoot); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; }
  });
  await assert.rejects(build({ entryFile: path.join(__dirname, 'not-used.mjs'), outputDir }), /unsafe_existing_output_file/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'protected hard-link peer');
});
