'use strict';

const {
  canonicalJson,
  plainObject,
  renderMarkdown,
  safeAssetPath,
  validatePng,
} = require('./core');

const HEX64 = /^[a-f0-9]{64}$/;
const MAX_FIXED_PACKAGE_BYTES = 72 * 1024 * 1024;
const MAX_SOURCE_BYTES = 65536;
const MAX_LABEL_BYTES = 16000;
const MAX_RESOURCE_BYTES = 2000000;
const MAX_TOTAL_BYTES = 16000000;
const MAX_BODY_BYTES = 65536;
const MAX_JSON_REQUEST_BYTES = 25165824;
const LOCAL_MANIFEST_KEYS = [
  'schema', 'selected', 'source_sha256', 'source_bytes', 'title', 'labels_sha256',
  'compiler', 'inventory', 'inventory_sha256',
];
const COMPILER_KEYS = ['id', 'markdown_it', 'katex', 'bundle_sha256'];
const LOCAL_FILE_KEYS = ['manifest', 'files'];

function sha256(bytes) {
  return require('node:crypto').createHash('sha256').update(bytes).digest('hex');
}

function exactKeys(value, keys) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = keys.slice().sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validSelectedPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && value.endsWith('.md')
    && !/[\\:\x00-\x1f\x7f]/.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.') && part === part.normalize('NFC'));
}

function validTitle(value) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
}

function decodeCanonicalJson(bytes, errorCode) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(errorCode);
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(errorCode); }
  let canonical;
  try { canonical = canonicalJson(value); } catch { throw new Error(errorCode); }
  if (!canonical.equals(bytes)) throw new Error(errorCode);
  return value;
}

function decodeBase64(value, errorCode) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(errorCode);
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.toString('base64') !== value) throw new Error(errorCode);
  return bytes;
}

function labelsFromBytes(bytes) {
  if (bytes.length < 2 || bytes.length > MAX_LABEL_BYTES) throw new Error('invalid_labels');
  const labels = decodeCanonicalJson(bytes, 'invalid_labels');
  if (!plainObject(labels)) throw new Error('invalid_labels');
  for (const [key, value] of Object.entries(labels)) {
    if (!key || key.length > 256 || /[\x00-\x1f\x7f]/.test(key)
      || typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error('invalid_labels');
    }
  }
  return labels;
}

function mimeForLocalPath(path) {
  if (path === 'source.md') return 'text/markdown; charset=utf-8';
  if (path === 'labels.json') return 'application/json';
  if (path === 'assets/katex.min.css') return 'text/css; charset=utf-8';
  if (/^assets\/fonts\/KaTeX_[A-Za-z0-9_-]+\.(?:woff2|woff|ttf)$/.test(path)) {
    if (path.endsWith('.woff2')) return 'font/woff2';
    if (path.endsWith('.woff')) return 'font/woff';
    return 'font/ttf';
  }
  const image = /^assets\/images\/([a-f0-9]{64})\.png$/.exec(path);
  return image ? 'image/png' : false;
}

function checkFontSignature(path, bytes) {
  if (path.endsWith('.woff2')) return bytes.subarray(0, 4).toString('ascii') === 'wOF2';
  if (path.endsWith('.woff')) return bytes.subarray(0, 4).toString('ascii') === 'wOFF';
  return bytes.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0])) || bytes.subarray(0, 4).toString('ascii') === 'true';
}

function validateCss(cssBytes, localAssets) {
  const css = cssBytes.toString('utf8');
  if (cssBytes.includes(0) || !Buffer.from(css, 'utf8').equals(cssBytes)
    || ['@import', 'expression', 'javascript:', 'http:', 'https:', 'data:', 'file:', '<'].some(value => css.toLowerCase().includes(value))) {
    throw new Error('invalid_package_css');
  }
  const expectedFonts = new Set();
  const lower = css.toLowerCase();
  let cursor = 0;
  while (true) {
    const start = lower.indexOf('url(', cursor);
    if (start < 0) break;
    const end = css.indexOf(')', start + 4);
    if (end < 0) throw new Error('invalid_package_css');
    const raw = css.slice(start + 4, end).trim();
    const relative = ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
      ? raw.slice(1, -1) : raw;
    if (!relative.startsWith('fonts/')) throw new Error('invalid_package_css');
    const path = `assets/${relative}`;
    if (!mimeForLocalPath(path) || !path.startsWith('assets/fonts/')) throw new Error('invalid_package_css');
    expectedFonts.add(path);
    cursor = end + 1;
  }
  const actualFonts = Object.keys(localAssets).filter(path => path.startsWith('assets/fonts/'));
  if (expectedFonts.size !== actualFonts.length || actualFonts.some(path => !expectedFonts.has(path))) {
    throw new Error('invalid_package_resources');
  }
}

function validateApprovedAssets(approvedAssets, imageAssets) {
  if (!plainObject(approvedAssets)) throw new Error('invalid_asset_snapshot');
  const entries = Object.entries(approvedAssets);
  if (entries.length !== imageAssets.size) throw new Error('asset_approval_mismatch');
  const approvedByHash = new Map();
  for (const [path, approval] of entries) {
    if (!safeAssetPath(path) || !exactKeys(approval, ['mime', 'sha256'])
      || approval.mime !== 'image/png' || !HEX64.test(approval.sha256 || '')
      || approvedByHash.has(approval.sha256)) throw new Error('invalid_asset_snapshot');
    const bytes = imageAssets.get(approval.sha256);
    if (!bytes || sha256(bytes) !== approval.sha256) throw new Error('asset_approval_hash_mismatch');
    approvedByHash.set(approval.sha256, path);
  }
  for (const digest of imageAssets.keys()) {
    if (!approvedByHash.has(digest)) throw new Error('asset_approval_mismatch');
  }
  return approvedByHash;
}

function escapeTitle(title) {
  return title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function createPublicationPackage(fixedInputPackageBytes, options = {}) {
  if (!Buffer.isBuffer(fixedInputPackageBytes) || fixedInputPackageBytes.length < 1
    || fixedInputPackageBytes.length > MAX_FIXED_PACKAGE_BYTES) throw new Error('invalid_fixed_input_package');
  if (!plainObject(options) || Object.keys(options).some(key => !['expectedBundleSha256', 'approvedAssets'].includes(key))) {
    throw new Error('invalid_publication_options');
  }
  const expectedBundleSha256 = options.expectedBundleSha256;
  const approvedAssets = options.approvedAssets === undefined ? Object.create(null) : options.approvedAssets;
  if (!HEX64.test(expectedBundleSha256 || '') || !plainObject(approvedAssets)) throw new Error('invalid_publication_options');

  const envelope = decodeCanonicalJson(fixedInputPackageBytes, 'invalid_fixed_input_package');
  if (!exactKeys(envelope, LOCAL_FILE_KEYS)) throw new Error('invalid_fixed_input_package');
  const manifest = envelope.manifest;
  if (!exactKeys(manifest, LOCAL_MANIFEST_KEYS) || manifest.schema !== 'publication-v1-local-input'
    || !validSelectedPath(manifest.selected) || !validTitle(manifest.title)
    || !HEX64.test(manifest.source_sha256 || '') || !Number.isSafeInteger(manifest.source_bytes)
    || manifest.source_bytes < 1 || manifest.source_bytes > MAX_SOURCE_BYTES
    || !HEX64.test(manifest.labels_sha256 || '') || !HEX64.test(manifest.inventory_sha256 || '')) {
    throw new Error('invalid_fixed_input_manifest');
  }
  if (!exactKeys(manifest.compiler, COMPILER_KEYS)
    || manifest.compiler.id !== 'blog-publisher-local-js'
    || manifest.compiler.markdown_it !== '14.1.0'
    || manifest.compiler.katex !== '0.16.22'
    || !HEX64.test(manifest.compiler.bundle_sha256 || '')
    || manifest.compiler.bundle_sha256 !== expectedBundleSha256) throw new Error('compiler_bundle_pin_mismatch');

  if (!plainObject(envelope.files) || !plainObject(manifest.inventory)
    || Object.keys(manifest.inventory).length < 3 || Object.keys(manifest.inventory).length > 128
    || sha256(canonicalJson(manifest.inventory)) !== manifest.inventory_sha256) throw new Error('invalid_fixed_input_inventory');
  const filePaths = Object.keys(envelope.files).sort();
  const inventoryPaths = Object.keys(manifest.inventory).sort();
  if (filePaths.length !== inventoryPaths.length || filePaths.some((path, index) => path !== inventoryPaths[index])) {
    throw new Error('fixed_input_file_inventory_mismatch');
  }

  const localAssets = Object.create(null);
  let source;
  let labels;
  const imageAssets = new Map();
  for (const path of inventoryPaths) {
    const mime = mimeForLocalPath(path);
    const record = manifest.inventory[path];
    if (!mime || !exactKeys(record, ['bytes', 'mime', 'sha256'])
      || record.mime !== mime || !Number.isSafeInteger(record.bytes) || record.bytes < 1
      || !HEX64.test(record.sha256 || '')) throw new Error('invalid_fixed_input_resource');
    const bytes = decodeBase64(envelope.files[path], 'invalid_fixed_input_resource');
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) throw new Error('fixed_input_resource_hash_mismatch');
    if (path === 'source.md') {
      if (bytes.length > MAX_SOURCE_BYTES) throw new Error('invalid_source');
      source = bytes.toString('utf8');
      if (!Buffer.from(source, 'utf8').equals(bytes) || bytes.length !== manifest.source_bytes
        || sha256(bytes) !== manifest.source_sha256) throw new Error('fixed_input_source_mismatch');
      continue;
    }
    if (path === 'labels.json') {
      if (bytes.length > MAX_LABEL_BYTES || sha256(bytes) !== manifest.labels_sha256) throw new Error('fixed_input_labels_mismatch');
      labels = labelsFromBytes(bytes);
      continue;
    }
    if (bytes.length > MAX_RESOURCE_BYTES) throw new Error('publication_resource_too_large');
    if (path === 'assets/katex.min.css') {
      localAssets[path] = bytes;
      continue;
    }
    if (path.startsWith('assets/fonts/')) {
      if (!checkFontSignature(path, bytes)) throw new Error('invalid_package_font');
      localAssets[path] = bytes;
      continue;
    }
    const image = /^assets\/images\/([a-f0-9]{64})\.png$/.exec(path);
    if (!image || image[1] !== record.sha256 || record.mime !== 'image/png') throw new Error('invalid_package_image');
    validatePng(bytes);
    imageAssets.set(image[1], bytes);
    localAssets[path] = bytes;
  }
  if (typeof source !== 'string' || !plainObject(labels)
    || !Object.hasOwn(manifest.inventory, 'source.md') || !Object.hasOwn(manifest.inventory, 'labels.json')
    || !Object.hasOwn(localAssets, 'assets/katex.min.css')) throw new Error('invalid_fixed_input_package');
  validateCss(localAssets['assets/katex.min.css'], localAssets);

  const pathByHash = validateApprovedAssets(approvedAssets, imageAssets);
  const assetUrls = Object.create(null);
  for (const [digest, path] of pathByHash) assetUrls[path] = `blob:publication-v1/${digest}`;
  const rendered = renderMarkdown(source, { labels, approvedAssets, assetUrls });
  let body = rendered;
  for (const [digest] of pathByHash) {
    const temporaryUrl = `blob:publication-v1/${digest}`;
    const replacement = `assets/images/${digest}.png`;
    body = body.replaceAll(`src="${temporaryUrl}"`, `src="${replacement}"`);
  }
  if (body.includes('blob:') || Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new Error('publication_preview_body_too_large');

  const preview = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeTitle(manifest.title)}</title><link rel="stylesheet" href="assets/katex.min.css"></head><body>${body}</body></html>`, 'utf8');
  const outputFiles = Object.create(null);
  const inventory = Object.create(null);
  let totalBytes = 0;
  const addOutput = (path, bytes) => {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_RESOURCE_BYTES || Object.hasOwn(outputFiles, path)) {
      throw new Error('publication_resource_too_large');
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('publication_package_too_large');
    outputFiles[path] = bytes;
    inventory[path] = { bytes: bytes.length, sha256: sha256(bytes) };
  };
  addOutput('preview.html', preview);
  for (const path of Object.keys(localAssets).sort()) addOutput(path, localAssets[path]);
  if (Object.keys(inventory).length < 2 || Object.keys(inventory).length > 128) throw new Error('invalid_publication_inventory');

  const publicationManifest = {
    schema: 'publication-v1',
    selected: manifest.selected,
    source_sha256: manifest.source_sha256,
    labels_sha256: manifest.labels_sha256,
    title: manifest.title,
    compiler: manifest.compiler,
    inventory,
  };
  const manifestBytes = canonicalJson(publicationManifest);
  const wireFiles = Object.create(null);
  for (const path of Object.keys(outputFiles).sort()) wireFiles[path] = outputFiles[path].toString('base64');
  const packageBytes = canonicalJson({ manifest: manifestBytes.toString('utf8'), files: wireFiles });
  if (packageBytes.length > MAX_JSON_REQUEST_BYTES) throw new Error('publication_json_request_too_large');
  return {
    manifestBytes,
    packageBytes,
    packageId: sha256(manifestBytes),
    compilerSha256: sha256(canonicalJson(publicationManifest.compiler)),
  };
}

module.exports = { createPublicationPackage };
