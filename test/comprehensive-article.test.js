'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { renderArticle, extractImageReferences } = require('../src/article');

const fixtureDir = path.join(__dirname, 'fixtures');
const source = fs.readFileSync(path.join(fixtureDir, 'comprehensive-article.md'), 'utf8');
const blockedCases = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'blocked-articles.json'), 'utf8'));
const imagePath = 'synthetic-grid.png';
const imageUrl = 'blob:https://obsidian.local/synthetic-grid';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test('synthetic grid is a complete, decodable 16 by 16 RGB PNG', () => {
  const bytes = fs.readFileSync(path.join(fixtureDir, imagePath));
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(bytes.length <= 1024, 'fixture stays bounded');
  const chunks = [];
  let offset = 8;
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length, 'complete chunk header');
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    assert.ok(end <= bytes.length, 'complete chunk data');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    assert.equal(bytes.readUInt32BE(end - 4), crc32(bytes.subarray(offset + 4, end - 4)), `${type} CRC`);
    chunks.push({ type, data: bytes.subarray(offset + 8, end - 4) });
    offset = end;
  }
  assert.equal(offset, bytes.length);
  assert.deepEqual(chunks.map(chunk => chunk.type), ['IHDR', 'IDAT', 'IEND']);
  assert.equal(chunks[0].data.readUInt32BE(0), 16);
  assert.equal(chunks[0].data.readUInt32BE(4), 16);
  assert.deepEqual([...chunks[0].data.subarray(8)], [8, 2, 0, 0, 0]);
  const pixels = zlib.inflateSync(chunks[1].data);
  assert.equal(pixels.length, 16 * (1 + 16 * 3));
  for (let row = 0; row < 16; row += 1) assert.equal(pixels[row * 49], 0, 'unfiltered row');
  assert.notDeepEqual(pixels.subarray(1, 4), pixels.subarray(13, 16), 'grid has distinct colors');
  assert.equal(chunks[2].data.length, 0);
});

test('comprehensive synthetic article preserves supported content and maps one unique image', () => {
  assert.match(source, /# SIMULATED 综合测试文章/);
  assert.ok(Buffer.byteLength(source, 'utf8') < 16 * 1024);
  const references = extractImageReferences(source);
  assert.deepEqual(references, [{ sourcePath: imagePath, alt: '彩色网格', kind: 'local' }]);
  const result = renderArticle({ source, title: 'SIMULATED 综合测试文章', assetUrls: { [imagePath]: imageUrl } });
  assert.equal(result.blocked, false);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.references, references);
  assert.deepEqual(result.headings, [{ level: 1, text: 'SIMULATED 综合测试文章' }]);
  assert.deepEqual(result.conversions, [{ type: 'wikilink', display: '合成显示文字' }]);
  const body = result.bodyHtml;
  assert.match(body, /<strong>粗体<\/strong>.*<em>斜体<\/em>.*<s>删除线<\/s>/);
  assert.match(body, /English punctuation: commas, semicolons; 还有 emoji 🧪🌈/);
  assert.match(body, /价格为 \$12\.50，续费 \$30\.00；字面转义美元写作 \$45/);
  assert.match(body, /<a href="https:\/\/example\.test\/catalog\?price=%2412\.50">套餐 \$12\.50<\/a>/);
  assert.match(body, /<a href="https:\/\/example\.test\/math">公式 .*<math>/);
  assert.match(body, /<mfrac>/);
  assert.match(body, /<mtable\b/);
  assert.match(body, /<blockquote>/);
  assert.match(body, /<ol>/);
  assert.match(body, /<ul>/);
  assert.match(body, /\[x\] 已完成的合成任务/);
  assert.match(body, /<table>/);
  assert.match(body, /A \| B/);
  assert.match(body, /<code class="language-html">&lt;div data-price=&quot;\$12\.50&quot;&gt;SIMULATED&lt;\/div&gt;/);
  assert.match(body, /<code>&lt;span&gt;\$30\.00&lt;\/span&gt;<\/code>/);
  assert.match(body, /SIMULATED_GRID_ROW_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/);
  assert.match(body, /https:\/\/example\.test\/archive\/synthetic\/section\/abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.equal((body.match(/<img /g) || []).length, 2);
  assert.equal((body.match(/src="blob:https:\/\/obsidian\.local\/synthetic-grid"/g) || []).length, 2);
  assert.match(body, /width="320"/);
  assert.match(body, /合成显示文字/);
  assert.doesNotMatch(body, /Unopened-Target-7392|Synthetic\/|FRONTMATTER_ONLY_7842|not-a-body-image\.png|private_marker:/);
  assert.doesNotMatch(body, /src="synthetic-grid\.png"/);
});

test('independent blocked articles fail closed with their renderer issue', () => {
  assert.equal(blockedCases.length, 7);
  for (const { name, source: blockedSource, expectedIssue } of blockedCases) {
    const result = renderArticle({ source: blockedSource, title: `SIMULATED ${name}` });
    assert.equal(result.blocked, true, name);
    assert.equal(result.html, '', name);
    assert.equal(result.bodyHtml, undefined, name);
    assert.deepEqual(result.issues.map(issue => issue.code), [expectedIssue], name);
    if (expectedIssue === 'missing_asset') {
      assert.deepEqual(result.references, [{ sourcePath: 'missing-synthetic.png', alt: '缺图', kind: 'local' }]);
    }
    if (expectedIssue === 'unsupported_note_embed') {
      assert.throws(() => extractImageReferences(blockedSource), { message: 'unsupported_note_embed' });
      assert.doesNotMatch(JSON.stringify(result), /Unopened-Embed-7392/);
    }
  }
});
