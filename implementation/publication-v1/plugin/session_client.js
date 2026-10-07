const crypto = require('node:crypto');
const http = require('node:http');
const { validateSelectedFile } = require('./selection');

const MAX_SOURCE_BYTES = 10000;
const MAX_LABEL_BYTES = 16000;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_ASSET_TOTAL = 48 * 1024 * 1024;
const MAX_CANDIDATE_RESPONSE_BYTES = 2048;
const MAX_BRIDGE_BODY_BYTES = 64 * 1024;
const MAX_STATUS_RESPONSE_BYTES = 32 * 1024;
const HEX64 = /^[a-f0-9]{64}$/;
const IMAGE_PATH = /^assets\/images\/([a-f0-9]{64})\.png$/;
const FONT_PATH = /^assets\/fonts\/KaTeX_[A-Za-z0-9_-]+\.(?:woff2|woff|ttf)$/;
const FROZEN_FONT_PATH = /^assets\/fonts\/KaTeX_[A-Za-z0-9_-]+\.(?:woff2|woff|ttf|otf)$/;

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
  const workflowConnected = value.workflowConnected === true;
  let sitePin;
  if (value.sitePin !== undefined) {
    try {
      const parsed = new URL(value.sitePin);
      if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password
        || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) throw new Error();
      sitePin = parsed.origin;
    } catch {
      throw new Error('publication_session_invalid');
    }
  }
  if (workflowConnected && !sitePin) throw new Error('publication_session_invalid');

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
    ...(workflowConnected ? { workflowConnected, sitePin } : {}),
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
            let code = 'bridge_rejected';
            try {
              const failure = JSON.parse(bytes.toString('utf8'));
              if (typeof failure?.code === 'string' && /^[a-z0-9_]{1,96}$/i.test(failure.code)) code = failure.code;
            } catch {}
            fail(new Error(code));
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

async function inspectAssetCandidate(session, path) {
  if (!safeAssetPath(path)) throw new Error('invalid_asset_path');
  const response = await request(session, 'POST', '/v1/asset-candidate', { path }, MAX_CANDIDATE_RESPONSE_BYTES, 200);
  if (response.contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new Error('asset_candidate_response_invalid');
  }
  let result;
  try { result = JSON.parse(response.bytes.toString('utf8')); }
  catch { throw new Error('asset_candidate_response_invalid'); }
  if (!exactKeys(result, ['bytes', 'mime', 'path', 'sha256']) || result.path !== path
    || result.mime !== 'image/png' || !Number.isSafeInteger(result.bytes)
    || result.bytes < 1 || result.bytes > MAX_ASSET_BYTES || typeof result.sha256 !== 'string'
    || !HEX64.test(result.sha256)) throw new Error('asset_candidate_response_invalid');
  return Object.freeze({ path: result.path, sha256: result.sha256, mime: result.mime, bytes: result.bytes });
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
  if (path.endsWith('.otf')) return 'font/otf';
  throw new Error('live_preview_asset_type_invalid');
}

const MAX_FROZEN_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_FROZEN_BUNDLE_BYTES = 66 * 1024 * 1024;

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (plainObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]));
  return value;
}

function jsonResponse(response, code) {
  if (response.contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new Error(code);
  try { return JSON.parse(response.bytes.toString('utf8')); }
  catch { throw new Error(code); }
}

function validatePrepareReceipt(value, session, selected) {
  if (!plainObject(value) || !/^[a-f0-9]{32}$/.test(value.operation_id)
    || value.state !== 'pending' || !HEX64.test(value.manifest_sha256)
    || value.selected_path !== selected.path || value.source_sha256 !== selected.source_sha256
    || value.title_sha256 !== sha256(Buffer.from(session.title, 'utf8'))
    || !HEX64.test(value.labels_sha256) || !HEX64.test(value.remote_digest)) {
    throw new Error('prepare_response_invalid');
  }
  const expectedImages = Object.fromEntries(Object.entries(session.approvedAssets).map(([path, record]) => [path, record.sha256]));
  if (plainObject(value.image_sha256) && JSON.stringify(Object.entries(value.image_sha256).sort()) !== JSON.stringify(Object.entries(expectedImages).sort())) {
    throw new Error('prepare_response_invalid');
  }
  return {
    operation_id: value.operation_id, state: value.state, digest: value.remote_digest,
    package_id: value.manifest_sha256, source_sha256: value.source_sha256,
    labels_sha256: value.labels_sha256, title_sha256: value.title_sha256,
  };
}

async function preparePublicationSession(session, selected) {
  if (session?.workflowConnected !== true) throw new Error('session_workflow_not_connected');
  if (!selected || selected.path !== session.selected) throw new Error('selected_path_mismatch');
  const response = await request(session, 'POST', '/v1/prepare', {
    title: session.title, approved_assets: session.approvedAssets,
  }, MAX_BRIDGE_BODY_BYTES, 201);
  return validatePrepareReceipt(jsonResponse(response, 'prepare_response_invalid'), session, selected);
}

function validateDiscoveredReceipt(value, session, selected) {
  const fields = ['digest', 'labels_sha256', 'operation_id', 'package_id', 'publication_approval', 'source_sha256', 'state', 'title_sha256'];
  if (!exactKeys(value, fields) || !/^[a-f0-9]{32}$/.test(value.operation_id)
    || !['pending', 'approved'].includes(value.state) || !HEX64.test(value.digest)
    || !HEX64.test(value.package_id) || value.source_sha256 !== selected.source_sha256
    || !HEX64.test(value.labels_sha256) || value.title_sha256 !== sha256(Buffer.from(session.title, 'utf8'))
    || value.publication_approval !== false) throw new Error('recovery_response_invalid');
  return {
    operation_id: value.operation_id, state: value.state, digest: value.digest,
    package_id: value.package_id, source_sha256: value.source_sha256,
    labels_sha256: value.labels_sha256, title_sha256: value.title_sha256,
  };
}

async function discoverPublicationReceipt(session, selected) {
  if (session?.workflowConnected !== true) throw new Error('session_workflow_not_connected');
  if (!selected || selected.path !== session.selected) throw new Error('selected_path_mismatch');
  const response = await request(session, 'POST', '/v1/recover', {
    title: session.title, approved_assets: session.approvedAssets,
  }, MAX_BRIDGE_BODY_BYTES, 200);
  return validateDiscoveredReceipt(jsonResponse(response, 'recovery_response_invalid'), session, selected);
}

async function publicationStatus(session, operationId) {
  if (session?.workflowConnected !== true || !/^[a-f0-9]{32}$/.test(operationId || '')) {
    throw new Error('publication_status_invalid');
  }
  const response = await request(session, 'GET', `/v1/status/${operationId}`, undefined, MAX_STATUS_RESPONSE_BYTES, 200);
  const value = jsonResponse(response, 'publication_status_invalid');
  if (!exactKeys(value, ['receipt', 'remote']) || !plainObject(value.receipt) || !plainObject(value.remote)
    || value.receipt.operation_id !== operationId || value.remote.operation_id !== operationId
    || !['pending', 'approved', 'committed', 'not_found', 'unknown'].includes(value.remote.state)) {
    throw new Error('publication_status_invalid');
  }
  if (['pending', 'approved', 'committed'].includes(value.remote.state)
    && (!HEX64.test(value.remote.digest || '') || value.receipt.remote_digest !== value.remote.digest)) {
    throw new Error('publication_status_invalid');
  }
  return value;
}

function validateFrozenInventory(inventory, approvedAssets) {
  if (!plainObject(inventory) || Object.keys(inventory).length < 1 || Object.keys(inventory).length > 64
    || !Object.hasOwn(inventory, 'assets/katex.min.css')) throw new Error('frozen_inventory_invalid');
  const expectedImages = new Set(Object.values(approvedAssets).map(record => `assets/images/${record.sha256}.png`));
  const foundImages = new Set();
  let total = 0;
  for (const [path, record] of Object.entries(inventory)) {
    const allowed = path === 'assets/katex.min.css' || IMAGE_PATH.test(path) || FROZEN_FONT_PATH.test(path);
    if (!allowed || path.includes('..') || /[\\%?#\x00-\x1f]/.test(path) || !exactKeys(record, ['bytes', 'sha256', 'mime'])
      || !Number.isSafeInteger(record.bytes) || record.bytes < 1 || record.bytes > MAX_ASSET_BYTES
      || !HEX64.test(record.sha256)) throw new Error('frozen_inventory_invalid');
    const type = contentType(path).split(';', 1)[0];
    if (record.mime !== type) throw new Error('frozen_inventory_invalid');
    total += record.bytes;
    if (total > MAX_ASSET_TOTAL) throw new Error('frozen_inventory_invalid');
    if (IMAGE_PATH.test(path)) foundImages.add(path);
  }
  if (foundImages.size !== expectedImages.size || [...foundImages].some(path => !expectedImages.has(path))) {
    throw new Error('frozen_image_binding_invalid');
  }
  return inventory;
}

function frozenHtmlForDisplay(rendered, snapshot, session, operationId, inventory, urls) {
  if (typeof rendered !== 'string' || Buffer.byteLength(rendered, 'utf8') > 65536) throw new Error('frozen_markup_rejected');
  const deniedTag = rendered.match(/<\s*(script|iframe|object|embed|form|input|button|video|audio|source|track|svg|base|meta|link|style)\b/i);
  if (deniedTag) throw new Error(`frozen_markup_tag_rejected_${deniedTag[1].toLowerCase()}`);
  if (/\bon[a-z][a-z0-9_-]*\s*=|\b(?:srcset|poster|background|xlink:href|srcdoc)\s*=/i.test(rendered)
    || /\b(?:src|href)\s*=\s*(?!["'])/i.test(rendered)) {
    throw new Error('frozen_markup_active_attribute_rejected');
  }
  const expectedImages = new Set();
  const tags = /<([A-Za-z][A-Za-z0-9:-]*)\b[^>]*>/g;
  let display = rendered;
  for (const match of rendered.matchAll(tags)) {
    const tag = match[1].toLowerCase();
    const seen = new Set();
    const attrs = [...match[0].matchAll(/([^\s=<>/]+)\s*=\s*(["'])(.*?)\2/g)];
    for (const attr of attrs) {
      const name = attr[1].toLowerCase();
      const value = attr[3];
      if (seen.has(name) || name.startsWith('on')) throw new Error('frozen_markup_rejected');
      seen.add(name);
      if (name === 'href') {
        if (tag !== 'a' || !safeHttpLink(value)) throw new Error('frozen_url_rejected');
      } else if (name === 'src') {
        const prefix = `${session.sitePin}/wp-json/publication-v1/v1/resources/${operationId}/`;
        const relative = typeof value === 'string' && value.startsWith(prefix) ? value.slice(prefix.length) : '';
        let canonical = false;
        try { const parsed = new URL(value); canonical = parsed.href === value && parsed.origin === session.sitePin
          && parsed.pathname === `/wp-json/publication-v1/v1/resources/${operationId}/${relative}`
          && !parsed.search && !parsed.hash && !parsed.username && !parsed.password; } catch {}
        if (tag !== 'img' || !IMAGE_PATH.test(relative) || !Object.hasOwn(inventory, relative) || !canonical) {
          throw new Error('frozen_url_rejected');
        }
        const blob = urls.get(relative);
        if (!blob) throw new Error('frozen_resource_missing');
        expectedImages.add(relative);
        display = display.replace(match[0], match[0].replace(attr[0], `${attr[1]}="${blob}"`));
      } else if (name === 'style') {
        // Retain only inert numeric layout declarations emitted by pinned KaTeX.
        // No URL, escapes, functions, colors, positioning mode or arbitrary CSS.
        const declarations = value.split(';').filter(part => part.trim());
        if (tag !== 'span' || !declarations.length || declarations.length > 16
          || declarations.some(part => !/^\s*(?:height|width|min-width|max-width|top|bottom|left|right|margin-left|margin-right|padding-left|padding-right|vertical-align|border-bottom-width|font-size|line-height)\s*:\s*-?(?:\d+(?:\.\d+)?|\.\d+)(?:em|ex|px|%)?\s*$/i.test(part))) {
          throw new Error('frozen_math_style_rejected');
        }
      } else if (name === 'aria-hidden') {
        if (tag !== 'span' || !['true', 'false'].includes(value)) throw new Error('frozen_markup_rejected');
      } else if (name === 'display') {
        if (tag !== 'math' || !['inline', 'block'].includes(value)) throw new Error('frozen_markup_rejected');
      } else if (name === 'encoding') {
        if (tag !== 'annotation' || value !== 'application/x-tex') throw new Error('frozen_markup_rejected');
      } else if (name === 'rel') {
        if (tag !== 'a' || !/^(?:nofollow|noopener|noreferrer|external|ugc|sponsored)(?:\s+(?:nofollow|noopener|noreferrer|external|ugc|sponsored))*$/i.test(value)) {
          throw new Error('frozen_markup_attribute_rejected_a_rel');
        }
      } else if (!['class', 'id', 'title', 'alt', 'width', 'height', 'colspan', 'rowspan', 'aria-label', 'role', 'dir', 'lang'].includes(name)) {
        throw new Error(`frozen_markup_attribute_rejected_${tag}_${name}`);
      }
    }
    if (tag === 'img' && !seen.has('src')) throw new Error('frozen_markup_rejected');
  }
  for (const path of Object.keys(inventory).filter(item => IMAGE_PATH.test(item))) {
    if (!expectedImages.has(path)) throw new Error('frozen_image_binding_invalid');
  }
  // Links are retained as text only; the source snapshot bytes stay untouched.
  display = display.replace(/\s+href=(['"])[^'"]*\1/gi, '');
  const safeTitle = escapeHtml(snapshot.title);
  const dark = false;
  const baseCss = `:root{color-scheme:${dark ? 'dark' : 'light'}}body{margin:16px;color:#222;background:#fff;font-family:system-ui,sans-serif;line-height:1.6}pre{max-width:100%;overflow:auto}img{max-width:100%;height:auto}`;
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src 'unsafe-inline'; font-src blob:; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'">`;
  const css = urls.get('assets/katex.min.css');
  return `<!doctype html><html><head><meta charset="utf-8">${csp}<title>${safeTitle}</title><style>${css || ''}${baseCss}</style></head><body>${display}</body></html>`;
}

async function renderFrozenSession(session, selected, receipt, browserWindow) {
  if (session?.workflowConnected !== true || !receipt || !/^[a-f0-9]{32}$/.test(receipt.operation_id || '')
    || receipt.source_sha256 !== selected?.source_sha256 || receipt.package_id === undefined
    || receipt.title_sha256 !== sha256(Buffer.from(session.title, 'utf8'))
    || !browserWindow?.URL?.createObjectURL || !browserWindow?.URL?.revokeObjectURL || typeof browserWindow.Blob !== 'function') {
    throw new Error('frozen_preview_binding_invalid');
  }
  const operationId = receipt.operation_id;
  const frozenResponse = await request(session, 'GET', `/v1/frozen/${operationId}`, undefined, MAX_FROZEN_SNAPSHOT_BYTES, 200);
  const frozen = jsonResponse(frozenResponse, 'frozen_snapshot_invalid');
  if (!exactKeys(frozen, ['operation_id', 'digest', 'state', 'snapshot_json', 'package_id', 'publication_approval'])
    || frozen.operation_id !== operationId || !HEX64.test(frozen.digest) || frozen.digest !== receipt.digest || frozen.package_id !== receipt.package_id
    || !['pending', 'approved'].includes(frozen.state) || frozen.publication_approval !== false
    || typeof frozen.snapshot_json !== 'string') throw new Error('frozen_snapshot_invalid');
  const raw = Buffer.from(frozen.snapshot_json, 'utf8');
  let snapshot;
  try { snapshot = JSON.parse(frozen.snapshot_json); } catch { throw new Error('frozen_snapshot_invalid'); }
  if (raw.length > MAX_FROZEN_SNAPSHOT_BYTES || sha256(raw) !== frozen.digest
    || Buffer.from(JSON.stringify(stableJson(snapshot)), 'utf8').compare(raw) !== 0) throw new Error('frozen_snapshot_integrity_invalid');
  const fields = ['schema', 'operation_key', 'selected', 'source_sha256', 'labels_sha256', 'title', 'publisher_id',
    'site_origin', 'visibility', 'target_id', 'baseline_sha256', 'manifest_sha256', 'compiler', 'compiler_sha256',
    'inventory', 'content', 'rendered', 'policy', 'policy_sha256', 'expires_at'];
  if (!exactKeys(snapshot, fields) || snapshot.schema !== 'publication-v1' || snapshot.operation_key !== operationId
    || snapshot.selected !== selected.path || snapshot.source_sha256 !== selected.source_sha256
    || snapshot.labels_sha256 !== receipt.labels_sha256 || snapshot.title !== session.title
    || sha256(Buffer.from(snapshot.title, 'utf8')) !== receipt.title_sha256
    || snapshot.site_origin !== `${session.sitePin}/` || snapshot.visibility !== 'public' || snapshot.target_id !== 0
    || snapshot.manifest_sha256 !== receipt.package_id || frozen.state !== 'pending' && frozen.state !== 'approved'
    || !Number.isSafeInteger(snapshot.expires_at) || snapshot.expires_at <= Math.floor(Date.now() / 1000)) {
    throw new Error('frozen_snapshot_binding_invalid');
  }
  const inventory = validateFrozenInventory(snapshot.inventory, session.approvedAssets);
  const bundleResponse = await request(session, 'GET', `/v1/frozen/${operationId}/assets`, undefined, MAX_FROZEN_BUNDLE_BYTES, 200);
  const bundle = jsonResponse(bundleResponse, 'frozen_assets_invalid');
  if (!exactKeys(bundle, ['operation_id', 'digest', 'package_id', 'assets']) || bundle.operation_id !== operationId
    || bundle.digest !== frozen.digest || bundle.package_id !== frozen.package_id || !plainObject(bundle.assets)
    || Object.keys(bundle.assets).length !== Object.keys(inventory).length
    || Object.keys(bundle.assets).some(path => !Object.hasOwn(inventory, path))) throw new Error('frozen_assets_invalid');
  const bytesByPath = new Map();
  for (const [path, record] of Object.entries(inventory)) {
    const item = bundle.assets[path];
    if (!exactKeys(item, ['bytes', 'sha256', 'content_type', 'data']) || item.bytes !== record.bytes
      || item.sha256 !== record.sha256 || item.content_type !== record.mime || typeof item.data !== 'string') {
      throw new Error('frozen_assets_invalid');
    }
    const bytes = Buffer.from(item.data, 'base64');
    if (bytes.toString('base64') !== item.data || bytes.length !== record.bytes || sha256(bytes) !== record.sha256) {
      throw new Error('frozen_asset_integrity_invalid');
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
      const blob = browserWindow.URL.createObjectURL(new browserWindow.Blob([bytes], { type: contentType(path) }));
      objectUrls.add(blob);
      urls.set(path, blob);
    }
    const cssBytes = bytesByPath.get('assets/katex.min.css');
    const css = cssBytes.toString('utf8');
    if (!Buffer.from(css, 'utf8').equals(cssBytes) || /@import|expression\s*\(|javascript:|https?:|data:|file:|<|\\/i.test(css)) {
      throw new Error('frozen_css_invalid');
    }
    let fontReferences = 0;
    const safeCss = css.replace(/url\(\s*(?:(['"])(.*?)\1|([^)]*?))\s*\)/gi, (_match, _quote, quoted, bare) => {
      const relative = (quoted === undefined ? bare : quoted).trim();
      if (!/^fonts\/KaTeX_[A-Za-z0-9_-]+\.(?:woff2|woff|ttf|otf)$/.test(relative)) throw new Error('frozen_url_rejected');
      const blob = urls.get(`assets/${relative}`);
      if (!blob) throw new Error('frozen_font_missing');
      fontReferences++;
      return `url("${blob}")`;
    });
    const cssWithoutVerifiedUrls = safeCss.replace(/url\(\s*["']blob:[^"']+["']\s*\)/gi, '');
    if ((fontReferences > 0 && !safeCss.includes('blob:')) || /url\s*\(/i.test(cssWithoutVerifiedUrls)) {
      throw new Error('frozen_css_invalid');
    }
    const srcdoc = frozenHtmlForDisplay(snapshot.rendered, snapshot, session, operationId, inventory, new Map([
      ...urls, ['assets/katex.min.css', safeCss],
    ]));
    return {
      operation_id: operationId, package_id: frozen.package_id, digest: frozen.digest, state: frozen.state,
      rendered: snapshot.rendered, snapshot_json: frozen.snapshot_json, srcdoc, object_urls: [...objectUrls], dispose,
      publication_approval: false, recovered: receipt.recovered === true,
    };
  } catch (error) {
    dispose();
    throw error;
  }
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

module.exports = { normalizePublicationSession, inspectAssetCandidate, renderLiveSession, preparePublicationSession, discoverPublicationReceipt, publicationStatus, renderFrozenSession, safeAssetPath };
