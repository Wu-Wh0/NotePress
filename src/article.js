'use strict';

const MarkdownIt = require('markdown-it');
const katex = require('katex');

const MAX_SOURCE_BYTES = 256 * 1024;
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i;

function normalizeTarget(target) {
  const value = target.trim();
  if (/^https?:\/\//i.test(value)) {
    let url;
    try { url = new URL(value); } catch { throw new Error('invalid_image_reference'); }
    if (!url.hostname || url.username || url.password) throw new Error('invalid_image_reference');
    return { sourcePath: value, kind: 'remote' };
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) throw new Error('unsafe_image_reference');
  let sourcePath;
  try { sourcePath = decodeURIComponent(value); } catch { throw new Error('invalid_image_reference'); }
  if (!sourcePath || /[\u0000-\u001f\u007f]/.test(sourcePath)) throw new Error('invalid_image_reference');
  return { sourcePath, kind: 'local' };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function renderImageToken(tokens, index) {
  const token = tokens[index];
  const width = Number.isInteger(token.meta?.width) && token.meta.width > 0 && token.meta.width <= 4096
    ? ` width="${token.meta.width}"` : '';
  const height = Number.isInteger(token.meta?.height) && token.meta.height > 0 && token.meta.height <= 4096
    ? ` height="${token.meta.height}"` : '';
  return `<img src="${escapeHtml(token.attrGet('src') || '')}" alt="${escapeHtml(token.content || '')}"${width}${height}>`;
}

function createMarkdown(mathOutput = 'htmlAndMathml') {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false, maxNesting: 20 });
  md.validateLink = () => true;
  md.renderer.rules.image = renderImageToken;
  md.renderer.rules.article_image = renderImageToken;
  let mathCount = 0;
  let mathBytes = 0;
  const renderMath = (source, display) => {
    const blockedCommands = ['href', 'url', 'html', 'includegraphics', 'def', 'gdef', 'newcommand', 'require'];
    const hasBlockedCommand = blockedCommands.some(command => source.includes(String.fromCharCode(92) + command));
    if (source.length > 10000 || mathCount >= 64 || source.includes('%') || hasBlockedCommand) throw new Error('unsupported_math');
    let rendered = katex.renderToString(source, {
      displayMode: display, output: mathOutput, throwOnError: true, trust: false, strict: 'error', maxExpand: 1000,
    });
    // HTML parsing assigns <math> its namespace; WordPress strips redundant xmlns.
    // Remove it only from generated MathML, never normalize a remote readback.
    if (mathOutput === 'mathml') rendered = rendered.replace(' xmlns="http://www.w3.org/1998/Math/MathML"', '');
    mathCount += 1;
    mathBytes += Buffer.byteLength(rendered, 'utf8');
    if (rendered.includes('katex-error') || mathBytes > 500000) throw new Error('math_render_failed');
    return rendered;
  };

  md.inline.ruler.before('escape', 'article_inline_math', (state, silent) => {
    if (state.src[state.pos] !== '$' || state.src[state.pos + 1] === '$') return false;
    const end = state.src.indexOf('$', state.pos + 1);
    if (end <= state.pos + 1) return false;
    if (!silent) {
      const token = state.push('article_inline_math', '', 0);
      token.content = state.src.slice(state.pos + 1, end);
    }
    state.pos = end + 1;
    return true;
  });
  md.renderer.rules.article_inline_math = (tokens, index) => renderMath(tokens[index].content, false);

  md.block.ruler.before('fence', 'article_display_math', (state, start, end, silent) => {
    const line = number => state.src.slice(state.bMarks[number] + state.tShift[number], state.eMarks[number]).trim();
    if (line(start) !== '$$') return false;
    let close = start + 1;
    while (close < end && line(close) !== '$$') close += 1;
    if (close >= end) throw new Error('unclosed_display_math');
    if (silent) return true;
    const token = state.push('article_display_math', 'div', 0);
    token.block = true;
    token.content = Array.from({ length: close - start - 1 }, (_unused, offset) => line(start + offset + 1)).join('\n');
    state.line = close + 1;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.renderer.rules.article_display_math = (tokens, index) => `<div class="math-scroll">${renderMath(tokens[index].content, true)}</div>\n`;

  md.inline.ruler.before('image', 'article_embed', (state, silent) => {
    if (!state.src.startsWith('![[', state.pos)) return false;
    const end = state.src.indexOf(']]', state.pos + 3);
    if (end < 0) throw new Error('unclosed_embed');
    const raw = state.src.slice(state.pos + 3, end);
    const pipe = raw.indexOf('|');
    const target = (pipe < 0 ? raw : raw.slice(0, pipe)).trim();
    const option = pipe < 0 ? '' : raw.slice(pipe + 1).trim();
    if (!silent) {
      const token = state.push(IMAGE_EXTENSION.test(target) ? 'article_image' : 'article_note_embed', 'img', 0);
      token.meta = { target, option };
      if (token.type === 'article_image') {
        const normalized = normalizeTarget(target);
        token.attrSet('src', normalized.sourcePath);
        token.content = option && !/^\d+(?:x\d+)?$/i.test(option) ? option : '';
        const dimensions = option.match(/^(\d+)(?:x(\d+))?$/i);
        token.meta = { ...token.meta, ...normalized, alt: token.content, width: dimensions ? Number(dimensions[1]) : undefined,
          height: dimensions && dimensions[2] ? Number(dimensions[2]) : undefined };
      }
    }
    state.pos = end + 2;
    return true;
  });

  md.inline.ruler.before('link', 'article_wikilink', (state, silent) => {
    if (state.src.slice(state.pos, state.pos + 2) !== '[[') return false;
    const end = state.src.indexOf(']]', state.pos + 2);
    if (end < 0) throw new Error('unclosed_wikilink');
    const raw = state.src.slice(state.pos + 2, end);
    const pipe = raw.indexOf('|');
    const target = (pipe < 0 ? raw : raw.slice(0, pipe)).trim();
    const display = pipe < 0 ? target.split('/').at(-1).replace(/\.[^.]+$/, '') : raw.slice(pipe + 1).trim();
    if (!silent) {
      const token = state.push('article_wikilink', '', 0);
      token.content = display;
    }
    state.pos = end + 2;
    return true;
  });

  md.renderer.rules.article_wikilink = (tokens, index) => `<span class="wiki-link-text">${md.utils.escapeHtml(tokens[index].content)}</span>`;
  return md;
}

function plainInlineText(tokens) {
  return tokens.map(token => {
    if (token.type === 'article_wikilink') return token.content;
    if (token.type === 'image' || token.type === 'article_image') return token.content || token.meta?.alt || '';
    if (token.type === 'softbreak' || token.type === 'hardbreak') return ' ';
    return token.content || '';
  }).join('').trim();
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function safeAssetUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\\]/.test(value)) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol === 'blob:') return true;
  return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
}

function safeLinkUrl(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\\]/.test(value)) return false;
  if (value.startsWith('#')) return true;
  let url;
  try { url = new URL(value); } catch { return false; }
  return ['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password;
}

function inspectContent(parsed) {
  const issues = [];
  const rawHtml = /<\/?[a-z][^>]*>|<!--[\s\S]*?-->|<!doctype\b/i;
  const dynamicInline = /(?:^|\s)=\s*(?:this\.|dv\.|date\(|dur\(|choice\(|link\()/i;
  for (const block of parsed.tokens) {
    if (block.type === 'html_block' || block.type === 'html_inline') issues.push({ code: 'raw_html' });
    if (block.type === 'fence' && /^(?:dataview(?:js)?|query|tasks)\b/i.test(block.info.trim())) issues.push({ code: 'dynamic_content' });
    if (block.type !== 'inline') continue;
    for (const token of block.children || []) {
      if (token.type === 'link_open' && !safeLinkUrl(token.attrGet('href'))) issues.push({ code: 'unsafe_link' });
      if (token.type === 'text' && rawHtml.test(token.content)) issues.push({ code: 'raw_html' });
      if (token.type === 'text' && dynamicInline.test(token.content)) issues.push({ code: 'dynamic_content' });
      if (token.type === 'code_inline' && /^\$?=\s*\S/.test(token.content.trim())) issues.push({ code: 'dynamic_content' });
    }
  }
  return issues;
}

function renderArticle({ source, title, assetUrls = {} } = {}) {
  if (typeof title !== 'string' || !title.trim() || title.length > 200 || /[\u0000-\u001f\u007f]/.test(title)) throw new Error('invalid_title');
  if (!plainObject(assetUrls)) throw new Error('invalid_asset_urls');
  let parsed;
  try {
    parsed = parseArticle(source);
  } catch (error) {
    return { html: '', headings: [], conversions: [], references: [], blocked: true, issues: [{ code: error.message || 'unsupported_article' }] };
  }
  const contentIssues = inspectContent(parsed);
  if (contentIssues.length) return { html: '', headings: [], conversions: [], references: parsed.references, blocked: true, issues: contentIssues };
  const issues = [];
  for (const reference of parsed.references) {
    if (!Object.hasOwn(assetUrls, reference.sourcePath)) issues.push({ code: 'missing_asset' });
    else if (!safeAssetUrl(assetUrls[reference.sourcePath])) issues.push({ code: 'invalid_asset_url' });
  }
  if (issues.length) return { html: '', headings: [], conversions: [], references: parsed.references, blocked: true, issues };
  for (const block of parsed.tokens) {
    if (block.type !== 'inline') continue;
    for (const token of block.children || []) {
      if (!['image', 'article_image'].includes(token.type)) continue;
      const sourcePath = token.meta?.sourcePath || normalizeTarget(token.attrGet('src') || '').sourcePath;
      token.attrSet('src', assetUrls[sourcePath]);
      if (token.type === 'image' && token.attrs) token.attrs = token.attrs.filter(([name]) => name !== 'title');
    }
  }
  const headings = [];
  const conversions = [];
  for (let index = 0; index < parsed.tokens.length; index += 1) {
    const token = parsed.tokens[index];
    if (token.type === 'heading_open') {
      const inline = parsed.tokens[index + 1];
      headings.push({ level: Number(token.tag.slice(1)), text: plainInlineText(inline?.children || []) });
    }
    if (token.type === 'inline') {
      for (const child of token.children || []) {
        if (child.type === 'article_wikilink') conversions.push({ type: 'wikilink', display: child.content });
      }
    }
  }
  const safeTitle = escapeHtml(title.trim());
  let body;
  let publicationBody;
  try {
    body = parsed.md.renderer.render(parsed.tokens, parsed.md.options, {});
    const publication = createMarkdown('mathml');
    publicationBody = publication.renderer.render(parsed.tokens, publication.options, {});
  } catch {
    return { html: '', headings: [], conversions: [], references: parsed.references, blocked: true, issues: [{ code: 'render_failed' }] };
  }
  const html = `<article><h1 class="article-title">${safeTitle}</h1>${body}</article>`;
  if (Buffer.byteLength(html, 'utf8') > 1024 * 1024 || Buffer.byteLength(publicationBody, 'utf8') > 1024 * 1024) {
    return { html: '', headings: [], conversions: [], references: parsed.references, blocked: true, issues: [{ code: 'render_output_limit' }] };
  }
  return { html, bodyHtml: publicationBody, headings, conversions, references: parsed.references, blocked: false, issues: [] };
}

function withoutFrontmatter(source) {
  // Obsidian note properties are not publication body or image references.
  // Do not parse, return, render or upload their values.
  const lines = source.split(/\r?\n/);
  if (!/^\uFEFF?---[ \t]*$/.test(lines[0])) return source;
  const close = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line));
  if (close < 0) throw new Error('unclosed_frontmatter');
  return lines.slice(close + 1).join('\n');
}

function parseArticle(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) throw new Error('invalid_or_oversized_source');
  const md = createMarkdown();
  const tokens = md.parse(withoutFrontmatter(source), {});
  const references = [];
  const seen = new Set();
  for (const block of tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    for (const token of block.children) {
      // Obsidian hides comments; do not publish their text or read their attachments.
      // Keep literal comment delimiters in code samples unchanged.
      if (['text', 'image', 'article_image', 'article_wikilink'].includes(token.type)
          && token.content.includes('%%')) throw new Error('unsupported_hidden_comment');
      if (token.type === 'article_note_embed') throw new Error('unsupported_note_embed');
      if (!['image', 'article_image'].includes(token.type)) continue;
      const details = token.meta?.sourcePath ? token.meta : normalizeTarget(token.attrGet('src') || '');
      const sourcePath = details.sourcePath || normalizeTarget(token.attrGet('src') || '').sourcePath;
      if (seen.has(sourcePath)) continue;
      seen.add(sourcePath);
      const alt = token.type === 'article_image' ? (token.meta.alt || '') : token.content || '';
      const reference = { sourcePath, alt, kind: details.kind };
      if (details.width) reference.width = details.width;
      references.push(reference);
    }
  }
  return { md, tokens, references };
}

function extractImageReferences(source) {
  return parseArticle(source).references;
}

module.exports = { extractImageReferences, renderArticle };
