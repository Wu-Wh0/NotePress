'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { createFixedInputPackage, canonicalJson } = require('../desktop/core');
const { createPublicationPackage } = require('../desktop/publication');

const bundleSha256 = 'b'.repeat(64);
const targetId = 'private-vault-target-7d4c';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, checksum]);
}
function pixelPng() {
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
    pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 9, 8, 7, 255]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
function fontBytes(size) {
  const bytes = Buffer.alloc(size, 1);
  bytes.write('wOF2', 0, 'ascii');
  return bytes;
}
function makeFixed({ source, labels, approvedAssets, assets, resources } = {}) {
  const imageResources = resources || {
    'assets/katex.min.css': Buffer.from('@font-face{src:url("fonts/KaTeX_Main-Regular.woff2")}'),
    'assets/fonts/KaTeX_Main-Regular.woff2': fontBytes(8),
  };
  return createFixedInputPackage({
    path: '文章/第一篇.md',
    source: source ?? `# 数学与链接\n\n这是 [[${targetId}]]，公式 $x^2$，图片 ![图](媒体/图.png)，还有 [外链](https://example.test/path)。\n`,
    title: '中文 <标题> & "引号"',
    labels: labels ?? { [targetId]: '批准显示文本' },
    approvedAssets: approvedAssets ?? {},
    assets: assets ?? {},
    resources: imageResources,
    compilerSha256: bundleSha256,
  });
}
function fixture() {
  const image = pixelPng();
  const imageSha = sha256(image);
  const approval = { '媒体/图.png': { mime: 'image/png', sha256: imageSha } };
  const fixed = makeFixed({
    approvedAssets: approval,
    assets: { '媒体/图.png': image },
  });
  return { fixed, image, imageSha, approval };
}
function convert(bytes, approvedAssets) {
  return createPublicationPackage(bytes, { expectedBundleSha256: bundleSha256, approvedAssets });
}
function decodeFiles(packageBytes) {
  return JSON.parse(packageBytes.toString('utf8'));
}
function repackage(envelope) {
  return canonicalJson(envelope);
}
function replaceLocalFile(fixedBytes, path, bytes) {
  const envelope = JSON.parse(fixedBytes.toString('utf8'));
  envelope.files[path] = bytes.toString('base64');
  return repackage(envelope);
}

 test('converts canonical fixed input to the server package using the real renderer and approved PNG snapshot', () => {
  const { fixed, imageSha, approval } = fixture();
  const result = convert(fixed.packageBytes, approval);
  assert.ok(Buffer.isBuffer(result.manifestBytes));
  assert.ok(Buffer.isBuffer(result.packageBytes));
  const manifest = JSON.parse(result.manifestBytes.toString('utf8'));
  const wire = decodeFiles(result.packageBytes);
  assert.deepEqual(Object.keys(manifest).sort(), ['compiler', 'inventory', 'labels_sha256', 'schema', 'selected', 'source_sha256', 'title']);
  assert.equal(manifest.schema, 'publication-v1');
  assert.equal(manifest.selected, '文章/第一篇.md');
  assert.equal(manifest.source_sha256, JSON.parse(fixed.packageBytes).manifest.source_sha256);
  assert.equal(manifest.labels_sha256, JSON.parse(fixed.packageBytes).manifest.labels_sha256);
  assert.deepEqual(manifest.compiler, {
    id: 'blog-publisher-local-js', markdown_it: '14.1.0', katex: '0.16.22', bundle_sha256: bundleSha256,
  });
  assert.equal(result.packageId, sha256(result.manifestBytes));
  assert.equal(result.compilerSha256, sha256(canonicalJson(manifest.compiler)));
  assert.equal(wire.manifest, result.manifestBytes.toString('utf8'));
  assert.deepEqual(JSON.parse(wire.manifest), manifest);
  assert.equal(result.packageBytes.toString('utf8'), canonicalJson(wire).toString('utf8'));
  assert.ok(result.packageBytes.length <= 25165824);
  assert.deepEqual(Object.keys(wire.files).sort(), Object.keys(manifest.inventory).sort());
  assert.equal(Object.hasOwn(wire.files, 'source.md'), false);
  assert.equal(Object.hasOwn(wire.files, 'labels.json'), false);
  assert.equal(Object.keys(manifest.inventory).some(path => path === 'source.md' || path === 'labels.json'), false);
  assert.equal(wire.files[`assets/images/${imageSha}.png`], pixelPng().toString('base64'));
  for (const [path, encoded] of Object.entries(wire.files)) {
    const bytes = Buffer.from(encoded, 'base64');
    assert.deepEqual(Object.keys(manifest.inventory[path]).sort(), ['bytes', 'sha256']);
    assert.equal(manifest.inventory[path].bytes, bytes.length);
    assert.equal(manifest.inventory[path].sha256, sha256(bytes));
  }
  const preview = Buffer.from(wire.files['preview.html'], 'base64').toString('utf8');
  assert.ok(preview.startsWith('<!doctype html><html><head><meta charset="utf-8"><title>中文 &lt;标题&gt; &amp; &quot;引号&quot;</title><link rel="stylesheet" href="assets/katex.min.css"></head><body>'));
  assert.ok(preview.endsWith('</body></html>'));
  assert.match(preview, /批准显示文本/);
  assert.doesNotMatch(preview, new RegExp(targetId));
  assert.match(preview, /class="katex"/);
  assert.match(preview, /href="https:\/\/example\.test\/path"/);
  assert.match(preview, new RegExp(`src="assets/images/${imageSha}\\.png"`));
  assert.doesNotMatch(preview, /blob:/);
  assert.doesNotMatch(result.packageBytes.toString('utf8'), new RegExp(targetId));
});

test('wire preserves canonical manifest as the exact string required by server ingestion', () => {
  const { fixed, approval } = fixture();
  const result = convert(fixed.packageBytes, approval);
  const wire = decodeFiles(result.packageBytes);
  assert.equal(typeof wire.manifest, 'string');
  assert.equal(wire.manifest, result.manifestBytes.toString('utf8'));
  assert.equal(sha256(Buffer.from(wire.manifest, 'utf8')), result.packageId);
});

test('rejects bundle, source, labels, and resource drift from the fixed-input binding', () => {
  const { fixed } = fixture();
  const original = JSON.parse(fixed.packageBytes.toString('utf8'));
  const bundleDrift = structuredClone(original);
  bundleDrift.manifest.compiler.bundle_sha256 = 'c'.repeat(64);
  assert.throws(() => convert(repackage(bundleDrift)), /bundle|compiler/i);
  assert.throws(() => convert(replaceLocalFile(fixed.packageBytes, 'source.md', Buffer.from('changed source\n'))), /source|inventory|hash/i);
  assert.throws(() => convert(replaceLocalFile(fixed.packageBytes, 'labels.json', Buffer.from('{"other":"drift"}'))), /labels|inventory|hash/i);
  assert.throws(() => convert(replaceLocalFile(fixed.packageBytes, 'assets/katex.min.css', Buffer.from('body{}'))), /inventory|resource|hash/i);
});

test('rejects extra package files and unapproved or mismapped PNG snapshots', () => {
  const { fixed, approval } = fixture();
  const envelope = JSON.parse(fixed.packageBytes.toString('utf8'));
  envelope.files['unexpected.bin'] = Buffer.from('extra').toString('base64');
  assert.throws(() => convert(repackage(envelope), approval), /file|inventory|package/i);
  assert.throws(() => convert(fixed.packageBytes), /asset|approval|snapshot/i);
  assert.throws(() => convert(fixed.packageBytes, {
    '媒体/图.png': { mime: 'image/png', sha256: '0'.repeat(64) },
  }), /asset|approval|snapshot|mapping/i);
});

test('rejects resources over 2 MB and packages over the 16 MB aggregate budget', () => {
  const oneLargeFont = makeFixed({ source: '正文\n', labels: {}, approvedAssets: {}, assets: {}, resources: {
    'assets/katex.min.css': Buffer.from('@font-face{src:url("fonts/KaTeX_Large.woff2")}'),
    'assets/fonts/KaTeX_Large.woff2': fontBytes(2 * 1024 * 1024 + 1),
  } });
  assert.throws(() => convert(oneLargeFont.packageBytes, {}), /resource|size|limit/i);

  const names = Array.from({ length: 9 }, (_unused, index) => `KaTeX_Font${index}.woff2`);
  const css = Buffer.from(names.map(name => `@font-face{src:url("fonts/${name}")}`).join('\n'));
  const resources = { 'assets/katex.min.css': css };
  for (const name of names) resources[`assets/fonts/${name}`] = fontBytes(1900000);
  const overAggregate = makeFixed({ source: '正文\n', labels: {}, approvedAssets: {}, assets: {}, resources });
  assert.throws(() => convert(overAggregate.packageBytes, {}), /total|aggregate|limit|size|package/i);
});

test('rejects NUL in CSS even when the local input builder accepted it', () => {
  const fixed = makeFixed({ source: '正文\n', labels: {}, approvedAssets: {}, assets: {}, resources: {
    'assets/katex.min.css': Buffer.from('body{color:red}\x00'),
  } });
  assert.throws(() => convert(fixed.packageBytes, {}), /invalid_package_css/);
});

test('rejects rendered body above the server 65,536-byte cap', () => {
  const longSource = '**x**\n\n'.repeat(9000);
  const fixed = makeFixed({ source: longSource, labels: {}, approvedAssets: {}, assets: {} });
  assert.throws(() => convert(fixed.packageBytes, {}), /body|preview|size|limit/i);
});
