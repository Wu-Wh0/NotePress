const test = require('node:test');
const assert = require('node:assert/strict');
const { renderDocument, validatePng } = require('../desktop/core');
const zlib = require('node:zlib');

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const body = Buffer.concat([name, data]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  let value = 0xffffffff;
  for (const byte of body) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  crc.writeUInt32BE((value ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, body, crc]);
}

function onePixelPng() {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 18, 52, 86, 255]))), pngChunk('IEND', Buffer.alloc(0))]);
}

test('offline renderer keeps a standalone title separate from a nested Chinese note heading and renders math', () => {
  const html = renderDocument({
    text: '# 笔记标题\n\n中文段落与 [安全链接](https://example.org/a)。行内公式 $x^2$。\n\n$$\n\\frac{a}{b}\n$$\n',
    title: '独立预览标题',
  });
  assert.match(html, /<title>独立预览标题<\/title>/);
  assert.match(html, /<h1>笔记标题<\/h1>/);
  assert.match(html, /https:\/\/example\.org\/a/);
  assert.match(html, /katex/);
  assert.match(html, /\u4e2d\u6587/);
  assert.match(html, /sandbox|Content-Security-Policy/);
});

test('PNG approval validates the actual chunk CRC and decoded pixel stream', () => {
  const valid = onePixelPng();
  assert.doesNotThrow(() => validatePng(valid));
  const corrupt = Buffer.from(valid);
  corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => validatePng(corrupt), /invalid_png_crc/);
});
