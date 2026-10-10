const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { readApprovedPng, readSelectedNote } = require('../desktop/core');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const body = Buffer.concat([name, data]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, checksum]);
}
function pixel() {
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 1, 2, 3, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

test('approved PNG reads are rooted at the selected note and reject traversal and hardlinks', () => {
  const scratch = process.env.TMPDIR || 'E:/Hermes/cache/scratch';
  const temp = fs.mkdtempSync(path.join(scratch, 'desktop-assets-'));
  try {
    const root = path.join(temp, '库');
    const noteDir = path.join(root, '文章', '子目录');
    const mediaDir = path.join(noteDir, '媒体');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(noteDir, '第一篇.md'), '# 选中');
    const bytes = pixel();
    fs.writeFileSync(path.join(mediaDir, '图.png'), bytes);
    const read = readApprovedPng(root, '文章/子目录/第一篇.md', '媒体/图.png');
    assert.deepEqual(read.bytes, bytes);
    assert.equal(read.mime, 'image/png');
    assert.throws(() => readApprovedPng(root, '文章/子目录/第一篇.md', '../逃逸.png'), /invalid_asset_path/);

    fs.linkSync(path.join(mediaDir, '图.png'), path.join(mediaDir, '硬链接.png'));
    assert.throws(() => readApprovedPng(root, '文章/子目录/第一篇.md', '媒体/硬链接.png'), /unsupported_asset_file/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('saved-note reader performs a bounded rooted read and rejects multiply-linked notes', () => {
  const scratch = process.env.TMPDIR || 'E:/Hermes/cache/scratch';
  const temp = fs.mkdtempSync(path.join(scratch, 'desktop-notes-'));
  try {
    const root = path.join(temp, '库');
    fs.mkdirSync(root);
    const note = path.join(root, '第一篇.md');
    const source = '# 中文标题\\n正文。\\n';
    fs.writeFileSync(note, source, 'utf8');
    assert.equal(readSelectedNote(root, '第一篇.md'), source);
    fs.linkSync(note, path.join(root, 'hardlink.md'));
    assert.throws(() => readSelectedNote(root, 'hardlink.md'), /unsupported_source_file/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
