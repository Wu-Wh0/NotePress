const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { createFixedInputPackage } = require('../desktop/core');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}
function pixel() {
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 9, 8, 7, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

test('fixed input accepts ordinary ASCII paths and titles while rejecting control bytes', () => {
  const input = {
    path: 'notes/example01.md', source: 'Plain body\n', title: 'First text: example 07',
    labels: { reference: 'Example' }, approvedAssets: {}, assets: {},
    resources: { 'assets/katex.min.css': Buffer.from('body{}') }, compilerSha256: 'a'.repeat(64),
  };
  assert.equal(JSON.parse(createFixedInputPackage(input).manifestBytes).selected, input.path);
  assert.throws(() => createFixedInputPackage({ ...input, path: 'notes/\u0001.md' }), /invalid_selected_path/);
  assert.throws(() => createFixedInputPackage({ ...input, title: 'bad\nTitle' }), /invalid_title/);
});

test('fixed input bytes bind the saved source, title, labels, approved PNG, compiler and canonical inventory', () => {
  const image = pixel();
  const imageHash = crypto.createHash('sha256').update(image).digest('hex');
  const compilerSha256 = 'a'.repeat(64);
  const result = createFixedInputPackage({
    path: '文章/子目录/第一篇.md',
    source: '# 本文\n\n正文。\n',
    title: '独立标题',
    labels: { target: '目标' },
    approvedAssets: { '媒体/图.png': { sha256: imageHash, mime: 'image/png' } },
    assets: { '媒体/图.png': image },
    resources: {
      'assets/katex.min.css': Buffer.from('@font-face{src:url("fonts/KaTeX_Main-Regular.woff2")}'),
      'assets/fonts/KaTeX_Main-Regular.woff2': Buffer.from('font-bytes'),
    },
    compilerSha256,
  });
  const envelope = JSON.parse(result.packageBytes.toString('utf8'));
  const manifest = envelope.manifest;
  assert.equal(manifest.selected, '文章/子目录/第一篇.md');
  assert.equal(manifest.title, '独立标题');
  assert.equal(manifest.source_sha256, crypto.createHash('sha256').update('# 本文\n\n正文。\n').digest('hex'));
  assert.equal(manifest.labels_sha256, crypto.createHash('sha256').update('{"target":"目标"}').digest('hex'));
  assert.equal(manifest.compiler.bundle_sha256, compilerSha256);
  assert.equal(manifest.inventory_sha256, crypto.createHash('sha256').update(result.inventoryBytes).digest('hex'));
  assert.deepEqual([...Object.keys(manifest.inventory)], [...Object.keys(manifest.inventory).sort()]);
  assert.equal(envelope.files['assets/images/' + imageHash + '.png'], image.toString('base64'));
  assert.equal(result.packageSha256, crypto.createHash('sha256').update(result.packageBytes).digest('hex'));
  assert.equal(result.packageBytes.toString('utf8'), JSON.stringify(envelope));
});
