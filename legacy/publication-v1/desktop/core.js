'use strict';

const MarkdownIt = require('markdown-it');
const katex = require('katex');

const MAX_SOURCE_BYTES = 65536;
const MAX_MATH_NODES = 64;
const MAX_MATH_BYTES = 500000;
const HEX64 = /^[a-f0-9]{64}$/;

function safeAssetPath(value) {
  if (typeof value !== 'string' || value.length > 1024 || !value.endsWith('.png')) return false;
  const blocked = [String.fromCharCode(92), '%', '#', '?'];
  return !blocked.some(char => value.includes(char))
    && ![...value].some(char => /\s/u.test(char) || /[\p{C}]/u.test(char))
    && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'));
}

function safeHttpUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\u0000-\u0020\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function renderMarkdown(text, { labels = {}, approvedAssets = {}, assetUrls = {} } = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES) throw new Error('note_too_large');
  if (!plainObject(labels) || !plainObject(approvedAssets) || !plainObject(assetUrls)) throw new Error('invalid_preview_input');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\u202a-\u202e\u2066-\u2069]/.test(text)) throw new Error('unsupported_control');
  if (/^\s*\[[^\]]+\]:/m.test(text)) throw new Error('unsupported_reference_definition');
  if (/^\s*\[\[/.test(text) || /!\[\[/.test(text)) throw new Error('unsupported_embed');
  if (text.trimStart().startsWith('---\n') || text.trimStart().startsWith('---\r\n')) throw new Error('unsupported_frontmatter');

  const md = new MarkdownIt({ html: false, linkify: false, typographer: false, maxNesting: 20 });
  md.validateLink = () => true;
  let mathCount = 0;
  let mathBytes = 0;
  const usedLabels = new Set();
  const usedAssets = new Set();
  const renderMath = (source, display) => {
    if (source.length > 10000 || mathCount >= MAX_MATH_NODES || /%|\\(?:href|url|html\w*|includegraphics|def|gdef|newcommand|require)\b/.test(source)) throw new Error('unsupported_math');
    const result = katex.renderToString(source, { displayMode: display, output: 'htmlAndMathml', throwOnError: true, trust: false, strict: 'error' })
      .replace(' xmlns="http://www.w3.org/1998/Math/MathML"', '')
      .replace(/\bstyle="([^"]*)"/g, (_match, style) => `style="${style.replace(/;$/, '')}"`);
    const size = Buffer.byteLength(result, 'utf8');
    if (result.includes('katex-error') || size > 200000 || mathBytes + size > MAX_MATH_BYTES) throw new Error('math_render_failed');
    mathCount += 1;
    mathBytes += size;
    return result;
  };

  md.inline.ruler.before('escape', 'approved_wiki', (state, silent) => {
    if (state.src.slice(state.pos, state.pos + 2) !== '[[') return false;
    if (state.pos > 0 && state.src[state.pos - 1] === '!') throw new Error('unsupported_embed');
    const end = state.src.indexOf(']]', state.pos + 2);
    if (end < 0) throw new Error('unclosed_wikilink');
    const key = state.src.slice(state.pos + 2, end);
    if (!Object.hasOwn(labels, key)) throw new Error('unapproved_wikilink');
    if (!silent) {
      const token = state.push('approved_wiki', '', 0);
      token.content = labels[key];
      usedLabels.add(key);
    }
    state.pos = end + 2;
    return true;
  });
  md.renderer.rules.approved_wiki = (tokens, index) => md.utils.escapeHtml(tokens[index].content);

  md.inline.ruler.before('escape', 'inline_math', (state, silent) => {
    if (state.src[state.pos] !== '$') return false;
    if (state.src[state.pos + 1] === '$') throw new Error('display_math_requires_own_lines');
    const end = state.src.indexOf('$', state.pos + 1);
    if (end < 0) throw new Error('unclosed_math');
    if (!silent) {
      const token = state.push('inline_math', '', 0);
      token.content = state.src.slice(state.pos + 1, end);
    }
    state.pos = end + 1;
    return true;
  });
  md.renderer.rules.inline_math = (tokens, index) => renderMath(tokens[index].content, false);
  md.block.ruler.before('fence', 'display_math', (state, start, end, silent) => {
    const line = number => state.src.slice(state.bMarks[number] + state.tShift[number], state.eMarks[number]);
    if (line(start).trim() !== '$$') return false;
    let cursor = start + 1;
    while (cursor < end && line(cursor).trim() !== '$$') cursor += 1;
    if (cursor === end) throw new Error('unclosed_display_math');
    if (silent) return true;
    const token = state.push('display_math', 'math', 0);
    token.block = true;
    token.content = Array.from({ length: cursor - start - 1 }, (_unused, index) => line(start + index + 1)).join('\n');
    state.line = cursor + 1;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.renderer.rules.display_math = (tokens, index) => `<div class="math-scroll">${renderMath(tokens[index].content, true)}</div>\n`;

  const tokens = md.parse(text, {});
  let tokenBudget = tokens.length;
  for (const token of tokens) if (token.type === 'inline') tokenBudget += token.children.length;
  if (tokenBudget > 10000) throw new Error('markdown_complexity_limit');
  const allowed = new Set(['heading_open', 'heading_close', 'paragraph_open', 'paragraph_close', 'inline', 'fence',
    'bullet_list_open', 'bullet_list_close', 'ordered_list_open', 'ordered_list_close', 'list_item_open', 'list_item_close',
    'blockquote_open', 'blockquote_close', 'hr', 'table_open', 'table_close', 'thead_open', 'thead_close', 'tbody_open',
    'tbody_close', 'tr_open', 'tr_close', 'th_open', 'th_close', 'td_open', 'td_close', 'display_math']);
  for (const token of tokens) {
    if (!allowed.has(token.type)) throw new Error(`unsupported_block_${token.type}`);
    if (token.type === 'fence' && !['', 'text'].includes(token.info.trim())) throw new Error(`unsupported_fence_${token.info}`);
    if (token.type !== 'inline') continue;
    for (const child of token.children) {
      if (!['text', 'softbreak', 'hardbreak', 'strong_open', 'strong_close', 'em_open', 'em_close', 'code_inline',
        's_open', 's_close', 'approved_wiki', 'inline_math', 'link_open', 'link_close', 'image'].includes(child.type)) {
        throw new Error(`unsupported_inline_${child.type}`);
      }
      if (child.type === 'link_open') {
        const href = child.attrGet('href');
        if (!safeHttpUrl(href)) throw new Error('unsafe_link_url');
        child.attrSet('rel', 'noopener noreferrer');
      }
      if (child.type === 'image') {
        let assetPath;
        try { assetPath = decodeURIComponent(child.attrGet('src')); } catch { throw new Error('invalid_image_path'); }
        const approval = approvedAssets[assetPath];
        if (!safeAssetPath(assetPath) || !approval || approval.mime !== 'image/png' || !HEX64.test(approval.sha256)
          || typeof assetUrls[assetPath] !== 'string' || !assetUrls[assetPath].startsWith('blob:')) throw new Error('unapproved_local_image');
        child.attrSet('src', assetUrls[assetPath]);
        if (child.attrs) child.attrs = child.attrs.filter(([name]) => name !== 'title');
        usedAssets.add(assetPath);
      }
      if (child.type === 'text' && (/<\/?[A-Za-z!]|%%|\^\S/.test(child.content))) throw new Error('unsupported_hidden_embed_or_raw_html');
    }
  }
  if (usedAssets.size !== Object.keys(approvedAssets).length) throw new Error('unused_asset_approval');
  if (usedLabels.size > Object.keys(labels).length) throw new Error('invalid_labels');
  const body = md.renderer.render(tokens, md.options, {});
  if (!body.trim()) throw new Error('empty_note');
  if (Buffer.byteLength(body, 'utf8') > 1000000) throw new Error('render_output_limit');
  return body;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePng(data) {
  const zlib = require('node:zlib');
  if (!Buffer.isBuffer(data) || data.length > 4 * 1024 * 1024 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('invalid_png');
  let offset = 8;
  let seenIhdr = false;
  let seenIdat = false;
  let seenIend = false;
  let idatEnded = false;
  let width;
  let height;
  let channels;
  const idat = [];
  while (offset < data.length) {
    if (data.length - offset < 12) throw new Error('invalid_png');
    const length = data.readUInt32BE(offset);
    offset += 4;
    const type = data.toString('ascii', offset, offset + 4);
    const kind = data.subarray(offset, offset + 4);
    offset += 4;
    if (length > 4 * 1024 * 1024 || offset + length + 4 > data.length) throw new Error('invalid_png');
    const chunk = data.subarray(offset, offset + length);
    offset += length;
    const actualCrc = data.readUInt32BE(offset);
    offset += 4;
    if (crc32(Buffer.concat([kind, chunk])) !== actualCrc) throw new Error('invalid_png_crc');
    if (type === 'IHDR') {
      if (seenIhdr || offset !== 8 + 4 + 4 + 13 + 4 || length !== 13) throw new Error('invalid_png');
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      const depth = chunk[8];
      const color = chunk[9];
      if (width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 4000000) throw new Error('png_dimensions_unsupported');
      if (depth !== 8 || ![2, 6].includes(color) || chunk[10] || chunk[11] || chunk[12]) throw new Error('png_format_unsupported');
      channels = color === 2 ? 3 : 4;
      seenIhdr = true;
    } else if (type === 'IDAT') {
      if (!seenIhdr || idatEnded || seenIend) throw new Error('invalid_png');
      seenIdat = true;
      idat.push(chunk);
    } else if (type === 'IEND') {
      if (!seenIdat || length !== 0 || seenIend) throw new Error('invalid_png');
      seenIend = true;
      if (offset !== data.length) throw new Error('invalid_png_trailing_data');
    } else {
      throw new Error('png_metadata_or_chunk_unsupported');
    }
    if (seenIdat && type !== 'IDAT' && type !== 'IEND') idatEnded = true;
    if (seenIend) break;
  }
  if (!(seenIhdr && seenIdat && seenIend) || offset !== data.length) throw new Error('invalid_png');
  const rowBytes = width * channels;
  const expected = height * (rowBytes + 1);
  if (expected > 16 * 1024 * 1024) throw new Error('png_decompressed_size_unsupported');
  let decoded;
  try {
    const compressed = Buffer.concat(idat);
    const result = zlib.inflateSync(compressed, { info: true, maxOutputLength: expected + 1 });
    decoded = result.buffer;
    if (result.engine.bytesWritten !== compressed.length) throw new Error('invalid_png_pixels');
  } catch (error) {
    if (error.message === 'invalid_png_pixels') throw error;
    throw new Error('invalid_png_pixels');
  }
  if (decoded.length !== expected) throw new Error('invalid_png_pixels');
  const stride = rowBytes + 1;
  for (let row = 0; row < height; row += 1) if (decoded[row * stride] > 4) throw new Error('invalid_png_filter');
  return { width, height };
}

function normalizeAbsolutePath(value, path) {
  return path.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
}

function checkedPathSegment(candidate, finalKind, fs) {
  let stat;
  try { stat = fs.lstatSync(candidate); } catch { throw new Error('selected_asset_unavailable_or_unsafe'); }
  if (stat.isSymbolicLink()) throw new Error('selected_asset_unavailable_or_unsafe');
  if (finalKind === 'directory' && !stat.isDirectory()) throw new Error('selected_asset_unavailable_or_unsafe');
  if (finalKind === 'file' && (!stat.isFile() || stat.nlink !== 1)) throw new Error('unsupported_asset_file');
  return stat;
}

function readApprovedPng(vaultRoot, selectedPath, relativePath) {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) throw new Error('invalid_vault_root');
  const validateRelative = (value, suffix) => typeof value === 'string' && value.length <= 1024 && value.endsWith(suffix)
    && !/[\\:\x00-\x1f\x7f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.') && part === part.normalize('NFC'));
  if (!validateRelative(selectedPath, '.md')) throw new Error('invalid_selected_path');
  if (!safeAssetPath(relativePath)) throw new Error('invalid_asset_path');
  const root = path.resolve(vaultRoot);
  const rootStat = checkedPathSegment(root, 'directory', fs);
  if (rootStat.isSymbolicLink() || normalizeAbsolutePath(fs.realpathSync(root), path) !== normalizeAbsolutePath(root, path)) throw new Error('selected_asset_unavailable_or_unsafe');
  const walk = (parts, finalKind) => {
    let current = root;
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]);
      checkedPathSegment(current, index === parts.length - 1 ? finalKind : 'directory', fs);
      const relative = path.relative(root, current);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('selected_asset_unavailable_or_unsafe');
    }
    return current;
  };
  const noteParts = selectedPath.split('/');
  const noteFile = walk(noteParts, 'file');
  if (fs.statSync(noteFile).size > MAX_SOURCE_BYTES) throw new Error('note_too_large');
  const imageParts = noteParts.slice(0, -1).concat(relativePath.split('/'));
  const target = walk(imageParts, 'file');
  if (!target.toLowerCase().endsWith('.png')) throw new Error('invalid_asset_path');
  const absolute = fs.realpathSync(target);
  if (normalizeAbsolutePath(absolute, path) !== normalizeAbsolutePath(target, path)) throw new Error('selected_asset_unavailable_or_unsafe');
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) throw new Error('unsupported_asset_file');
    if (before.size < 1 || before.size > 4 * 1024 * 1024) throw new Error('asset_too_large');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error('selected_asset_changed');
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== before.size || after.nlink !== 1 || after.ino !== before.ino || after.dev !== before.dev
      || normalizeAbsolutePath(fs.realpathSync(target), path) !== normalizeAbsolutePath(absolute, path)) throw new Error('selected_asset_changed');
    validatePng(bytes);
    return { path: relativePath, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), mime: 'image/png' };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readSelectedNote(vaultRoot, selectedPath) {
  const fs = require('node:fs');
  const path = require('node:path');
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) throw new Error('invalid_vault_root');
  const valid = typeof selectedPath === 'string' && selectedPath.length <= 1024 && selectedPath.endsWith('.md')
    && !selectedPath.includes(String.fromCharCode(92)) && !selectedPath.includes(':')
    && !selectedPath.includes('\\\\') && !selectedPath.includes(':')
    && ![...selectedPath].some(char => char.codePointAt(0) < 32 || char.codePointAt(0) === 127)
    && selectedPath.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.') && part === part.normalize('NFC'));
  if (!valid) throw new Error('invalid_selected_path');
  const root = path.resolve(vaultRoot);
  checkedPathSegment(root, 'directory', fs);
  if (normalizeAbsolutePath(fs.realpathSync(root), path) !== normalizeAbsolutePath(root, path)) throw new Error('selected_file_unavailable_or_unsafe');
  let target = root;
  const parts = selectedPath.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    target = path.join(target, parts[index]);
    let stat;
    try { stat = fs.lstatSync(target); } catch { throw new Error('selected_file_unavailable_or_unsafe'); }
    if (stat.isSymbolicLink()) throw new Error('selected_file_unavailable_or_unsafe');
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('selected_file_unavailable_or_unsafe');
    if (index === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1)) throw new Error('unsupported_source_file');
    const relative = path.relative(root, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('selected_file_unavailable_or_unsafe');
  }
  const actual = fs.realpathSync(target);
  if (normalizeAbsolutePath(actual, path) !== normalizeAbsolutePath(target, path)) throw new Error('selected_file_unavailable_or_unsafe');
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) throw new Error('unsupported_source_file');
    if (before.size > MAX_SOURCE_BYTES) throw new Error('note_too_large');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error('selected_file_changed');
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== before.size || after.nlink !== 1 || after.ino !== before.ino || after.dev !== before.dev
      || normalizeAbsolutePath(fs.realpathSync(target), path) !== normalizeAbsolutePath(actual, path)) throw new Error('selected_file_changed');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('invalid_source_encoding');
    return text;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function canonicalJson(value) {
  const sort = item => {
    if (Array.isArray(item)) return item.map(sort);
    if (!plainObject(item)) return item;
    const result = Object.create(null);
    for (const key of Object.keys(item).sort()) result[key] = sort(item[key]);
    return result;
  };
  return Buffer.from(JSON.stringify(sort(value)), 'utf8');
}

function sha256(data) {
  return require('node:crypto').createHash('sha256').update(data).digest('hex');
}

function createFixedInputPackage({ path: selected, source, title, labels = {}, approvedAssets = {}, assets = {}, resources, compilerSha256 }) {
  const validNote = typeof selected === 'string' && selected.length <= 1024 && selected.endsWith('.md')
    && !selected.includes(String.fromCharCode(92)) && !selected.includes(':')
    && !/[\\:\x00-\x1f\x7f]/.test(selected)
    && selected.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.') && part === part.normalize('NFC'));
  if (!validNote) throw new Error('invalid_selected_path');
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES || Buffer.from(source, 'utf8').toString('utf8') !== source) throw new Error('invalid_source');
  if (typeof title !== 'string' || !title.trim() || title.length > 200 || /[\x00-\x1f\x7f]/.test(title)) throw new Error('invalid_title');
  if (!plainObject(labels) || !plainObject(approvedAssets) || !plainObject(assets) || !plainObject(resources)
    || !HEX64.test(compilerSha256 || '')) throw new Error('invalid_fixed_input');
  for (const [key, value] of Object.entries(labels)) {
    if (!key || key.length > 256 || /[\x00-\x1f\x7f]/.test(key) || typeof value !== 'string' || !value.trim()
      || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('invalid_labels');
  }
  const labelBytes = canonicalJson(labels);
  if (labelBytes.length > 16000) throw new Error('invalid_labels');
  const files = Object.create(null);
  const inventory = Object.create(null);
  const addFile = (filePath, bytes, mime) => {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error('invalid_package_resource');
    if (Object.hasOwn(files, filePath)) throw new Error('duplicate_package_path');
    const stableBytes = Buffer.from(bytes);
    files[filePath] = stableBytes;
    inventory[filePath] = { bytes: stableBytes.length, mime, sha256: sha256(stableBytes) };
  };
  const sourceBytes = Buffer.from(source, 'utf8');
  addFile('source.md', sourceBytes, 'text/markdown; charset=utf-8');
  addFile('labels.json', labelBytes, 'application/json');

  const approvalPaths = Object.keys(approvedAssets).sort();
  const assetPaths = Object.keys(assets).sort();
  if (approvalPaths.length !== assetPaths.length || approvalPaths.some((key, index) => key !== assetPaths[index])) throw new Error('asset_approval_mismatch');
  for (const assetPath of approvalPaths) {
    const record = approvedAssets[assetPath];
    if (!safeAssetPath(assetPath) || !plainObject(record) || Object.keys(record).sort().join(',') !== 'mime,sha256'
      || record.mime !== 'image/png' || !HEX64.test(record.sha256 || '')) throw new Error('invalid_asset_approval');
    const image = assets[assetPath];
    if (!Buffer.isBuffer(image) || image.length > 4 * 1024 * 1024 || sha256(image) !== record.sha256) throw new Error('asset_approval_hash_mismatch');
    validatePng(image);
    addFile(`assets/images/${record.sha256}.png`, image, 'image/png');
  }

  if (!Object.hasOwn(resources, 'assets/katex.min.css')) throw new Error('invalid_package_resources');
  const fontPaths = [];
  const cssBytes = resources['assets/katex.min.css'];
  if (!Buffer.isBuffer(cssBytes)) throw new Error('invalid_package_resources');
  const css = cssBytes.toString('utf8');
  if (!Buffer.from(css, 'utf8').equals(cssBytes) || ['@import','expression','javascript:','http:','https:','data:','file:','<'].some(value => css.toLowerCase().includes(value))) throw new Error('invalid_package_css');
  const fontRefs = new Set();
  let searchFrom = 0;
  const lowerCss = css.toLowerCase();
  while (true) {
    const start = lowerCss.indexOf('url(', searchFrom);
    if (start < 0) break;
    const end = css.indexOf(')', start + 4);
    if (end < 0) throw new Error('invalid_package_css');
    const raw = css.slice(start + 4, end).trim();
    const relative = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")) ? raw.slice(1, -1) : raw;
    if (!relative.startsWith('fonts/')) throw new Error('invalid_package_css');
    const fontName = relative.slice('fonts/'.length);
    if (!fontName.startsWith('KaTeX_') || !['.woff2', '.woff', '.ttf'].some(extension => fontName.endsWith(extension))
      || [...fontName.slice(6, fontName.lastIndexOf('.'))].some(char => !/[A-Za-z0-9_-]/.test(char))) throw new Error('invalid_package_css');
    fontRefs.add(`assets/${relative}`);
    searchFrom = end + 1;
  }
  for (const filePath of Object.keys(resources).sort()) {
    const isCss = filePath === 'assets/katex.min.css';
        const fileFontName = filePath.startsWith('assets/fonts/') ? filePath.slice('assets/fonts/'.length) : '';
    const isFont = fileFontName.startsWith('KaTeX_') && ['.woff2', '.woff', '.ttf'].some(extension => fileFontName.endsWith(extension))
      && [...fileFontName.slice(6, fileFontName.lastIndexOf('.'))].every(char => /[A-Za-z0-9_-]/.test(char));
    if ((!isCss && !isFont) || (isFont && !fontRefs.has(filePath))) throw new Error('invalid_package_resources');
    const bytes = resources[filePath];
    addFile(filePath, bytes, isCss ? 'text/css; charset=utf-8' : filePath.endsWith('.woff2') ? 'font/woff2' : filePath.endsWith('.woff') ? 'font/woff' : 'font/ttf');
    if (isFont) fontPaths.push(filePath);
  }
  if (fontRefs.size !== fontPaths.length || [...fontRefs].some(item => !fontPaths.includes(item))) throw new Error('invalid_package_resources');
  const inventoryBytes = canonicalJson(inventory);
  const manifest = {
    schema: 'publication-v1-local-input',
    selected,
    source_sha256: sha256(sourceBytes),
    source_bytes: sourceBytes.length,
    title,
    labels_sha256: sha256(labelBytes),
    compiler: { id: 'blog-publisher-local-js', markdown_it: '14.1.0', katex: '0.16.22', bundle_sha256: compilerSha256 },
    inventory: JSON.parse(inventoryBytes.toString('utf8')),
    inventory_sha256: sha256(inventoryBytes),
  };
  const manifestBytes = canonicalJson(manifest);
  const filePayload = Object.create(null);
  for (const filePath of Object.keys(files).sort()) filePayload[filePath] = files[filePath].toString('base64');
  const packageBytes = canonicalJson({ manifest: JSON.parse(manifestBytes.toString('utf8')), files: filePayload });
  if (packageBytes.length > 72 * 1024 * 1024) throw new Error('fixed_input_package_too_large');
  return { manifestBytes, inventoryBytes, packageBytes, packageSha256: sha256(packageBytes) };
}

function renderDocument({ text, title, labels = {}, approvedAssets = {}, assetUrls = {}, katexCss = '' }) {
  if (typeof title !== 'string' || !title.trim() || title.length > 200 || /[\x00-\x1f\x7f]/.test(title)) throw new Error('invalid_title');
  if (typeof katexCss !== 'string') throw new Error('invalid_preview_input');
  const safeTitle = String(title).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  const body = renderMarkdown(text, { labels, approvedAssets, assetUrls });
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src 'unsafe-inline' blob:; font-src blob:; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'">`;
  const baseCss = 'body{margin:16px;color:var(--text-normal,#222);background:var(--background-primary,#fff);font-family:var(--font-text,system-ui,sans-serif);line-height:1.6}pre,.math-scroll{max-width:100%;overflow:auto}img{max-width:100%;height:auto}a{color:var(--text-accent,#526c9a)}';
  return `<!doctype html><html><head><meta charset="utf-8">${csp}<title>${safeTitle}</title><style>${katexCss}\n${baseCss}</style></head><body>${body}</body></html>`;
}

class PreviewGeneration {
  constructor() { this.revision = 0; this.closed = false; }
  begin() { if (this.closed) return -1; this.revision += 1; return this.revision; }
  isCurrent(token) { return !this.closed && token === this.revision; }
  invalidate() { this.revision += 1; }
  close() { this.closed = true; this.revision += 1; }
}

module.exports = { renderDocument, renderMarkdown, validatePng, readApprovedPng, readSelectedNote, createFixedInputPackage, canonicalJson, PreviewGeneration, safeAssetPath, safeHttpUrl, plainObject };
