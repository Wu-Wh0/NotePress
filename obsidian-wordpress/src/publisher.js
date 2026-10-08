'use strict';

const crypto = require('node:crypto');
const { extractImageReferences, renderArticle } = require('./article');

const SCHEMA = 1;
const MIME_EXTENSIONS = new Map([
  ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'],
  ['image/webp', 'webp'], ['image/avif', 'avif'], ['image/bmp', 'bmp'],
]);
const STABLE_STAGES = new Set([
  'creating', 'draft-created', 'uploading-media', 'media-uploaded',
  'updating-draft', 'publishing', 'updating-post', 'completed',
]);

function publisherError(code) {
  const error = new Error(code);
  error.name = 'PublisherError';
  error.code = code;
  return error;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function digestObject(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

function safeSite(siteUrl) {
  if (typeof siteUrl !== 'string' || !siteUrl || /[\u0000-\u0020\u007f\\]/u.test(siteUrl)
      || siteUrl.includes('?') || siteUrl.includes('#') || /^https:\/\/[^/]*@/iu.test(siteUrl)) {
    throw publisherError('INVALID_SITE_URL');
  }
  let parsed;
  try { parsed = new URL(siteUrl); } catch { throw publisherError('INVALID_SITE_URL'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw publisherError('INVALID_SITE_URL');
  }
  let path;
  try { path = decodeURIComponent(parsed.pathname); } catch { throw publisherError('INVALID_SITE_URL'); }
  if (/[\u0000-\u001f\u007f\\]/u.test(path)) throw publisherError('INVALID_SITE_URL');
  return { value: siteUrl, origin: parsed.origin };
}

function safeHttpsUrl(value, expectedOrigin, postID) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\u0000-\u0020\u007f\\]/u.test(value)
      || /^https:\/\/[^/]*@/iu.test(value)) return false;
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  // Native plain permalinks, including drafts, use ?p=<post ID>.
  const query = [...parsed.searchParams];
  const nativePostQuery = Number.isSafeInteger(postID) && postID > 0 && query.length === 1
    && query[0][0] === 'p' && query[0][1] === String(postID);
  return parsed.protocol === 'https:' && !!parsed.hostname && !parsed.username && !parsed.password
    && (!parsed.search || nativePostQuery) && !parsed.hash && parsed.origin === expectedOrigin;
}

function validNoteID(noteID) {
  return typeof noteID === 'string' && noteID.length > 0 && noteID.length <= 200
    && !/[\u0000-\u001f\u007f\\/]/u.test(noteID);
}

function clone(value) {
  return structuredClone(value);
}

function result(status, fields = {}) {
  return { status, ...fields };
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || !validNoteID(plan.noteID)
      || typeof plan.title !== 'string' || typeof plan.source !== 'string' || !Array.isArray(plan.images)) {
    throw publisherError('INVALID_PLAN');
  }
  if (plan.isCurrent !== undefined && typeof plan.isCurrent !== 'function') throw publisherError('INVALID_PLAN');
  let refs;
  try { refs = extractImageReferences(plan.source); }
  catch (error) {
    const code = typeof error?.message === 'string' && /^[a-z0-9_]{1,80}$/iu.test(error.message)
      ? error.message : 'ARTICLE_BLOCKED';
    throw publisherError(code);
  }
  const imageByPath = new Map();
  for (const image of plan.images) {
    if (!image || typeof image !== 'object' || Array.isArray(image)
        || Object.keys(image).some((key) => !['sourcePath', 'bytes', 'mime'].includes(key))
        || typeof image.sourcePath !== 'string' || !image.sourcePath || image.sourcePath.length > 4096
        || !(Buffer.isBuffer(image.bytes) || image.bytes instanceof Uint8Array)
        || image.bytes.byteLength < 1 || typeof image.mime !== 'string'
        || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(image.mime)
        || !MIME_EXTENSIONS.has(image.mime)) {
      throw publisherError('UNSUPPORTED_IMAGE');
    }
    if (imageByPath.has(image.sourcePath)) throw publisherError('DUPLICATE_IMAGE');
    imageByPath.set(image.sourcePath, {
      sourcePath: image.sourcePath,
      bytes: Buffer.from(image.bytes),
      mime: image.mime,
    });
  }
  const refsByPath = new Map(refs.map((ref) => [ref.sourcePath, ref]));
  for (const ref of refs) {
    if (!imageByPath.has(ref.sourcePath)) {
      throw publisherError(ref.kind === 'remote' ? 'UNMAPPED_REMOTE_IMAGE' : 'MISSING_IMAGE');
    }
  }
  for (const sourcePath of imageByPath.keys()) if (!refsByPath.has(sourcePath)) throw publisherError('UNREFERENCED_IMAGE');

  // A placeholder render validates title/source safety before any remote write.
  const placeholders = Object.fromEntries(refs.map((ref, index) => [ref.sourcePath, `https://preflight.invalid/${index}`]));
  let preflight;
  try { preflight = renderArticle({ source: plan.source, title: plan.title, assetUrls: placeholders }); }
  catch (error) {
    const code = typeof error?.message === 'string' && /^[a-z0-9_]{1,80}$/iu.test(error.message)
      ? error.message : 'ARTICLE_BLOCKED';
    throw publisherError(code);
  }
  if (preflight.blocked || typeof preflight.bodyHtml !== 'string') throw publisherError('ARTICLE_BLOCKED');

  const images = refs.map((ref) => {
    const input = imageByPath.get(ref.sourcePath);
    const contentHash = sha256(input.bytes);
    const referenceHash = sha256(Buffer.from(ref.sourcePath, 'utf8'));
    const assetHash = digestObject({ contentHash, mime: input.mime });
    return {
      sourcePath: ref.sourcePath,
      kind: ref.kind,
      referenceHash,
      contentHash,
      assetHash,
      bytes: input.bytes,
      mime: input.mime,
      filename: `${contentHash}.${MIME_EXTENSIONS.get(input.mime)}`,
    };
  });
  return {
    noteID: plan.noteID,
    title: plan.title,
    source: plan.source,
    images,
    refs,
    isCurrent: plan.isCurrent,
    sourceHash: sha256(Buffer.from(plan.source, 'utf8')),
    titleHash: sha256(Buffer.from(plan.title, 'utf8')),
  };
}

function planHash(prepared, siteUrl, ownerID) {
  return digestObject({
    schema: SCHEMA,
    noteID: prepared.noteID,
    siteUrl,
    ownerID,
    sourceHash: prepared.sourceHash,
    titleHash: prepared.titleHash,
    images: prepared.images.map(({ referenceHash, assetHash }) => ({ referenceHash, assetHash })),
  });
}

function newJournal(prepared, siteUrl, ownerID, hash, stage) {
  return {
    schema: SCHEMA,
    noteID: prepared.noteID,
    siteUrl,
    ownerID,
    planHash: hash,
    sourceHash: prepared.sourceHash,
    titleHash: prepared.titleHash,
    stage,
    media: [],
  };
}

function remoteSnapshot(post, ownerID, origin, expectedID) {
  if (!post || !Number.isSafeInteger(post.id) || post.id < 1
      || post.id !== expectedID
      || !Number.isSafeInteger(post.author) || post.author !== ownerID
      || typeof post.status !== 'string' || typeof post.title?.raw !== 'string'
      || typeof post.content?.raw !== 'string' || !safeHttpsUrl(post.link, origin, expectedID)) return null;
  const values = {
    id: post.id,
    author: post.author,
    status: post.status,
    title: post.title.raw,
    content: post.content.raw,
    link: post.link,
  };
  return { ...values, hash: digestObject(values) };
}

function validJournal(record, noteID, siteUrl) {
  return !!record && typeof record === 'object' && !Array.isArray(record)
    && record.schema === SCHEMA && record.noteID === noteID && record.siteUrl === siteUrl
    && Number.isSafeInteger(record.ownerID) && record.ownerID > 0
    && typeof record.planHash === 'string' && /^[a-f0-9]{64}$/u.test(record.planHash)
    && STABLE_STAGES.has(record.stage) && Array.isArray(record.media)
    && record.media.every((item) => item && /^[a-f0-9]{64}$/u.test(item.referenceHash)
      && /^[a-f0-9]{64}$/u.test(item.assetHash) && Number.isSafeInteger(item.id) && item.id > 0
      && typeof item.url === 'string');
}

function createPublisher({ client, store, siteUrl } = {}) {
  if (!client || typeof client.probe !== 'function' || typeof client.getPost !== 'function'
      || typeof client.createPost !== 'function' || typeof client.updatePost !== 'function'
      || typeof client.uploadMedia !== 'function' || !store
      || typeof store.load !== 'function' || typeof store.save !== 'function') {
    throw publisherError('INVALID_DEPENDENCIES');
  }
  const site = safeSite(siteUrl);
  const locks = new Map();

  function serialize(noteID, task) {
    const previous = locks.get(noteID) || Promise.resolve();
    const currentPromise = previous.catch(() => {}).then(task);
    locks.set(noteID, currentPromise);
    return currentPromise.finally(() => { if (locks.get(noteID) === currentPromise) locks.delete(noteID); });
  }

  async function current(plan) {
    if (!plan.isCurrent) return true;
    try { return await plan.isCurrent() === true; } catch { return false; }
  }

  async function saveJournal(record) {
    try {
      await store.save(record.noteID, clone(record));
      return true;
    } catch {
      return false;
    }
  }

  function pending(record, reason = 'operation-uncertain') {
    return result('needs-check', { ...(Number.isSafeInteger(record?.postID) ? { postID: record.postID } : {}), reason });
  }

  function buildAssetUrls(prepared, record) {
    const urls = {};
    for (const image of prepared.images) {
      const media = record.media.find((item) => item.referenceHash === image.referenceHash
        && item.assetHash === image.assetHash && safeHttpsUrl(item.url, site.origin));
      if (!media) return null;
      urls[image.sourcePath] = media.url;
    }
    return urls;
  }

  function render(prepared, record) {
    const assetUrls = buildAssetUrls(prepared, record);
    if (!assetUrls) return null;
    const rendered = renderArticle({ source: prepared.source, title: prepared.title, assetUrls });
    return rendered.blocked || typeof rendered.bodyHtml !== 'string' ? null : rendered.bodyHtml;
  }

  async function ensureMedia(prepared, record) {
    for (const image of prepared.images) {
      const prior = record.media.find((item) => item.assetHash === image.assetHash
        && safeHttpsUrl(item.url, site.origin));
      if (prior) {
        if (!record.media.some((item) => item.referenceHash === image.referenceHash && item.assetHash === image.assetHash)) {
          record.media.push({ referenceHash: image.referenceHash, assetHash: image.assetHash, id: prior.id, url: prior.url });
        }
        continue;
      }
      if (!await current(prepared)) return { status: 'blocked', reason: 'input-changed' };
      const beforeUpload = { ...record, stage: 'uploading-media', inFlightAssetHash: image.assetHash };
      if (!await saveJournal(beforeUpload)) return { status: 'blocked', reason: 'journal-unavailable' };
      Object.assign(record, beforeUpload);
      if (!await current(prepared)) return { status: 'blocked', reason: 'input-changed' };
      let media;
      try { media = await client.uploadMedia(image.bytes, image.mime, image.filename); }
      catch { return { status: 'needs-check', reason: 'media-write-uncertain' }; }
      if (!Number.isSafeInteger(media?.id) || media.id < 1 || media.author !== record.ownerID
          || media.mime_type !== image.mime || !safeHttpsUrl(media.source_url, site.origin)) {
        return { status: 'needs-check', reason: 'media-readback-invalid' };
      }
      record.media.push({ referenceHash: image.referenceHash, assetHash: image.assetHash, id: media.id, url: media.source_url });
      record.stage = 'media-uploaded';
      delete record.inFlightAssetHash;
      if (!await saveJournal(record)) return { status: 'needs-check', reason: 'journal-unavailable', postID: record.postID };
    }
    return { status: 'ready' };
  }

  async function readAndVerify(record, prepared, expectedStatus) {
    let post;
    try { post = await client.getPost(record.postID); } catch { return null; }
    const snapshot = remoteSnapshot(post, record.ownerID, site.origin, record.postID);
    const bodyHtml = render(prepared, record);
    if (!snapshot || !bodyHtml || snapshot.status !== expectedStatus
        || snapshot.title !== prepared.title || snapshot.content !== bodyHtml) return null;
    return { post, snapshot, bodyHtml };
  }

  async function publishNew(prepared, record) {
    if (!await current(prepared)) return result('blocked', { reason: 'input-changed' });
    let created;
    try { created = await client.createPost({ title: prepared.title, content: '', status: 'draft' }); }
    catch { return pending(record, 'create-write-uncertain'); }
    if (!Number.isSafeInteger(created?.id) || created.id < 1) return pending(record, 'create-acknowledgement-invalid');
    record.postID = created.id;
    record.stage = 'draft-created';
    if (!await saveJournal(record)) return pending(record, 'journal-unavailable');

    let initial;
    try { initial = await client.getPost(record.postID); }
    catch { return pending(record, 'created-draft-readback-unavailable'); }
    const initialSnapshot = remoteSnapshot(initial, record.ownerID, site.origin, record.postID);
    if (!initialSnapshot || initialSnapshot.status !== 'draft' || initialSnapshot.title !== prepared.title
        || initialSnapshot.content !== '') return pending(record, 'created-draft-readback-mismatch');

    const uploaded = await ensureMedia(prepared, record);
    if (uploaded.status !== 'ready') return result(uploaded.status, { postID: record.postID, reason: uploaded.reason });
    const bodyHtml = render(prepared, record);
    if (bodyHtml === null) return result('draft', { postID: record.postID, reason: 'render-blocked' });

    record.stage = 'updating-draft';
    record.expectedBodyHash = sha256(Buffer.from(bodyHtml, 'utf8'));
    if (!await saveJournal(record)) return pending(record, 'journal-unavailable');
    if (!await current(prepared)) return result('draft', { postID: record.postID, reason: 'input-changed' });
    try { await client.updatePost(record.postID, { title: prepared.title, content: bodyHtml, status: 'draft' }); }
    catch { return pending(record, 'draft-write-uncertain'); }

    const draft = await readAndVerify(record, prepared, 'draft');
    if (!draft) return result('draft', { postID: record.postID, reason: 'draft-readback-mismatch' });

    record.stage = 'publishing';
    if (!await saveJournal(record)) return result('draft', { postID: record.postID, reason: 'journal-unavailable' });
    if (!await current(prepared)) return result('draft', { postID: record.postID, reason: 'input-changed' });
    try { await client.updatePost(record.postID, { status: 'publish' }); }
    catch { return pending(record, 'publish-write-uncertain'); }

    const published = await readAndVerify(record, prepared, 'publish');
    if (!published) return pending(record, 'publish-readback-mismatch');
    record.stage = 'completed';
    record.link = published.snapshot.link;
    record.remoteHash = published.snapshot.hash;
    delete record.expectedBodyHash;
    if (!await saveJournal(record)) return pending(record, 'journal-unavailable');
    return result('published', { postID: record.postID, link: record.link });
  }

  async function publishUpdate(prepared, record) {
    let before;
    try { before = await client.getPost(record.postID); } catch { return result('needs-check', { postID: record.postID, reason: 'baseline-unavailable' }); }
    const baseline = remoteSnapshot(before, record.ownerID, site.origin, record.postID);
    if (!baseline || baseline.status !== 'publish' || baseline.hash !== record.remoteHash) {
      return result('conflict', { postID: record.postID, reason: 'remote-baseline-changed' });
    }
    if (record.planHash === prepared.planHash) return result('published', { postID: record.postID, link: baseline.link });
    if (!await current(prepared)) return result('blocked', { postID: record.postID, reason: 'input-changed' });

    const previousReceipt = clone(record);
    async function stopBeforePostWrite(reason) {
      // Only call while the article update has definitely not been invoked.
      // Keep acknowledged media; this is a local journal restoration, not a
      // rollback or deletion of any remote resource.
      const restored = { ...previousReceipt, media: clone(record.media) };
      if (!await saveJournal(restored)) return pending(record, 'journal-unavailable');
      return result('blocked', { postID: record.postID, reason });
    }

    const next = {
      ...record,
      previousReceipt,
      planHash: prepared.planHash,
      sourceHash: prepared.sourceHash,
      titleHash: prepared.titleHash,
      stage: 'updating-post',
    };
    if (!await saveJournal(next)) return stopBeforePostWrite('journal-unavailable');
    Object.assign(record, next);

    const uploaded = await ensureMedia(prepared, record);
    if (uploaded.status === 'blocked') return stopBeforePostWrite(uploaded.reason);
    if (uploaded.status !== 'ready') return result(uploaded.status, { postID: record.postID, reason: uploaded.reason });
    const bodyHtml = render(prepared, record);
    if (bodyHtml === null) return stopBeforePostWrite('render-blocked');
    record.expectedBodyHash = sha256(Buffer.from(bodyHtml, 'utf8'));
    record.stage = 'updating-post';
    if (!await saveJournal(record)) return stopBeforePostWrite('journal-unavailable');
    if (!await current(prepared)) return stopBeforePostWrite('input-changed');
    try { await client.updatePost(record.postID, { title: prepared.title, content: bodyHtml }); }
    catch { return pending(record, 'post-update-uncertain'); }

    const published = await readAndVerify(record, prepared, 'publish');
    if (!published) return pending(record, 'post-update-readback-mismatch');
    record.stage = 'completed';
    record.link = published.snapshot.link;
    record.remoteHash = published.snapshot.hash;
    delete record.expectedBodyHash;
    delete record.previousReceipt;
    if (!await saveJournal(record)) return pending(record, 'journal-unavailable');
    return result('published', { postID: record.postID, link: record.link });
  }

  async function prepareFor(plan) {
    let prepared;
    try { prepared = validatePlan(plan); } catch (error) { return { error }; }
    let identity;
    try { identity = await client.probe(); } catch { return { error: publisherError('PROBE_FAILED') }; }
    if (!Number.isSafeInteger(identity?.ownerID) || identity.ownerID < 1) return { error: publisherError('INVALID_OWNER') };
    if (identity?.capabilities?.publish_posts !== true || identity?.capabilities?.upload_files !== true) {
      return { error: publisherError('missing-capability') };
    }
    prepared.ownerID = identity.ownerID;
    prepared.planHash = planHash(prepared, site.value, identity.ownerID);
    return { prepared, identity };
  }

  async function publish(plan) {
    if (!validNoteID(plan?.noteID)) return result('blocked', { reason: 'invalid-plan' });
    return serialize(plan.noteID, async () => {
      const ready = await prepareFor(plan);
      if (ready.error) return result('blocked', { reason: ready.error.code });
      const prepared = ready.prepared;
      if (!await current(prepared)) return result('blocked', { reason: 'input-changed' });
      let existing;
      try { existing = await store.load(prepared.noteID); } catch { return result('blocked', { reason: 'journal-unavailable' }); }
      if (existing !== null && existing !== undefined) {
        if (!validJournal(existing, prepared.noteID, site.value) || existing.ownerID !== prepared.ownerID) {
          return result('blocked', { reason: 'journal-binding-mismatch' });
        }
        if (existing.stage !== 'completed') return pending(existing, 'pending-operation');
        return publishUpdate(prepared, clone(existing));
      }
      const record = newJournal(prepared, site.value, prepared.ownerID, prepared.planHash, 'creating');
      if (!await saveJournal(record)) return result('blocked', { reason: 'journal-unavailable' });
      if (!await current(prepared)) return result('blocked', { reason: 'input-changed' });
      return publishNew(prepared, record);
    });
  }

  async function checkStatus(noteID, plan) {
    if (!validNoteID(noteID)) return result('blocked', { reason: 'invalid-note-id' });
    return serialize(noteID, async () => {
      let record;
      try { record = await store.load(noteID); } catch { return result('needs-check', { reason: 'journal-unavailable' }); }
      if (!record || !Number.isSafeInteger(record.postID)) return result('needs-check');
      if (!validJournal(record, noteID, site.value) || record.ownerID < 1) return result('needs-check', { postID: record.postID, reason: 'journal-invalid' });
      if (!plan || plan.noteID !== noteID) return result('needs-check', { postID: record.postID, reason: 'plan-required' });
      const ready = await prepareFor(plan);
      if (ready.error || ready.prepared.planHash !== record.planHash || ready.prepared.ownerID !== record.ownerID) {
        return result('needs-check', { postID: record.postID, reason: 'plan-binding-mismatch' });
      }
      const bodyHtml = render(ready.prepared, record);
      if (bodyHtml === null || record.expectedBodyHash !== sha256(Buffer.from(bodyHtml, 'utf8'))) {
        return result('needs-check', { postID: record.postID, reason: 'expected-content-unavailable' });
      }
      const status = record.stage === 'updating-draft' ? 'draft' : 'publish';
      let post;
      try { post = await client.getPost(record.postID); } catch { return result('needs-check', { postID: record.postID, reason: 'readback-unavailable' }); }
      const snapshot = remoteSnapshot(post, record.ownerID, site.origin, record.postID);
      if (!snapshot || snapshot.title !== ready.prepared.title || snapshot.content !== bodyHtml) {
        return result('needs-check', { postID: record.postID, reason: 'readback-mismatch' });
      }
      if (snapshot.status !== status) return result(snapshot.status === 'draft' ? 'draft' : 'needs-check', { postID: record.postID, link: snapshot.link });
      if (status !== 'publish') return result('draft', { postID: record.postID });
      record.stage = 'completed';
      record.link = snapshot.link;
      record.remoteHash = snapshot.hash;
      delete record.expectedBodyHash;
      delete record.previousReceipt;
      if (!await saveJournal(record)) return result('needs-check', { postID: record.postID, reason: 'journal-unavailable' });
      return result('published', { postID: record.postID, link: record.link });
    });
  }

  return { publish, checkStatus };
}

module.exports = { createPublisher };
