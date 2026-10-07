const crypto = require('node:crypto');
const http = require('node:http');
const { validateSelectedFile } = require('./selection');

const MAX_SOURCE_BYTES = 10000;
const MAX_LABEL_BYTES = 16000;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_ASSET_TOTAL = 48 * 1024 * 1024;
const HEX64 = /^[a-f0-9]{64}$/;
const IMAGE_PATH = /^assets\/images\/([a-f0-9]{64})\.png$/;
const FONT_PATH = /^assets\/fonts\/KaTeX_[A-Za-z0-9_-]+\.(?:woff2|woff|ttf)$/;

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeAssetPath(value) {
  return typeof value === 'string' && value.length <= 1024 && value.endsWith('.png')
    && !/[\\%?#\s\x00-\x1f\x7f]/u.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.') && !/[\p{C}]/u.test(part));
}

function normalizePublicationSession(value) {
  if (!plainObject(value)) throw new Error('publication_session_invalid');
  let origin;
  try {
    const parsed = new URL(value.origin);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port
      || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash
      || parsed.origin !== value.origin) throw new Error();
    origin = parsed.origin;
  } catch {
    throw new Error('publication_session_invalid');
  }
  if (typeof value.authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(value.authorization)) {
    throw new Error('publication_session_invalid');
  }
  let selected;
  try {
    selected = validateSelectedFile({ path: value.selected, extension: 'md' });
  } catch {
    throw new Error('publication_session_invalid');
  }
  const title = value.title === undefined ? selected.split('/').at(-1).slice(0, -3) : value.title;
  if (typeof title !== 'string' || !title.trim() || title.length > 200
    || [...title].some(char => char.codePointAt(0) < 32 || char.codePointAt(0) === 127)) {
    throw new Error('publication_session_invalid');
  }

  const approvedAssets = value.approvedAssets === undefined ? {} : value.approvedAssets;
  if (!plainObject(approvedAssets) || Object.keys(approvedAssets).length > 8) throw new Error('publication_session_invalid');
  const assets = {};
  for (const [path, record] of Object.entries(approvedAssets)) {
    if (!safeAssetPath(path) || !plainObject(record)
      || Object.keys(record).sort().join(',') !== 'mime,sha256'
      || record.mime !== 'image/png' || typeof record.sha256 !== 'string' || !HEX64.test(record.sha256)) {
      throw new Error('publication_session_invalid');
    }
    assets[path] = { sha256: record.sha256, mime: 'image/png' };
  }

  const approvedLabels = value.approvedLabels === undefined ? {} : value.approvedLabels;
  if (!plainObject(approvedLabels)) throw new Error('publication_session_invalid');
  const labels = {};
  for (const [key, label] of Object.entries(approvedLabels)) {
    if (!key || key.length > 256 || /[\x00-\x1f\x7f]/.test(key)
      || typeof label !== 'string' || !label.trim() || label.length > 200 || /[\x00-\x1f\x7f]/.test(label)) {
      throw new Error('publication_session_invalid');
    }
    labels[key] = label;
  }
  if (Buffer.byteLength(JSON.stringify(labels), 'utf8') > MAX_LABEL_BYTES) throw new Error('publication_session_invalid');
  return Object.freeze({
    origin,
    authorization: value.authorization,
    selected,
    title,
    approvedAssets: Object.freeze(assets),
    approvedLabels: Object.freeze(labels),
  });
}

function request(session, method, route, body, limit, expectedStatus) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {
      Origin: 'app://obsidian.md',
      Authorization: session.authorization,
      Accept: body === undefined ? '*/*' : 'application/json',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    let req;
    try {
      req = http.request(new URL(route, session.origin), { method, headers }, response => {
        const chunks = [];
        let length = 0;
        response.on('data', chunk => {
          length += chunk.length;
          if (length > limit) {
            fail(new Error('live_response_too_large'));
            response.destroy();
            req.destroy();
          } else chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          const bytes = Buffer.concat(chunks);
          if (response.statusCode !== expectedStatus) {
            fail(new Error('bridge_rejected'));
            return;
          }
          settled = true;
          resolve({ bytes, contentType: response.headers['content-type'] || '' });
        });
      });
    } catch {
      fail(new Error('bridge_request_invalid'));
      return;
    }
    req.on('error', () => fail(new Error('bridge_unavailable')));
    req.setTimeout(120000, () => req.destroy(new Error('bridge_timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function exactKeys(value, expected) {
  return plainObject(value) && Object.keys(value).sort().join(',') === expected.slice().sort().join(',');
}

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function safeHttpLink(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\\]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && !!parsed.hostname && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function validateHtml(html, title, assetInventory) {
  const prefix = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="assets/katex.min.css"></head><body>`;
  const suffix = '</body></html>';
  if (!html.startsWith(prefix) || !html.endsWith(suffix)) throw new Error('live_preview_html_invalid');
  if (/<\s*(?:script|iframe|object|embed|form|input|button|video|audio|source|track|svg|base|meta|link|style)\b/i.test(html.slice(prefix.length, -suffix.length))
    || /\bon[a-z][a-z0-9_-]*\s*=/i.test(html)
    || /\b(?:srcset|poster|background|xlink:href|srcdoc)\s*=/i.test(html)
    || /\b(?:src|href)\s*=\s*(?!["'])/i.test(html)) {
    throw new Error('live_preview_html_invalid');
  }
  const body = html.slice(prefix.length, -suffix.length);
  const references = new Set();
  let stylesheetCount = 1;
  const tags = /<([A-Za-z][A-Za-z0-9:-]*)\b[^>]*>/g;
  for (const match of html.matchAll(tags)) {
    const tag = match[1].toLowerCase();
    const seen = new Set();
    const attributes = [...match[0].matchAll(/([^\s=<>/]+)\s*=\s*(["'])(.*?)\2/g)];
    for (const attribute of attributes) {
      const name = attribute[1].toLowerCase();
      const value = attribute[3];
      if (seen.has(name) || name.startsWith('on')) throw new Error('live_preview_html_invalid');
      seen.add(name);
      if (name === 'style' && /url\s*\(|expression\s*\(|@import/i.test(value)) throw new Error('live_preview_html_invalid');
      if (name === 'href') {
        if (tag === 'link' && value === 'assets/katex.min.css') stylesheetCount++;
        else if (tag === 'a' && safeHttpLink(value)) {
          // Links are rendered as inert text inside the sandboxed local preview.
        } else throw new Error('live_preview_url_rejected');
      }
      if (name === 'src') {
        if (tag !== 'img' || !IMAGE_PATH.test(value) || !Object.hasOwn(assetInventory, value)) {
          throw new Error('live_preview_url_rejected');
        }
        references.add(value);
      }
    }
    if (tag === 'img' && !seen.has('src')) throw new Error('live_preview_html_invalid');
  }
  if (stylesheetCount !== 2) throw new Error('live_preview_html_invalid');
  const manifestImages = Object.keys(assetInventory).filter(path => IMAGE_PATH.test(path));
  if (manifestImages.length !== references.size || manifestImages.some(path => !references.has(path))) {
    throw new Error('live_preview_asset_binding_invalid');
  }
  const inertBody = body.replace(/<a\b[^>]*>/gi, open => open.replace(/\s+href=(['"])[^'"]*\1/i, ''));
  return html.slice(0, prefix.length) + inertBody + suffix;
}

function validateAssets(value) {
  if (!plainObject(value) || Object.keys(value).length < 1 || Object.keys(value).length > 64
    || !Object.hasOwn(value, 'assets/katex.min.css')) throw new Error('live_preview_assets_invalid');
  let total = 0;
  for (const [path, record] of Object.entries(value)) {
    if (!(path === 'assets/katex.min.css' || FONT_PATH.test(path) || IMAGE_PATH.test(path))
      || !exactKeys(record, ['bytes', 'sha256']) || !Number.isSafeInteger(record.bytes)
      || record.bytes < 1 || record.bytes > MAX_ASSET_BYTES || typeof record.sha256 !== 'string' || !HEX64.test(record.sha256)) {
      throw new Error('live_preview_assets_invalid');
    }
    total += record.bytes;
    if (total > MAX_ASSET_TOTAL) throw new Error('live_preview_assets_invalid');
  }
  return value;
}

function contentType(path) {
  if (path === 'assets/katex.min.css') return 'text/css; charset=utf-8';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.woff2')) return 'font/woff2';
  if (path.endsWith('.woff')) return 'font/woff';
  if (path.endsWith('.ttf')) return 'font/ttf';
  throw new Error('live_preview_asset_type_invalid');
}

async function renderLiveSession(session, selected, browserWindow) {
  if (!selected || selected.path !== session.selected || typeof selected.text !== 'string'
    || Buffer.from(selected.text, 'utf8').toString('utf8') !== selected.text
    || Buffer.byteLength(selected.text, 'utf8') > MAX_SOURCE_BYTES
    || sha256(Buffer.from(selected.text, 'utf8')) !== selected.source_sha256) {
    throw new Error('live_source_binding_invalid');
  }
  const requestBody = {
    path: selected.path,
    text: selected.text,
    source_sha256: selected.source_sha256,
    title: session.title,
    approved_assets: session.approvedAssets,
    approved_labels: session.approvedLabels,
  };
  const response = await request(session, 'POST', '/v1/live', requestBody, MAX_PREVIEW_BYTES, 200);
  let out;
  try {
    out = JSON.parse(response.bytes.toString('utf8'));
  } catch {
    throw new Error('live_preview_response_invalid');
  }
  const fields = ['asset_inventory', 'html', 'manifest_sha256', 'mode', 'package_id', 'path', 'preview_sha256', 'publication_approval', 'source_sha256', 'state', 'title_sha256'];
  if (!exactKeys(out, fields) || !HEX64.test(out.package_id) || out.manifest_sha256 !== out.package_id
    || out.path !== selected.path || out.source_sha256 !== selected.source_sha256
    || out.title_sha256 !== sha256(Buffer.from(session.title, 'utf8'))
    || typeof out.html !== 'string' || sha256(Buffer.from(out.html, 'utf8')) !== out.preview_sha256
    || !HEX64.test(out.preview_sha256) || out.mode !== 'live' || out.state !== 'live'
    || out.publication_approval !== false) throw new Error('live_preview_integrity_invalid');
  if (!browserWindow?.URL?.createObjectURL || !browserWindow?.URL?.revokeObjectURL
    || typeof browserWindow.Blob !== 'function') throw new Error('preview_frame_unavailable');
  const assets = validateAssets(out.asset_inventory);
  let html = validateHtml(out.html, session.title, assets);

  const bundleResponse = await request(session, 'GET', `/v1/assets/${out.package_id}`, undefined, 65 * 1024 * 1024, 200);
  if (bundleResponse.contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new Error('live_preview_asset_bundle_invalid');
  }
  let bundle;
  try {
    bundle = JSON.parse(bundleResponse.bytes.toString('utf8'));
  } catch {
    throw new Error('live_preview_asset_bundle_invalid');
  }
  if (!exactKeys(bundle, ['assets', 'package_id']) || bundle.package_id !== out.package_id
    || !plainObject(bundle.assets) || Object.keys(bundle.assets).length !== Object.keys(assets).length) {
    throw new Error('live_preview_asset_bundle_invalid');
  }
  const bytesByPath = new Map();
  for (const [path, record] of Object.entries(assets)) {
    const item = bundle.assets[path];
    if (!exactKeys(item, ['bytes', 'content_type', 'data', 'sha256'])
      || item.bytes !== record.bytes || item.sha256 !== record.sha256
      || item.content_type.toLowerCase() !== contentType(path).toLowerCase()
      || typeof item.data !== 'string') throw new Error('live_preview_asset_bundle_invalid');
    const bytes = Buffer.from(item.data, 'base64');
    if (bytes.toString('base64') !== item.data || bytes.length !== record.bytes || sha256(bytes) !== record.sha256) {
      throw new Error('live_preview_asset_integrity_invalid');
    }
    bytesByPath.set(path, bytes);
  }

  const objectUrls = new Set();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const value of objectUrls) browserWindow.URL.revokeObjectURL(value);
    objectUrls.clear();
  };
  try {
    const urls = new Map();
    for (const [path, bytes] of bytesByPath) {
      if (path === 'assets/katex.min.css') continue;
      const value = browserWindow.URL.createObjectURL(new browserWindow.Blob([bytes], { type: contentType(path) }));
      objectUrls.add(value);
      urls.set(path, value);
    }
    const cssBytes = bytesByPath.get('assets/katex.min.css');
    const css = cssBytes.toString('utf8');
    if (!Buffer.from(css, 'utf8').equals(cssBytes) || /@import|expression\s*\(|javascript:|https?:|data:|file:/i.test(css)) {
      throw new Error('live_preview_css_invalid');
    }
    let fontReferences = 0;
    const safeCss = css.replace(/url\(\s*(?:(['"])(.*?)\1|([^)]*?))\s*\)/gi, (_match, _quote, quoted, bare) => {
      const relative = (quoted === undefined ? bare : quoted).trim();
      if (!/^fonts\/KaTeX_[A-Za-z0-9_-]+\.(?:woff2|woff|ttf)$/.test(relative)) throw new Error('live_preview_url_rejected');
      const value = urls.get(`assets/${relative}`);
      if (!value) throw new Error('live_preview_asset_binding_invalid');
      fontReferences++;
      return `url("${value}")`;
    });
    if (!fontReferences || /url\s*\(\s*(?!["']?blob:)/i.test(safeCss)) throw new Error('live_preview_css_invalid');
    if (safeCss.includes('<')) throw new Error('live_preview_css_invalid');
    const dark = browserWindow.document?.body?.classList?.contains('theme-dark') === true;
    const baseCss = `:root{color-scheme:${dark ? 'dark' : 'light'}}body{margin:16px;color:${dark ? '#dadada' : '#222'};background:${dark ? '#1e1e1e' : '#fff'};font-family:system-ui,sans-serif;line-height:1.6}pre,.math-scroll{max-width:100%;overflow-x:auto}img{max-width:100%;height:auto}`;
    // srcdoc in native Obsidian did not apply the blob stylesheet. Embed only
    // byte-verified, URL-rewritten CSS; scripts and remote resources remain denied.
    html = html.replace('<link rel="stylesheet" href="assets/katex.min.css">', `<style>${safeCss}${baseCss}</style>`);
    for (const [path, value] of urls) {
      if (IMAGE_PATH.test(path)) html = html.replaceAll(`src="${path}"`, `src="${value}"`);
    }
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src blob: 'unsafe-inline'; font-src blob:; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'">`;
    const srcdoc = html.replace('<meta charset="utf-8">', `<meta charset="utf-8">${csp}`);
    return {
      ...out,
      html,
      srcdoc,
      object_urls: [...objectUrls],
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

module.exports = { normalizePublicationSession, renderLiveSession };
