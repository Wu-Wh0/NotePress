'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractImageReferences } = require('../src/article');

test('collects only unique Markdown and Obsidian images outside code', () => {
  const source = [
    '![封面](assets/%E5%9B%BE%20%E4%B8%80.png)',
    '![[assets/图 一.png|正文图片]]',
    '![远程](https://example.test/photo.png)',
    '`![代码](hidden.png)`',
    '```md',
    '![代码块](hidden-too.png)',
    '```',
  ].join('\n');

  assert.deepEqual(extractImageReferences(source), [
    { sourcePath: 'assets/图 一.png', alt: '封面', kind: 'local' },
    { sourcePath: 'https://example.test/photo.png', alt: '远程', kind: 'remote' },
  ]);
});

test('renders only wiki-link display text without exposing its target', () => {
  const result = require('../src/article').renderArticle({
    source: '[[Private/秘密笔记.md|公开显示]]',
    title: '中文文章',
  });

  assert.equal(result.blocked, false);
  assert.match(result.html, /公开显示/);
  assert.doesNotMatch(result.html, /Private|秘密笔记/);
  assert.deepEqual(result.conversions, [{ type: 'wikilink', display: '公开显示' }]);
});

test('blocks an article whose referenced image has no explicit asset URL', () => {
  const result = require('../src/article').renderArticle({
    source: '![未解析](私人附件/图片.png)',
    title: '文章',
  });

  assert.equal(result.blocked, true);
  assert.equal(result.html, '');
  assert.equal(result.issues.some(issue => issue.code === 'missing_asset'), true);
});

test('renders mapped local images, escaped alt/title, and Obsidian image widths', () => {
  const result = require('../src/article').renderArticle({
    source: '![<封面>](images/cover.png)\n\n![[附图/详情.png|320]]',
    title: '<文章标题>',
    assetUrls: {
      'images/cover.png': 'blob:https://obsidian.local/cover',
      '附图/详情.png': 'blob:https://obsidian.local/detail',
    },
  });

  assert.equal(result.blocked, false);
  assert.match(result.html, /src="blob:https:\/\/obsidian\.local\/cover"/);
  assert.match(result.html, /alt="&lt;封面&gt;"/);
  assert.match(result.html, /src="blob:https:\/\/obsidian\.local\/detail" alt="" width="320"/);
  assert.match(result.html, /&lt;文章标题&gt;/);
  assert.doesNotMatch(result.html, /images\/cover\.png|附图\/详情\.png/);
});

test('blocks raw HTML and script content rather than rendering it', () => {
  for (const source of ['<div onclick="alert(1)">正文</div>', '<script>alert(1)</script>']) {
    const result = require('../src/article').renderArticle({ source, title: '文章' });
    assert.equal(result.blocked, true);
    assert.equal(result.html, '');
    assert.equal(result.issues.some(issue => issue.code === 'raw_html'), true);
  }
});

test('blocks Markdown links with dangerous schemes', () => {
  const result = require('../src/article').renderArticle({
    source: '[点我](javascript:alert(1))',
    title: '文章',
  });

  assert.equal(result.blocked, true);
  assert.equal(result.html, '');
  assert.equal(result.issues.some(issue => issue.code === 'unsafe_link'), true);
});

test('renders Chinese headings, tables, and inline/block math with the installed engines', () => {
  const result = require('../src/article').renderArticle({
    source: '# 中文章节\n\n| 名称 | 值 |\n| --- | --- |\n| 面积 | $x^2$ |\n\n$$\n\\int_0^1 x\\,dx = \\frac12\n$$',
    title: '数学文章',
  });

  assert.equal(result.blocked, false);
  assert.deepEqual(result.headings, [{ level: 1, text: '中文章节' }]);
  assert.match(result.html, /<table>/);
  assert.match(result.html, /class="katex/);
});

test('fails closed on invalid math without returning a partial article', () => {
  const result = require('../src/article').renderArticle({ source: '公式：$\\unknowncommand$', title: '文章' });

  assert.equal(result.blocked, true);
  assert.equal(result.html, '');
  assert.equal(result.issues.some(issue => issue.code === 'render_failed'), true);
});

test('blocks inline Dataview expressions instead of publishing their source code', () => {
  const result = require('../src/article').renderArticle({
    source: '作者: = this.file.name',
    title: '动态内容',
  });

  assert.equal(result.blocked, true);
  assert.equal(result.html, '');
  assert.equal(result.issues.some(issue => issue.code === 'dynamic_content'), true);
});

test('blocks non-image note embeds without exposing their target', () => {
  const source = '![[Private/未发布笔记.md]]';
  const result = require('../src/article').renderArticle({ source, title: '文章' });

  assert.equal(result.blocked, true);
  assert.equal(result.html, '');
  assert.equal(result.issues.some(issue => issue.code === 'unsupported_note_embed'), true);
  assert.doesNotMatch(JSON.stringify(result), /Private|未发布笔记/);
  assert.throws(() => extractImageReferences(source), { message: 'unsupported_note_embed' });
});

test('omits frontmatter metadata and its image-like values from published content', () => {
  const source = '---\nprivate: INTERNAL_ONLY\nbanner: "![[Private/secret.png]]"\n---\n\n正文\n\n![[visible.png]]';
  assert.deepEqual(extractImageReferences(source), [{ sourcePath: 'visible.png', alt: '', kind: 'local' }]);
  const result = require('../src/article').renderArticle({ source, title: '文章', assetUrls: { 'visible.png': 'blob:https://obsidian.local/visible' } });
  assert.equal(result.blocked, false);
  assert.match(result.html, /正文/);
  assert.doesNotMatch(result.html, /INTERNAL_ONLY|Private|secret\.png|banner:/);
});

test('fails closed on unterminated frontmatter instead of exposing metadata', () => {
  const source = '---\nprivate: INTERNAL_ONLY\n';
  assert.throws(() => extractImageReferences(source), { message: 'unclosed_frontmatter' });
  const result = require('../src/article').renderArticle({ source, title: '文章' });
  assert.equal(result.blocked, true);
  assert.equal(result.html, '');
});

test('blocks actual Dataview inline-code expressions, including JavaScript expressions', () => {
  for (const source of ['作者: `= this.file.name`', '`$=dv.current().private`', '`= 1 + 1`']) {
    const result = require('../src/article').renderArticle({ source, title: '文章' });
    assert.equal(result.blocked, true);
    assert.equal(result.html, '');
    assert.equal(result.issues.some(issue => issue.code === 'dynamic_content'), true);
  }
});

test('provides publication body separately from preview wrapper and title', () => {
  const result = require('../src/article').renderArticle({ source: '正文', title: '标题只用于预览' });
  assert.equal(result.blocked, false);
  assert.equal(result.bodyHtml, '<p>正文</p>\n');
  assert.match(result.html, /article-title/);
  assert.doesNotMatch(result.bodyHtml, /标题只用于预览|article-title|<article>/);
});
