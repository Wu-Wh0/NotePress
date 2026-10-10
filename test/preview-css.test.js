'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readPreviewCss, MAX_CSS_BYTES } = require('../src/preview-css');

test('filesystem CSS rejects linked folders before reading outside the Vault', async () => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const os = require('node:os');
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'preview-css-'));
  try {
    const vault = path.join(root, 'vault');
    const outside = path.join(root, 'outside');
    await fs.mkdir(vault); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'blog.css'), 'body{color:red}');
    await fs.symlink(outside, path.join(vault, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    let reads = 0;
    const adapter = {
      getBasePath: () => vault,
      stat: async () => ({ type: 'file', size: 15 }),
      read: async p => { reads++; return fs.readFile(path.join(vault, p), 'utf8'); },
    };
    assert.equal((await readPreviewCss(adapter, 'linked/blog.css')).css, '');
    assert.equal(reads, 0);
    await fs.writeFile(path.join(vault, 'blog.css'), 'body{color:blue}');
    assert.equal((await readPreviewCss(adapter, 'blog.css')).css, 'body{color:blue}');
    assert.equal(reads, 1);
    assert.equal(await fs.readFile(path.join(outside, 'blog.css'), 'utf8'), 'body{color:red}');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('CSS path rejects absolute, scheme, traversal, controls and non-CSS before host access', async () => {
  let calls = 0;
  const adapter = { stat: async () => { calls++; }, read: async () => { calls++; } };
  for (const path of ['/a.css', 'C:/a.css', '\\\\host\\a.css', 'https://host/a.css', '../a.css', 'x/../a.css', 'a\n.css', 'a.txt', 'a.css:stream', 'a%2f.css', 'x//a.css', '.obsidian/blog.css', 'styles/.private.css']) {
    const result = await readPreviewCss(adapter, path);
    assert.equal(result.css, '', path);
    assert.match(result.message, /CSS/, path);
  }
  assert.equal(calls, 0);
  assert.deepEqual(await readPreviewCss(adapter, ''), { css: '', message: '' });
});

test('CSS missing, directory and oversized metadata never trigger content reads', async () => {
  let reads = 0;
  for (const stat of [null, { type: 'folder', size: 1 }, { type: 'file', size: MAX_CSS_BYTES + 1 }, { type: 'file', size: -1 }]) {
    const result = await readPreviewCss({ stat: async () => stat, read: async () => { reads++; } }, 'a.css');
    assert.equal(result.css, '');
    assert.match(result.message, /CSS/);
  }
  assert.equal(reads, 0);
});

test('CSS enforces actual UTF-8 bytes after read and accepts an explicit Vault path at limit', async () => {
  const paths = [];
  let content = 'a'.repeat(MAX_CSS_BYTES);
  const adapter = { stat: async p => { paths.push(p); return { type: 'file', size: MAX_CSS_BYTES }; }, read: async p => { paths.push(p); return content; } };
  assert.equal((await readPreviewCss(adapter, 'styles/blog.css')).css, content);
  assert.deepEqual(paths, ['styles/blog.css', 'styles/blog.css']);
  content += 'a';
  assert.equal((await readPreviewCss(adapter, 'a.css')).css, '');
  content = '中'.repeat(MAX_CSS_BYTES / 2);
  assert.match((await readPreviewCss(adapter, 'a.css')).message, /CSS/);
  content = 'a{color:red}';
  assert.deepEqual(await readPreviewCss(adapter, 'a.css'), { css: content, message: '' });
});

test('CSS resource and style injection failures provide actionable fallback', async () => {
  for (const css of ['@import "a.css";', 'a{background:url(data:image/png;base64,AA)}', 'a{background:u\\72l(https://evil.test)}', '</StYlE><script>x</script>', '@im/**/port "a.css";', 'a{background:image-set("https://evil.test" 1x)}']) {
    const result = await readPreviewCss({ stat: async () => ({ type: 'file', size: 100 }), read: async () => css }, 'a.css');
    assert.equal(result.css, '');
    assert.match(result.message, /内置样式/);
  }
});
