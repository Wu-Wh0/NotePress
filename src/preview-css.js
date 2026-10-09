'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_CSS_BYTES = 128 * 1024;
const MESSAGE = '本地 CSS 未应用，已使用内置样式。请使用 Vault 内非隐藏、非链接的 CSS 文件（最多 128 KiB），并移除资源引用或转义字符。';

function validCssPath(value) {
  return typeof value === 'string' && value.length <= 2048 && /\.css$/i.test(value)
    && !/[\u0000-\u001f\u007f-\u009f\\:%?#]/u.test(value)
    // Obsidian does not provide normal Vault change events for hidden files.
    && value.split('/').every(part => part && !part.startsWith('.') && !/[. ]$/.test(part));
}

function safeCustomCss(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_CSS_BYTES) return null;
  // Deliberately conservative: escapes and resource functions are unsupported.
  // Removing comments for inspection also catches token obfuscation.
  const plain = value.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/[<\\\u0000]/u.test(value) || /@\s*import\b|\b(?:url|(?:-webkit-)?image-set)\s*\(/i.test(plain)) return null;
  return value;
}

async function readPreviewCss(adapter, filePath) {
  if (!filePath) return { css: '', message: '' };
  try {
    if (!validCssPath(filePath)) throw new Error('path');
    // For Obsidian's desktop filesystem adapter, reject linked descendants.
    // The Vault root itself may be an explicitly opened filesystem alias.
    if (typeof adapter.getBasePath === 'function') {
      const base = await fs.realpath(adapter.getBasePath());
      const selected = path.resolve(base, filePath);
      if (await fs.realpath(selected) !== selected) throw new Error('linked-path');
    }
    const stat = await adapter.stat(filePath);
    if (stat?.type !== 'file' || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_CSS_BYTES) throw new Error('size');
    const css = safeCustomCss(await adapter.read(filePath));
    if (css === null) throw new Error('css');
    return { css, message: '' };
  } catch {
    return { css: '', message: MESSAGE };
  }
}

module.exports = { readPreviewCss, safeCustomCss, MAX_CSS_BYTES };
