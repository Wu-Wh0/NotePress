'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const path = require('node:path');

const ANCHOR = /^obsidian-create-[a-f0-9]{32}$/u;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_MEDIA_ITEMS = 256;
const HASH = /^[a-f0-9]{64}$/u;
const STAGES = new Set([
  'creating', 'draft-created', 'uploading-media', 'media-uploaded',
  'updating-draft', 'publishing', 'updating-post', 'completed',
]);
const BASE_FIELDS = [
  'schema', 'noteID', 'siteUrl', 'ownerID', 'planHash', 'sourceHash',
  'titleHash', 'stage', 'media',
];
const OPTIONAL_FIELDS = [
  'postID', 'link', 'remoteHash', 'expectedBodyHash',
  'inFlightAssetHash', 'previousReceipt', 'draftRemoteHash', 'createAnchor',
  'createAmbiguous', 'createLookupPending',
];
const MEDIA_FIELDS = ['referenceHash', 'assetHash', 'id', 'url'];
const BASE_SET = new Set(BASE_FIELDS);
const OPTIONAL_SET = new Set(OPTIONAL_FIELDS);
const MEDIA_SET = new Set(MEDIA_FIELDS);
const locks = new Map();

function fail(code) {
  const error = new Error(code);
  error.name = 'JournalStoreError';
  error.code = code;
  return error;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validNoteID(noteID) {
  return typeof noteID === 'string' && noteID.length > 0 && noteID.length <= 200
    && !/[\u0000-\u001f\u007f\\/]/u.test(noteID);
}

function checkedSiteUrl(siteUrl) {
  if (typeof siteUrl !== 'string' || siteUrl.length < 1 || siteUrl.length > 2048
      || /[\u0000-\u0020\u007f\\]/u.test(siteUrl) || siteUrl.includes('?') || siteUrl.includes('#')
      || /^https:\/\/[^/]*@/iu.test(siteUrl)) throw fail('INVALID_SITE_URL');
  let parsed;
  try { parsed = new URL(siteUrl); } catch { throw fail('INVALID_SITE_URL'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password
      || parsed.search || parsed.hash) throw fail('INVALID_SITE_URL');
  return { value: siteUrl, origin: parsed.origin };
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => typeof key === 'string'
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && !Object.getOwnPropertyDescriptor(value, key)?.get
    && !Object.getOwnPropertyDescriptor(value, key)?.set);
}

function hasExactFields(value, required, optional = []) {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function validUrl(value, origin, postID = null) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096
      || /[\u0000-\u0020\u007f\\]/u.test(value) || /^https:\/\/[^/]*@/iu.test(value)) return false;
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  const query = [...parsed.searchParams];
  const plainPostLink = Number.isSafeInteger(postID) && postID > 0 && query.length === 1
    && query[0][0] === 'p' && query[0][1] === String(postID);
  return parsed.protocol === 'https:' && !!parsed.hostname && !parsed.username && !parsed.password
    && parsed.origin === origin && (!parsed.search || plainPostLink) && !parsed.hash;
}

function validMedia(media, origin) {
  return Array.isArray(media) && media.length <= MAX_MEDIA_ITEMS && media.every((item) => {
    if (!hasExactFields(item, MEDIA_FIELDS)) return false;
    return HASH.test(item.referenceHash) && HASH.test(item.assetHash)
      && Number.isSafeInteger(item.id) && item.id > 0 && validUrl(item.url, origin);
  });
}

function validRecord(record, expectedNoteID, site, allowPreviousReceipt = true) {
  if (!hasExactFields(record, BASE_FIELDS, OPTIONAL_FIELDS)) return false;
  if (![1, 2].includes(record.schema) || (record.schema === 2 ? !ANCHOR.test(record.createAnchor) : Object.hasOwn(record, 'createAnchor'))
      || record.noteID !== expectedNoteID || record.siteUrl !== site.value
      || !validNoteID(record.noteID) || !Number.isSafeInteger(record.ownerID) || record.ownerID < 1
      || !HASH.test(record.planHash) || !HASH.test(record.sourceHash) || !HASH.test(record.titleHash)
      || !STAGES.has(record.stage) || !validMedia(record.media, site.origin)) return false;

  const hasPostID = Object.hasOwn(record, 'postID');
  if (hasPostID && (!Number.isSafeInteger(record.postID) || record.postID < 1)) return false;
  if (record.stage === 'creating') {
    if (hasPostID || record.media.length !== 0) return false;
  } else if (!hasPostID) return false;
  if (Object.hasOwn(record, 'createAmbiguous')
      && (record.schema !== 2 || record.stage !== 'creating' || record.createAmbiguous !== true)) return false;
  if (Object.hasOwn(record, 'createLookupPending')
      && (record.schema !== 2 || record.stage !== 'creating' || record.createLookupPending !== true)) return false;
  if (record.createAmbiguous === true && record.createLookupPending === true) return false;

  const hasLink = Object.hasOwn(record, 'link');
  const hasRemoteHash = Object.hasOwn(record, 'remoteHash');
  if (hasLink !== hasRemoteHash) return false;
  if (hasLink && (!hasPostID || !validUrl(record.link, site.origin, record.postID) || !HASH.test(record.remoteHash))) return false;
  if (record.stage === 'completed' && (!hasPostID || !hasLink || !hasRemoteHash)) return false;
  if (record.stage !== 'completed' && hasLink && !hasRemoteHash) return false;

  if (Object.hasOwn(record, 'expectedBodyHash')) {
    if (!['updating-draft', 'publishing', 'updating-post'].includes(record.stage)
        || !HASH.test(record.expectedBodyHash)) return false;
  }
  if (Object.hasOwn(record, 'draftRemoteHash')
      && (!['draft-created', 'updating-draft'].includes(record.stage) || !HASH.test(record.draftRemoteHash))) return false;
  const hasFlight = Object.hasOwn(record, 'inFlightAssetHash');
  if (record.stage === 'uploading-media') {
    if (!hasFlight || !HASH.test(record.inFlightAssetHash)) return false;
  } else if (hasFlight) return false;

  const hasPrevious = Object.hasOwn(record, 'previousReceipt');
  if (!allowPreviousReceipt && hasPrevious) return false;
  if (record.stage === 'updating-post' && !hasPrevious) return false;
  if (hasPrevious) {
    if (!['updating-post', 'uploading-media', 'media-uploaded'].includes(record.stage)
        || !isPlainRecord(record.previousReceipt)
        || record.previousReceipt.stage !== 'completed'
        || record.previousReceipt.noteID !== record.noteID
        || record.previousReceipt.siteUrl !== record.siteUrl
        || record.previousReceipt.ownerID !== record.ownerID
        || record.previousReceipt.postID !== record.postID
        || record.previousReceipt.schema !== record.schema
        || record.previousReceipt.createAnchor !== record.createAnchor
        || !validRecord(record.previousReceipt, expectedNoteID, site, false)) return false;
  }
  if (record.stage === 'completed' && hasPrevious) return false;
  return true;
}

function serialize(key, task) {
  const previous = locks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  locks.set(key, current);
  return current.finally(() => {
    if (locks.get(key) === current) locks.delete(key);
  });
}

function pathParts(absolutePath) {
  const parsed = path.parse(absolutePath);
  const rest = absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  return { root: parsed.root, rest };
}

async function checkDirectory(directory, create) {
  const { root, rest } = pathParts(directory);
  let current = root;
  const chain = [root];
  for (const part of rest) {
    current = path.join(current, part);
    chain.push(current);
  }
  for (let index = 0; index < chain.length; index += 1) {
    const item = chain[index];
    let info;
    try { info = await fs.lstat(item); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return false;
      try { await fs.mkdir(item); }
      catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw mkdirError;
      }
      info = await fs.lstat(item);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw fail('UNSAFE_DIRECTORY');
  }
  return true;
}

async function readBytes(filePath) {
  const flags = constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0);
  const handle = await fs.open(filePath, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw fail('UNSAFE_JOURNAL_FILE');
    if (info.size > MAX_RECORD_BYTES) throw fail('JOURNAL_TOO_LARGE');
    const chunks = [];
    let total = 0;
    let position = 0;
    while (total <= MAX_RECORD_BYTES) {
      const buffer = Buffer.alloc(Math.min(16 * 1024, MAX_RECORD_BYTES + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
    }
    if (total > MAX_RECORD_BYTES) throw fail('JOURNAL_TOO_LARGE');
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

async function inspectRegularFile(filePath) {
  let info;
  try { info = await fs.lstat(filePath); }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw fail('UNSAFE_JOURNAL_FILE');
  return true;
}

function parseRecord(bytes, noteID, site) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw fail('JOURNAL_CORRUPT'); }
  if (!validRecord(value, noteID, site)) throw fail('JOURNAL_INVALID');
  return value;
}

function createJournalStore({ directory, siteUrl } = {}) {
  if (typeof directory !== 'string' || directory.length === 0) throw fail('INVALID_DIRECTORY');
  const site = checkedSiteUrl(siteUrl);
  const absoluteDirectory = path.resolve(directory);
  const associationPath = path.join(absoluteDirectory, `association-${sha256(Buffer.from(site.value, 'utf8'))}.json`);

  function validIndex(value) {
    if (!hasExactFields(value, ['schema', 'siteUrl', 'entries']) || value.schema !== 1
        || value.siteUrl !== site.value || !isPlainRecord(value.entries)) return false;
    const pairs = Object.entries(value.entries);
    if (pairs.length > 1024) return false;
    const active = new Set();
    const canonical = new Set();
    for (const [key, entry] of pairs) {
      if (!HASH.test(key) || !hasExactFields(entry, ['noteID', 'active'])
          || !HASH.test(entry.noteID) || typeof entry.active !== 'boolean') return false;
      canonical.add(entry.noteID);
      if (entry.active) {
        if (active.has(entry.noteID)) return false;
        active.add(entry.noteID);
      }
    }
    return [...canonical].every(noteID => value.entries[noteID]?.noteID === noteID);
  }

  async function loadIndex() {
    if (!await checkDirectory(absoluteDirectory, false) || !await inspectRegularFile(associationPath)) {
      return { schema: 1, siteUrl: site.value, entries: {} };
    }
    let index;
    try { index = JSON.parse((await readBytes(associationPath)).toString('utf8')); }
    catch { throw fail('ASSOCIATION_CORRUPT'); }
    if (!validIndex(index)) throw fail('ASSOCIATION_INVALID');
    return index;
  }

  async function resolve(pathHash) {
    if (!HASH.test(pathHash)) throw fail('INVALID_NOTE_ID');
    return serialize(associationPath, async () => {
      const index = await loadIndex();
      const entry = index.entries[pathHash];
      if (entry && !entry.active) return { noteID: null, retired: true };
      return { noteID: entry?.noteID || pathHash, retired: false };
    });
  }

  async function changeAssociation(oldHash, newHash, expectedNoteID, expectedDigest, activate, isCurrent) {
    if (![oldHash, newHash, expectedNoteID].every(value => HASH.test(value))
        || (activate && !HASH.test(expectedDigest)) || oldHash === newHash
        || (isCurrent !== undefined && typeof isCurrent !== 'function')) {
      throw fail('ASSOCIATION_INVALID');
    }
    return serialize(associationPath, () => serialize(journalPath(expectedNoteID).filePath, async () => {
      await checkDirectory(absoluteDirectory, true);
      const prior = await loadIndex();
      const source = prior.entries[oldHash];
      const canonical = source?.active ? source.noteID : (source ? null : oldHash);
      const target = prior.entries[newHash];
      if (canonical !== expectedNoteID || (target && target.noteID !== canonical)
          || (target && target.active) || Object.entries(prior.entries).some(([key, entry]) =>
            key !== oldHash && entry.active && entry.noteID === canonical)) throw fail('ASSOCIATION_CONFLICT');
      const sourceRecord = await loadAt(canonical, journalPath(canonical).filePath);
      if (!sourceRecord || (activate && (sourceRecord.stage !== 'completed'
          || sha256(Buffer.from(JSON.stringify(sourceRecord), 'utf8')) !== expectedDigest))) throw fail('ASSOCIATION_STALE');
      if (newHash !== canonical && await loadAt(newHash, journalPath(newHash).filePath)) throw fail('ASSOCIATION_CONFLICT');
      const next = { schema: 1, siteUrl: site.value, entries: {
        ...prior.entries, [oldHash]: { noteID: canonical, active: !activate },
        [newHash]: { noteID: canonical, active: activate },
      } };
      if (!activate && oldHash !== canonical && !prior.entries[canonical]) throw fail('ASSOCIATION_INVALID');
      if (!validIndex(next)) throw fail('ASSOCIATION_INVALID');
      const bytes = Buffer.from(JSON.stringify(next), 'utf8');
      if (bytes.length > MAX_RECORD_BYTES) throw fail('ASSOCIATION_TOO_LARGE');
      const temporary = path.join(absoluteDirectory, `.association-${crypto.randomBytes(12).toString('hex')}.tmp`);
      let handle;
      try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close(); handle = undefined;
        await checkDirectory(absoluteDirectory, false);
        if (!await inspectRegularFile(temporary) || JSON.stringify(await loadIndex()) !== JSON.stringify(prior)) throw fail('ASSOCIATION_RACE');
        const finalRecord = await loadAt(canonical, journalPath(canonical).filePath);
        if (!finalRecord || JSON.stringify(finalRecord) !== JSON.stringify(sourceRecord)
            || (activate && sha256(Buffer.from(JSON.stringify(finalRecord), 'utf8')) !== expectedDigest)) throw fail('ASSOCIATION_STALE');
        if (newHash !== canonical && await loadAt(newHash, journalPath(newHash).filePath)) throw fail('ASSOCIATION_CONFLICT');
        if (isCurrent && await isCurrent() !== true) throw fail('ASSOCIATION_STALE');
        await fs.rename(temporary, associationPath);
      } catch (error) {
        if (handle) try { await handle.close(); } catch { /* preserve error */ }
        try { await fs.unlink(temporary); } catch { /* renamed */ }
        throw error;
      }
      return canonical;
    }));
  }

  async function reserve(oldHash, newHash, expectedNoteID, isCurrent) {
    return changeAssociation(oldHash, newHash, expectedNoteID, null, false, isCurrent);
  }

  async function bind(oldHash, newHash, expectedNoteID, expectedDigest, isCurrent) {
    return changeAssociation(oldHash, newHash, expectedNoteID, expectedDigest, true, isCurrent);
  }

  function journalPath(noteID) {
    if (!validNoteID(noteID)) throw fail('INVALID_NOTE_ID');
    const binding = JSON.stringify([site.value, noteID]);
    const key = sha256(Buffer.from(binding, 'utf8'));
    return { key, filePath: path.join(absoluteDirectory, `journal-${key}.json`) };
  }

  async function loadAt(noteID, filePath) {
    const exists = await inspectRegularFile(filePath);
    if (!exists) return null;
    const bytes = await readBytes(filePath);
    return parseRecord(bytes, noteID, site);
  }

  async function load(noteID) {
    const { key, filePath } = journalPath(noteID);
    return serialize(filePath, async () => {
      if (!await checkDirectory(absoluteDirectory, false)) return null;
      return loadAt(noteID, filePath);
    });
  }

  async function save(noteID, record) {
    const { key, filePath } = journalPath(noteID);
    if (!validRecord(record, noteID, site)) throw fail('JOURNAL_INVALID');
    let serialized;
    try { serialized = Buffer.from(JSON.stringify(record), 'utf8'); }
    catch { throw fail('JOURNAL_INVALID'); }
    if (serialized.length > MAX_RECORD_BYTES) throw fail('JOURNAL_TOO_LARGE');

    return serialize(filePath, async () => {
      await checkDirectory(absoluteDirectory, true);
      const prior = await loadAt(noteID, filePath);
      // A present target must be a valid record for this exact binding. Never
      // turn an unrelated, corrupt, or incompatible file into a journal.
      if (prior !== null && !validRecord(prior, noteID, site)) throw fail('JOURNAL_INVALID');

      const temporary = path.join(absoluteDirectory,
        `.journal-${key}-${crypto.randomBytes(12).toString('hex')}.tmp`);
      let handle;
      try {
        handle = await fs.open(temporary, 'wx', 0o600);
        const tempStat = await handle.stat();
        if (!tempStat.isFile()) throw fail('UNSAFE_JOURNAL_FILE');
        await handle.writeFile(serialized);
        await handle.sync();
        await handle.close();
        handle = undefined;

        await checkDirectory(absoluteDirectory, false);
        if (await inspectRegularFile(temporary) !== true) throw fail('TEMPORARY_FILE_MISSING');
        // Revalidate the old target immediately before replacement. rename is
        // atomic on the same volume, so failures before it leave the old file.
        const current = await loadAt(noteID, filePath);
        if (prior === null && current !== null) throw fail('JOURNAL_RACE');
        if (prior !== null && current === null) throw fail('JOURNAL_RACE');
        if (current !== null && JSON.stringify(current) !== JSON.stringify(prior)) throw fail('JOURNAL_RACE');
        await fs.rename(temporary, filePath);
      } catch (error) {
        if (handle) {
          try { await handle.close(); } catch { /* preserve the original failure */ }
        }
        try { await fs.unlink(temporary); } catch { /* the temp may already be renamed */ }
        throw error;
      }
    });
  }

  return { load, save, resolve, reserve, bind };
}

module.exports = { createJournalStore };
