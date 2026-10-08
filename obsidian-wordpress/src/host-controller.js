'use strict';

const crypto = require('node:crypto');

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_IMAGES = 32;
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
// A valid renderer preflight URL; the preview CSP never allows loading it.
const PLACEHOLDER_IMAGE = 'https://preflight.invalid/image';
const IMAGE_TYPES = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'],
  ['webp', 'image/webp'], ['avif', 'image/avif'], ['bmp', 'image/bmp'],
]);
const SAFE_SETTING_KEYS = ['siteUrl', 'username', 'secretRef'];

function safeString(value, limit) {
  return typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value.trim() : '';
}

function sanitizeSettings(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const secret = safeString(input.secretRef, 128);
  return {
    siteUrl: safeString(input.siteUrl, 2048),
    username: safeString(input.username, 120),
    secretRef: /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(secret) ? secret : '',
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function settingsKey(settings) {
  return JSON.stringify(SAFE_SETTING_KEYS.map((key) => settings[key]));
}

function strictSiteLink(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f\\]/u.test(value)
      || value.includes('?') || value.includes('#') || /^https:\/\/[^/]*@/iu.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) return null;
    return { value, origin: url.origin };
  } catch {
    return null;
  }
}

function strictPublishedLink(value, site) {
  if (!site || typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    const query = [...url.searchParams];
    const nativeQuery = query.length === 1 && query[0][0] === 'p' && /^[1-9]\d*$/u.test(query[0][1])
      && Number.isSafeInteger(Number(query[0][1]));
    return url.protocol === 'https:' && url.origin === site.origin && !url.username && !url.password && !url.hash
      && (!url.search || nativeQuery) ? value : null;
  } catch {
    return null;
  }
}

function normalizeVaultRef(reference, notePath, resolvedPath, attachmentFolder) {
  if (typeof reference !== 'string' || !reference || /[\u0000-\u001f\u007f\\]/u.test(reference)
      || reference.startsWith('/') || reference.split('/').includes('..')) return false;
  const parts = reference.split('/').filter((part) => part && part !== '.');
  const noteParts = notePath.split('/');
  noteParts.pop();
  // Resolve basename-only links against the configured attachment destination,
  // not against an arbitrary first-match file elsewhere in the vault.
  if (parts.length < 2) {
    if (typeof attachmentFolder !== 'string' || /[\u0000-\u001f\u007f\\]/u.test(attachmentFolder)
        || attachmentFolder.startsWith('/') || attachmentFolder.split('/').includes('..')) return false;
    const relativeFolder = attachmentFolder === '.' || attachmentFolder.startsWith('./');
    const folderParts = attachmentFolder.split('/').filter(part => part && part !== '.');
    return resolvedPath === [...(relativeFolder ? noteParts : []), ...folderParts, ...parts].join('/');
  }
  const relative = [...noteParts, ...parts].filter(Boolean).join('/');
  const root = parts.join('/');
  return resolvedPath === relative || resolvedPath === root;
}

function fileStat(file) {
  const size = file?.stat?.size;
  const mtime = file?.stat?.mtime;
  if (!Number.isSafeInteger(size) || size < 1 || !Number.isFinite(mtime)) return null;
  return { size, mtime };
}

function asBytes(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

function issueMessage(code) {
  const messages = {
    invalid_note: '请先打开一篇 Markdown 笔记。',
    note_too_large: '笔记过大，无法安全预览。',
    unsupported_note_embed: '含有笔记嵌入；请改用普通文字后再发布。',
    invalid_article: '文章包含暂不支持的内容。',
    too_many_images: '图片数量超出限制。',
    remote_image: '远程图片不会自动载入，发布前请换成本地图片。',
    ambiguous_image: '图片路径不明确；请在引用中写出完整的库内相对路径。',
    missing_image: '有图片未找到；请检查图片引用。',
    image_too_large: '单张图片或图片总量超出限制。',
    image_changed: '读取图片时文件发生变化，请重新预览。',
    unsupported_image: '含有不支持的图片类型。',
    input_changed: '内容或设置已变化，请重新预览后操作。',
    secret_missing: '请在设置中选择 WordPress 密钥。',
    settings_missing: '请先完成 WordPress 连接设置。',
    store_unavailable: '发布记录不可用，未发送请求。',
    busy: '上一个操作仍在处理中。',
    connection_failed: '连接失败，请检查设置。',
    publish_failed: '未能完成发布，请检查文章和连接设置。',
    needs_check: '发布结果待核对，请点击“核对结果”。',
    conflict: '站点文章已变化，未覆盖。',
    published: '发布结果已核对。',
    blocked: '当前内容未发布。',
  };
  return messages[code] || messages.blocked;
}

function publicIssues(codes) {
  return codes.map((code) => ({ code, message: issueMessage(code) }));
}

function createHostController(deps = {}) {
  const required = [
    'getSettings', 'getSelectedFile', 'isFile', 'readSource', 'resolveImage', 'readBinary', 'getSecret',
    'extractImageReferences', 'renderArticle', 'createClient', 'createPublisher', 'getStore',
  ];
  for (const key of required) if (typeof deps[key] !== 'function') throw new TypeError(`missing_dependency:${key}`);

  const maxImageBytes = Number.isSafeInteger(deps.maxImageBytes) && deps.maxImageBytes > 0
    ? deps.maxImageBytes : DEFAULT_MAX_IMAGE_BYTES;
  const maxTotalImageBytes = Number.isSafeInteger(deps.maxTotalImageBytes) && deps.maxTotalImageBytes > 0
    ? deps.maxTotalImageBytes : DEFAULT_MAX_TOTAL_IMAGE_BYTES;
  const maxImages = Number.isSafeInteger(deps.maxImages) && deps.maxImages > 0 ? Math.min(deps.maxImages, MAX_IMAGES) : MAX_IMAGES;
  const onPreview = typeof deps.onPreview === 'function' ? deps.onPreview : () => {};
  const onAction = typeof deps.onAction === 'function' ? deps.onAction : () => {};

  let revision = 0;
  let renderSequence = 0;
  let disposed = false;
  let actionBusy = false;
  let runtime = null;
  let currentImagePaths = new Set();
  let activeObjectUrls = new Set();
  let connectionControllers = new Set();

  function currentSettings() {
    return sanitizeSettings(deps.getSettings());
  }

  function revoke(urls) {
    if (typeof deps.revokeObjectURL !== 'function') return;
    for (const url of urls) {
      try { deps.revokeObjectURL(url); } catch { /* Best-effort resource cleanup. */ }
    }
  }

  function abortWork() {
    runtime?.abortController.abort();
    runtime = null;
    for (const controller of connectionControllers) controller.abort();
    connectionControllers.clear();
  }

  function invalidate(_reason = 'input-changed', path) {
    if (disposed) return false;
    if (typeof path === 'string' && path && path !== deps.getSelectedFile()?.path && !currentImagePaths.has(path)) return false;
    revision += 1;
    abortWork();
    return true;
  }

  function setSettings() {
    return invalidate('settings-changed');
  }

  function isSelected(file, path, startRevision, key) {
    if (disposed || revision !== startRevision) return false;
    const selected = deps.getSelectedFile();
    return deps.isFile(selected) && selected.path === path && settingsKey(currentSettings()) === key
      && deps.isFile(file) && file.path === path;
  }

  async function loadSource(file) {
    const text = await deps.readSource(file);
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES) throw new Error('note_too_large');
    return text;
  }

  async function resolveImages(refs, note) {
    const images = [];
    const issues = [];
    const assetUrls = Object.create(null);
    const localPaths = new Set();
    let total = 0;
    let attachmentFolder = null;
    if (typeof deps.getAttachmentFolderPath === 'function') {
      try { attachmentFolder = await deps.getAttachmentFolderPath(); } catch { /* Unknown setting stays fail-closed. */ }
    }
    if (refs.length > maxImages) return { images, issues: ['too_many_images'], assetUrls, localPaths };

    for (const ref of refs) {
      const refPath = ref?.sourcePath;
      if (typeof refPath !== 'string' || !refPath) {
        issues.push('missing_image');
        continue;
      }
      if (ref.kind === 'remote') {
        issues.push('remote_image');
        assetUrls[refPath] = PLACEHOLDER_IMAGE;
        continue;
      }
      let file;
      try { file = await deps.resolveImage(refPath, note.path); } catch { file = null; }
      if (deps.isFile(file) && typeof file.path === 'string') localPaths.add(file.path);
      if (!deps.isFile(file) || !normalizeVaultRef(refPath, note.path, file.path, attachmentFolder)) {
        issues.push(deps.isFile(file) ? 'ambiguous_image' : 'missing_image');
        assetUrls[refPath] = PLACEHOLDER_IMAGE;
        continue;
      }
      const mime = IMAGE_TYPES.get(String(file.extension || '').toLowerCase());
      const before = fileStat(file);
      if (!mime || !before) {
        issues.push(mime ? 'missing_image' : 'unsupported_image');
        assetUrls[refPath] = PLACEHOLDER_IMAGE;
        continue;
      }
      if (before.size > maxImageBytes || total + before.size > maxTotalImageBytes) {
        issues.push('image_too_large');
        assetUrls[refPath] = PLACEHOLDER_IMAGE;
        continue;
      }
      total += before.size;
      let bytes;
      try { bytes = asBytes(await deps.readBinary(file)); } catch { bytes = null; }
      const after = fileStat(file);
      if (!bytes || !after || before.size !== after.size || before.mtime !== after.mtime || bytes.byteLength !== before.size) {
        issues.push('image_changed');
        assetUrls[refPath] = PLACEHOLDER_IMAGE;
        continue;
      }
      if (bytes.byteLength > maxImageBytes) {
        issues.push('image_too_large');
        assetUrls[refPath] = PLACEHOLDER_IMAGE;
        continue;
      }
      images.push({ sourcePath: refPath, file, bytes: Buffer.from(bytes), mime, hash: sha256(bytes), stat: before });
      assetUrls[refPath] = PLACEHOLDER_IMAGE;
    }
    return { images, issues: [...new Set(issues)], assetUrls, localPaths };
  }

  async function receiptFor(snapshot) {
    let store;
    try { store = deps.getStore(snapshot.settings); } catch { return { receipt: null, store: null }; }
    if (!store || typeof store.load !== 'function') return { receipt: null, store: null };
    try {
      const record = await store.load(snapshot.noteID);
      if (!record || record.siteUrl !== snapshot.settings.siteUrl) return { receipt: null, store };
      const site = strictSiteLink(snapshot.settings.siteUrl);
      const link = strictPublishedLink(record.link, site);
      const completed = record.stage === 'completed' && Number.isSafeInteger(record.postID) && !!link;
      const currentAssets = snapshot.images.map((image) => ({
        referenceHash: sha256(Buffer.from(image.sourcePath, 'utf8')),
        assetHash: sha256(Buffer.from(JSON.stringify({ contentHash: image.hash, mime: image.mime }), 'utf8')),
      }));
      const oldAssets = Array.isArray(record.media) ? record.media : [];
      const assetsMatch = currentAssets.every((item) => oldAssets.some((old) => old.referenceHash === item.referenceHash && old.assetHash === item.assetHash));
      const dirty = completed && (record.sourceHash !== sha256(Buffer.from(snapshot.source, 'utf8'))
        || record.titleHash !== sha256(Buffer.from(snapshot.title, 'utf8')) || !assetsMatch);
      return {
        receipt: completed ? { link, dirty, needsCheck: false } : {
          link: null, dirty: false, needsCheck: record.stage !== 'completed',
        },
        store,
      };
    } catch {
      return { receipt: null, store };
    }
  }

  async function collect({ renderBlobs = false, emit = false } = {}) {
    const startRevision = revision;
    const renderID = ++renderSequence;
    const settings = currentSettings();
    const key = settingsKey(settings);
    const note = deps.getSelectedFile();
    if (!deps.isFile(note) || String(note.extension).toLowerCase() !== 'md' || typeof note.path !== 'string') {
      return { status: 'empty', html: '', issues: publicIssues(['invalid_note']), noteID: null, canPublish: false };
    }
    const notePath = note.path;
    const relevantPaths = new Set([notePath]);
    currentImagePaths = relevantPaths;
    const stale = () => !isSelected(note, notePath, startRevision, key) || renderID !== renderSequence;
    let source;
    try {
      const stat = fileStat(note);
      if (stat && stat.size > MAX_SOURCE_BYTES) throw new Error('note_too_large');
      source = await loadSource(note);
    } catch (error) {
      const code = error?.message === 'note_too_large' ? 'note_too_large' : 'invalid_article';
      return { status: 'blocked', html: '', issues: publicIssues([code]), noteID: sha256(Buffer.from(notePath, 'utf8')), canPublish: false };
    }
    if (stale()) return { status: 'stale', html: '', issues: [], noteID: sha256(Buffer.from(notePath, 'utf8')), canPublish: false };

    let refs;
    try { refs = deps.extractImageReferences(source); }
    catch (error) {
      const code = error?.message === 'unsupported_note_embed' ? 'unsupported_note_embed' : 'invalid_article';
      return { status: 'blocked', html: '', issues: publicIssues([code]), noteID: sha256(Buffer.from(notePath, 'utf8')), canPublish: false };
    }
    if (!Array.isArray(refs)) refs = [];
    const resolved = await resolveImages(refs, note);
    for (const path of resolved.localPaths) relevantPaths.add(path);
    currentImagePaths = relevantPaths;
    if (stale()) return { status: 'stale', html: '', issues: [], noteID: sha256(Buffer.from(notePath, 'utf8')), canPublish: false };

    const title = typeof deps.getTitle === 'function' ? safeString(deps.getTitle(note), 200) : safeString(note.basename, 200);
    const candidateUrls = new Set();
    const assetUrls = { ...resolved.assetUrls };
    if (renderBlobs && typeof deps.createObjectURL === 'function') {
      for (const image of resolved.images) {
        try {
          const url = deps.createObjectURL(Buffer.from(image.bytes), image.mime);
          if (typeof url === 'string' && url.startsWith('blob:')) {
            candidateUrls.add(url);
            assetUrls[image.sourcePath] = url;
          } else {
            resolved.issues.push('missing_image');
          }
        } catch {
          resolved.issues.push('missing_image');
        }
      }
    }
    let rendered;
    try { rendered = deps.renderArticle({ source, title, assetUrls }); }
    catch { rendered = { blocked: true, html: '', issues: [] }; }
    const noteID = sha256(Buffer.from(notePath, 'utf8'));
    const contentIssues = [...new Set(resolved.issues)];
    if (rendered?.blocked || typeof rendered?.html !== 'string' || !title) contentIssues.push('invalid_article');
    if (stale()) {
      revoke(candidateUrls);
      return { status: 'stale', html: '', issues: [], noteID, canPublish: false };
    }

    const snapshot = {
      noteID, note, notePath, title, source, settings, key, startRevision,
      images: resolved.images, refs, html: rendered?.html || '', issueCodes: [...new Set(contentIssues)],
    };
    const receiptState = await receiptFor(snapshot);
    if (stale()) {
      revoke(candidateUrls);
      return { status: 'stale', html: '', issues: [], noteID, canPublish: false };
    }
    snapshot.store = receiptState.store;
    snapshot.receipt = receiptState.receipt;

    if (emit) {
      revoke(activeObjectUrls);
      activeObjectUrls = candidateUrls;
      currentImagePaths = relevantPaths;
      const preview = {
        status: snapshot.issueCodes.length ? 'warning' : 'ready',
        html: snapshot.html,
        issues: publicIssues(snapshot.issueCodes),
        noteID,
        canPublish: snapshot.issueCodes.length === 0,
        siteUrl: strictSiteLink(settings.siteUrl)?.value || '',
        publishedLink: snapshot.receipt?.link || '',
        dirty: snapshot.receipt?.dirty === true,
        needsCheck: snapshot.receipt?.needsCheck === true,
      };
      onPreview(preview);
      return preview;
    }
    revoke(candidateUrls);
    return { status: snapshot.issueCodes.length ? 'blocked' : 'ready', issues: publicIssues(snapshot.issueCodes), snapshot };
  }

  async function verifySnapshot(snapshot) {
    if (!snapshot || snapshot.issueCodes.length || !isSelected(snapshot.note, snapshot.notePath, snapshot.startRevision, snapshot.key)) return false;
    try {
      const source = await loadSource(snapshot.note);
      if (source !== snapshot.source) return false;
      for (const image of snapshot.images) {
        const stat = fileStat(image.file);
        if (!stat || stat.size !== image.stat.size || stat.mtime !== image.stat.mtime) return false;
        const bytes = asBytes(await deps.readBinary(image.file));
        if (!bytes || bytes.byteLength !== image.bytes.byteLength || sha256(bytes) !== image.hash) return false;
      }
      return isSelected(snapshot.note, snapshot.notePath, snapshot.startRevision, snapshot.key);
    } catch {
      return false;
    }
  }

  function runtimeFor(settings) {
    const key = settingsKey(settings);
    if (runtime && runtime.key === key && !runtime.abortController.signal.aborted) return runtime;
    let secret;
    try { secret = settings.secretRef ? deps.getSecret(settings.secretRef) : null; } catch { secret = null; }
    if (typeof secret !== 'string' || !secret) return { error: 'secret_missing' };
    let store;
    try { store = deps.getStore(settings); } catch { store = null; }
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') return { error: 'store_unavailable' };
    const abortController = new AbortController();
    try {
      const client = deps.createClient({ siteUrl: settings.siteUrl, username: settings.username, secret, signal: abortController.signal });
      const publisher = deps.createPublisher({ client, store, siteUrl: settings.siteUrl });
      if (!publisher || typeof publisher.publish !== 'function' || typeof publisher.checkStatus !== 'function') throw new Error('invalid_publisher');
      runtime = { key, abortController, publisher, store };
      return runtime;
    } catch {
      abortController.abort();
      return { error: 'settings_missing' };
    }
  }

  async function exclusive(task) {
    if (actionBusy) return { status: 'blocked', reason: 'busy', message: issueMessage('busy') };
    actionBusy = true;
    onAction({ busy: true });
    try { return await task(); }
    finally {
      actionBusy = false;
      onAction({ busy: false });
    }
  }

  async function testConnection() {
    if (disposed) return { status: 'blocked', reason: 'disposed' };
    const settings = currentSettings();
    if (!settings.siteUrl || !settings.username || !settings.secretRef) return { status: 'blocked', reason: 'settings_missing', message: issueMessage('settings_missing') };
    let secret;
    try { secret = deps.getSecret(settings.secretRef); } catch { secret = null; }
    if (typeof secret !== 'string' || !secret) return { status: 'blocked', reason: 'secret_missing', message: issueMessage('secret_missing') };
    const controller = new AbortController();
    const startRevision = revision;
    const key = settingsKey(settings);
    connectionControllers.add(controller);
    try {
      const client = deps.createClient({ siteUrl: settings.siteUrl, username: settings.username, secret, signal: controller.signal });
      if (!client || typeof client.probe !== 'function') throw new Error('invalid_client');
      await client.probe();
      if (disposed || revision !== startRevision || settingsKey(currentSettings()) !== key || controller.signal.aborted) {
        return { status: 'blocked', reason: 'input_changed', message: issueMessage('input_changed') };
      }
      return { status: 'connected' };
    } catch {
      return { status: 'blocked', reason: 'connection_failed', message: issueMessage('connection_failed') };
    } finally {
      connectionControllers.delete(controller);
    }
  }

  async function publish() {
    return exclusive(async () => {
      if (disposed) return { status: 'blocked', reason: 'disposed' };
      const result = await collect();
      if (result.status !== 'ready') return { status: 'blocked', reason: result.issues?.[0]?.code || 'invalid_article', message: issueMessage(result.issues?.[0]?.code || 'invalid_article') };
      const snapshot = result.snapshot;
      const settings = snapshot.settings;
      if (!settings.siteUrl || !settings.username || !settings.secretRef) return { status: 'blocked', reason: 'settings_missing', message: issueMessage('settings_missing') };
      const activeRuntime = runtimeFor(settings);
      if (activeRuntime.error) return { status: 'blocked', reason: activeRuntime.error, message: issueMessage(activeRuntime.error) };
      const plan = {
        noteID: snapshot.noteID,
        title: snapshot.title,
        source: snapshot.source,
        images: snapshot.images.map(({ sourcePath, bytes, mime }) => ({ sourcePath, bytes: Buffer.from(bytes), mime })),
        isCurrent: () => verifySnapshot(snapshot),
      };
      if (!await plan.isCurrent()) return { status: 'blocked', reason: 'input_changed', message: issueMessage('input_changed') };
      let response;
      try { response = await activeRuntime.publisher.publish(plan); }
      catch { response = { status: 'blocked', reason: 'publish_failed' }; }
      if (!await verifySnapshot(snapshot)) return { status: 'blocked', reason: 'input_changed', message: issueMessage('input_changed') };
      onAction({ busy: true, result: response, siteUrl: strictSiteLink(settings.siteUrl)?.value || '' });
      return { ...response, message: issueMessage(response?.status === 'needs-check' ? 'needs_check' : response?.status === 'conflict' ? 'conflict' : response?.status === 'published' ? 'published' : 'publish_failed') };
    });
  }

  async function checkStatus() {
    return exclusive(async () => {
      if (disposed) return { status: 'blocked', reason: 'disposed' };
      const result = await collect();
      if (result.status !== 'ready') return { status: 'needs-check', reason: result.issues?.[0]?.code || 'invalid_article', message: issueMessage('needs_check') };
      const snapshot = result.snapshot;
      const settings = snapshot.settings;
      if (!settings.siteUrl || !settings.username || !settings.secretRef) return { status: 'needs-check', reason: 'settings_missing', message: issueMessage('needs_check') };
      const activeRuntime = runtimeFor(settings);
      if (activeRuntime.error) return { status: 'needs-check', reason: activeRuntime.error, message: issueMessage('needs_check') };
      const plan = {
        noteID: snapshot.noteID,
        title: snapshot.title,
        source: snapshot.source,
        images: snapshot.images.map(({ sourcePath, bytes, mime }) => ({ sourcePath, bytes: Buffer.from(bytes), mime })),
        isCurrent: () => verifySnapshot(snapshot),
      };
      if (!await plan.isCurrent()) return { status: 'needs-check', reason: 'input_changed', message: issueMessage('needs_check') };
      let response;
      try { response = await activeRuntime.publisher.checkStatus(snapshot.noteID, plan); }
      catch { response = { status: 'needs-check', reason: 'check_failed' }; }
      if (!await verifySnapshot(snapshot)) return { status: 'needs-check', reason: 'input_changed', message: issueMessage('needs_check') };
      onAction({ busy: true, result: response, siteUrl: strictSiteLink(settings.siteUrl)?.value || '' });
      return { ...response, message: issueMessage(response?.status === 'published' ? 'published' : response?.status === 'conflict' ? 'conflict' : 'needs_check') };
    });
  }

  async function refresh() {
    if (disposed) return { status: 'stale', html: '', issues: [], canPublish: false };
    const startRevision = revision;
    const renderID = renderSequence + 1;
    const preview = await collect({ renderBlobs: true, emit: true });
    if (!disposed && revision === startRevision && renderSequence === renderID
        && !['ready', 'warning', 'stale'].includes(preview.status)) {
      revoke(activeObjectUrls);
      activeObjectUrls = new Set();
      onPreview({ ...preview, html: '', canPublish: false, publishedLink: '', needsCheck: false,
        siteUrl: strictSiteLink(currentSettings().siteUrl)?.value || '' });
    }
    return preview;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    revision += 1;
    renderSequence += 1;
    abortWork();
    revoke(activeObjectUrls);
    activeObjectUrls = new Set();
    currentImagePaths.clear();
  }

  return { refresh, publish, checkStatus, testConnection, invalidate, setSettings, dispose };
}

module.exports = { createHostController, sanitizeSettings, issueMessage };
