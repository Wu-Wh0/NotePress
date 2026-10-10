'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { createJournalStore } = require('../src/journal-store');

const SITE = 'https://blog.example';
const HASH = 'a'.repeat(64);
const SCRATCH = process.env.TMPDIR || require('node:os').tmpdir();

async function sandbox(t) {
  const root = await fs.mkdtemp(path.join(SCRATCH, 'journal-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function record(noteID = 'host-path-hash-17', overrides = {}) {
  return {
    schema: 1,
    noteID,
    siteUrl: SITE,
    ownerID: 17,
    planHash: HASH,
    sourceHash: HASH,
    titleHash: HASH,
    stage: 'creating',
    media: [],
    ...overrides,
  };
}

test('real files persist across store instances and serialize concurrent same-key saves', async (t) => {
  const directory = path.join(await sandbox(t), 'plugin-data');
  const first = createJournalStore({ directory, siteUrl: SITE });
  assert.equal(await first.load('host-path-hash-17'), null);

  const writes = Array.from({ length: 20 }, (_, index) => first.save(
    'host-path-hash-17', record('host-path-hash-17', { planHash: index.toString(16).padStart(64, '0') }),
  ));
  await Promise.all(writes);

  const cold = createJournalStore({ directory, siteUrl: SITE });
  assert.deepEqual(await cold.load('host-path-hash-17'), record('host-path-hash-17', {
    planHash: (19).toString(16).padStart(64, '0'),
  }));
  assert.equal(await cold.load('another-host-hash'), null);
});

test('strict schema, site/note binding, bounded records, and corruption fail closed', async (t) => {
  const directory = path.join(await sandbox(t), 'plugin-data');
  const store = createJournalStore({ directory, siteUrl: SITE });
  const good = record();
  await store.save(good.noteID, good);
  const files = await fs.readdir(directory);
  assert.equal(files.length, 1);
  const journalPath = path.join(directory, files[0]);

  await assert.rejects(store.save(good.noteID, { ...good, unexpected: 'not allowed' }));
  await assert.rejects(store.save(good.noteID, { ...good, ownerID: '17' }));
  await assert.rejects(store.save(good.noteID, { ...good, noteID: 'different-note' }));
  await assert.rejects(store.save(good.noteID, { ...good, schema: 2 }));
  await assert.rejects(store.save(good.noteID, { ...good, sourceHash: 'private source text' }));
  await assert.rejects(store.save(good.noteID, { ...good, media: Array(257).fill({
    referenceHash: HASH, assetHash: HASH, id: 1, url: `${SITE}/media/1`,
  }) }));
  const oversizedMedia = Array.from({ length: 68 }, (_, id) => ({
    referenceHash: HASH, assetHash: HASH, id: id + 1, url: `${SITE}/${'x'.repeat(3900)}`,
  }));
  await assert.rejects(store.save(good.noteID, { ...good, stage: 'media-uploaded', postID: 1, media: oversizedMedia }),
    (error) => error.code === 'JOURNAL_TOO_LARGE');
  assert.deepEqual(await store.load(good.noteID), good);

  const mismatchedBinding = { ...good, siteUrl: 'https://other.example' };
  await fs.writeFile(journalPath, JSON.stringify(mismatchedBinding));
  await assert.rejects(store.load(good.noteID));
  await fs.writeFile(journalPath, '{truncated');
  await assert.rejects(store.load(good.noteID));
});

test('schema 2 requires a strict anchor and schema 1 rejects anchor pollution', async (t) => {
  const directory = path.join(await sandbox(t), 'plugin-data');
  const store = createJournalStore({ directory, siteUrl: SITE });
  const anchor = `obsidian-create-${'b'.repeat(32)}`;
  const v2 = record('anchor-note', { schema: 2, createAnchor: anchor });
  await store.save(v2.noteID, v2);
  assert.deepEqual(await store.load(v2.noteID), v2);
  const completed = { ...v2, stage: 'completed', postID: 1, link: `${SITE}/post/1`, remoteHash: HASH };
  await store.save(v2.noteID, completed);
  const updating = { ...completed, stage: 'updating-post', previousReceipt: completed };
  await store.save(v2.noteID, updating);
  await assert.rejects(store.save(v2.noteID, { ...updating,
    previousReceipt: { ...completed, createAnchor: `obsidian-create-${'c'.repeat(32)}` } }));
  await assert.rejects(store.save(v2.noteID, { ...updating,
    previousReceipt: { ...completed, schema: 1, createAnchor: undefined } }));
  for (const bad of [record('anchor-note', { schema: 2 }), record('anchor-note', { createAnchor: anchor }),
    record('anchor-note', { schema: 2, createAnchor: `${anchor}x` }),
    record('anchor-note', { schema: 2, createAnchor: anchor.toUpperCase() })]) {
    await assert.rejects(store.save('anchor-note', bad));
  }
  assert.deepEqual(await store.load(v2.noteID), updating);
});

test('create lookup guard and ambiguity latch are strict, mutually exclusive, and survive cold disk recovery', async (t) => {
  const directory = path.join(await sandbox(t), 'plugin-data');
  const store = createJournalStore({ directory, siteUrl: SITE });
  const anchor = `obsidian-create-${'d'.repeat(32)}`;
  const pending = record('ambiguous-note', { schema: 2, createAnchor: anchor });
  for (const field of ['createAmbiguous', 'createLookupPending']) for (const value of [false, 'true', 1, [], {}])
    await assert.rejects(store.save('ambiguous-note', { ...pending, [field]: value }));
  for (const bad of [
    { ...pending, schema: 1, createAmbiguous: true },
    { ...pending, stage: 'draft-created', postID: 1, createAmbiguous: true },
    { ...pending, postID: 1, createAmbiguous: true },
    { ...pending, schema: 1, createLookupPending: true },
    { ...pending, stage: 'draft-created', postID: 1, createLookupPending: true },
    { ...pending, createAmbiguous: true, createLookupPending: true },
  ]) await assert.rejects(store.save('ambiguous-note', bad));
  await store.save(pending.noteID, { ...pending, createAmbiguous: true });
  assert.deepEqual(await createJournalStore({ directory, siteUrl: SITE }).load(pending.noteID),
    { ...pending, createAmbiguous: true });
  const guarded = { ...pending, createLookupPending: true };
  await store.save(pending.noteID, guarded);
  assert.deepEqual(await createJournalStore({ directory, siteUrl: SITE }).load(pending.noteID), guarded);
});

test('rename failure leaves the last confirmed receipt intact on disk', async (t) => {
  const directory = path.join(await sandbox(t), 'plugin-data');
  const store = createJournalStore({ directory, siteUrl: SITE });
  const prior = record('host-path-hash-17', {
    stage: 'completed', postID: 41, link: `${SITE}/posts/41`, remoteHash: HASH,
  });
  await store.save(prior.noteID, prior);
  const before = await fs.readFile(path.join(directory, (await fs.readdir(directory))[0]));

  const rename = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error('synthetic disk rename failure'), { code: 'EIO' }); };
  try {
    await assert.rejects(store.save(prior.noteID, { ...prior, planHash: 'b'.repeat(64) }));
  } finally {
    fs.rename = rename;
  }

  const after = await fs.readFile(path.join(directory, (await fs.readdir(directory))[0]));
  assert.deepEqual(after, before);
  assert.deepEqual(await createJournalStore({ directory, siteUrl: SITE }).load(prior.noteID), prior);
});

test('symlinked ancestors and journal files are rejected without changing scratch sentinels', async (t) => {
  const root = await sandbox(t);
  const protectedDir = path.join(root, 'protected');
  const sentinel = path.join(protectedDir, 'sentinel.txt');
  await fs.mkdir(protectedDir);
  await fs.writeFile(sentinel, 'synthetic protected bytes');
  const alias = path.join(root, 'alias');
  try {
    await fs.symlink(protectedDir, alias, 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`junction unavailable: ${error.code}`);
    throw error;
  }

  const throughAlias = createJournalStore({ directory: path.join(alias, 'nested'), siteUrl: SITE });
  await assert.rejects(throughAlias.save('host-path-hash-17', record()));
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'synthetic protected bytes');
  assert.equal(await fs.readdir(protectedDir).then((items) => items.length), 1);

  const directory = path.join(root, 'ordinary');
  await fs.mkdir(directory);
  const regularStore = createJournalStore({ directory, siteUrl: SITE });
  await regularStore.save('host-path-hash-17', record());
  const actualJournal = path.join(directory, (await fs.readdir(directory))[0]);
  await fs.unlink(actualJournal);
  await fs.mkdir(actualJournal);
  await assert.rejects(regularStore.load('host-path-hash-17'));
  await assert.rejects(regularStore.save('host-path-hash-17', record('host-path-hash-17', { planHash: 'b'.repeat(64) })));
  await fs.rmdir(actualJournal);
  await fs.symlink(protectedDir, actualJournal, 'junction');
  await assert.rejects(regularStore.load('host-path-hash-17'));
  await assert.rejects(regularStore.save('host-path-hash-17', record('host-path-hash-17', { planHash: 'b'.repeat(64) })));
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'synthetic protected bytes');
});

function clientFixture({ uncertainCreate = false } = {}) {
  const posts = new Map();
  const counts = { create: 0, update: 0 };
  let nextID = 1;
  const client = {
    async probe() { return { ownerID: 17, capabilities: { publish_posts: true, upload_files: true } }; },
    async createPost(fields) {
      counts.create += 1;
      const id = nextID++;
      posts.set(id, {
        id, type: 'post', author: 17, status: fields.status, slug: fields.slug,
        title: { raw: fields.title }, content: { raw: fields.content },
        link: `${SITE}/posts/${id}`,
      });
      if (uncertainCreate) throw new Error('synthetic acknowledgement lost');
      return { id };
    },
    async uploadMedia() { throw new Error('no media expected'); },
    async updatePost(id, fields) {
      counts.update += 1;
      const post = posts.get(id);
      if (Object.hasOwn(fields, 'title')) post.title = { raw: fields.title };
      if (Object.hasOwn(fields, 'content')) post.content = { raw: fields.content };
      if (Object.hasOwn(fields, 'status')) post.status = fields.status;
      if (Object.hasOwn(fields, 'slug')) post.slug = fields.slug;
      if (fields.status === 'publish' && post.slug === '') post.slug = 'safe-title';
      return { id };
    },
    async getPost(id) { return structuredClone(posts.get(id)); },
  };
  return { client, counts, posts };
}

test('publisher cold-recovers a disk receipt and updates the same remote ID', async (t) => {
  const { createPublisher } = require('../src/publisher');
  const directory = path.join(await sandbox(t), 'plugin-data');
  const remote = clientFixture();
  const makePublisher = () => createPublisher({
    client: remote.client,
    store: createJournalStore({ directory, siteUrl: SITE }),
    siteUrl: SITE,
  });
  const original = {
    noteID: crypto.createHash('sha256').update('synthetic-vault/note.md').digest('hex'),
    title: 'Safe title', source: 'Safe body', images: [],
  };

  const first = await makePublisher().publish(original);
  assert.equal(first.status, 'published');
  assert.equal(remote.counts.create, 1);
  const diskFiles = await fs.readdir(directory);
  assert.equal(diskFiles.length, 1);
  const diskJournal = await fs.readFile(path.join(directory, diskFiles[0]), 'utf8');
  assert.doesNotMatch(diskJournal, /Safe title|Safe body|password|authorization|sourcePath|bytes/iu);

  const coldRead = await makePublisher().publish(original);
  assert.equal(coldRead.status, 'published');
  assert.equal(coldRead.postID, first.postID);
  assert.equal(remote.counts.create, 1);
  assert.equal(remote.counts.update, 2);

  const edited = { ...original, title: 'Edited title', source: 'Edited body' };
  const updated = await makePublisher().publish(edited);
  assert.equal(updated.status, 'published');
  assert.equal(updated.postID, first.postID);
  assert.equal(remote.counts.create, 1);
  assert.equal(remote.counts.update, 3);
  assert.equal(remote.posts.get(first.postID).title.raw, 'Edited title');

  const afterRestart = await makePublisher().publish(edited);
  assert.equal(afterRestart.status, 'published');
  assert.equal(afterRestart.postID, first.postID);
  assert.equal(remote.counts.create, 1);
  assert.equal(remote.counts.update, 3);
});

test('disk cold start claims one lost-ACK create by its persisted anchor and resumes only on click', async (t) => {
  const { createPublisher } = require('../src/publisher');
  const directory = path.join(await sandbox(t), 'plugin-data');
  const remote = clientFixture({ uncertainCreate: true });
  let lookups = 0;
  let showResults = false;
  remote.client.findPosts = async criteria => {
    lookups += 1;
    assert.deepEqual(criteria, { slug: anchor, status: 'any', page: 1, perPage: 2 });
    return showResults ? [...remote.posts.values()].filter(post => post.slug === criteria.slug) : [];
  };
  const make = () => createPublisher({ client: remote.client,
    store: createJournalStore({ directory, siteUrl: SITE }), siteUrl: SITE });
  const source = { noteID: 'cold-anchor', title: 'Safe title', source: 'Safe body', images: [] };
  assert.equal((await make().publish(source)).status, 'needs-check');
  const store = createJournalStore({ directory, siteUrl: SITE });
  const anchor = (await store.load(source.noteID)).createAnchor;
  assert.match(anchor, /^obsidian-create-[a-f0-9]{32}$/u);
  assert.equal((await make().checkStatus(source.noteID, source)).status, 'needs-check');
  showResults = true;
  const checked = await make().checkStatus(source.noteID, source);
  assert.deepEqual(checked, { status: 'draft', postID: 1, canResume: true });
  assert.equal(lookups, 2);
  assert.equal(remote.counts.create, 1);
  assert.equal(remote.counts.update, 0);
  assert.equal((await store.load(source.noteID)).createAnchor, anchor);
  assert.equal((await make().publish(source)).status, 'published');
  assert.equal(remote.counts.create, 1);
  assert.equal((await store.load(source.noteID)).createAnchor, anchor);
});

test('ambiguous create candidates latch across cold publishers and never bind the surviving draft', async (t) => {
  const { createPublisher } = require('../src/publisher');
  const directory = path.join(await sandbox(t), 'plugin-data');
  const remote = clientFixture({ uncertainCreate: true });
  let lookupMode = 'zero';
  let lookups = 0;
  let reads = 0;
  remote.client.findPosts = async criteria => {
    lookups += 1;
    return [...remote.posts.values()].filter(post => lookupMode === 'ambiguous' || post.slug === criteria.slug);
  };
  const getPost = remote.client.getPost;
  remote.client.getPost = async id => { reads += 1; return getPost(id); };
  const make = () => createPublisher({ client: remote.client,
    store: createJournalStore({ directory, siteUrl: SITE }), siteUrl: SITE });
  const source = { noteID: 'ambiguous-cold-note', title: 'Safe title', source: 'Safe body', images: [] };
  assert.equal((await make().publish(source)).status, 'needs-check');
  const anchor = (await createJournalStore({ directory, siteUrl: SITE }).load(source.noteID)).createAnchor;
  const original = [...remote.posts.values()][0];
  remote.posts.set(2, { ...structuredClone(original), id: 2, link: `${SITE}/posts/2` });
  remote.counts.create = 1;
  lookupMode = 'ambiguous';
  let writes = { ...remote.counts };
  const first = await make().checkStatus(source.noteID, source);
  assert.equal(first.status, 'needs-check');
  assert.equal(first.manualRequired, true);
  assert.equal(first.reason, 'create-lookup-ambiguous');
  assert.equal(remote.counts.create, writes.create);
  assert.equal(remote.counts.update, writes.update);
  assert.equal((await createJournalStore({ directory, siteUrl: SITE }).load(source.noteID)).createAmbiguous, true);
  remote.posts.delete(2);
  lookupMode = 'one';
  const cold = make();
  const remoteReads = { lookups, reads };
  const check = await cold.checkStatus(source.noteID, source);
  assert.equal(check.manualRequired, true);
  assert.equal(check.postID, undefined);
  assert.deepEqual({ lookups, reads }, remoteReads);
  writes = { ...remote.counts };
  const resumed = await make().publish(source);
  assert.equal(resumed.status, 'needs-check');
  assert.equal(resumed.manualRequired, true);
  assert.deepEqual({ lookups, reads }, remoteReads);
  assert.equal(remote.counts.create, writes.create);
  assert.equal(remote.counts.update, writes.update);
  assert.equal(anchor, (await createJournalStore({ directory, siteUrl: SITE }).load(source.noteID)).createAnchor);
});

test('failed ambiguity save leaves a real disk lookup guard that blocks cold recognition of the survivor', async (t) => {
  const { createPublisher } = require('../src/publisher');
  const directory = path.join(await sandbox(t), 'plugin-data');
  const remote = clientFixture({ uncertainCreate: true });
  let lookups = 0;
  let mode = 'one';
  remote.client.findPosts = async criteria => {
    lookups += 1;
    return [...remote.posts.values()].filter(post => mode === 'ambiguous' || post.slug === criteria.slug);
  };
  const baseStore = createJournalStore({ directory, siteUrl: SITE });
  let saves = 0;
  let failAmbiguity = true;
  const store = {
    load: (...args) => baseStore.load(...args),
    async save(...args) {
      saves += 1;
      if (saves === 3 && failAmbiguity) { failAmbiguity = false; throw new Error('one-shot disk failure'); }
      return baseStore.save(...args);
    },
  };
  const make = () => createPublisher({ client: remote.client, store, siteUrl: SITE });
  const source = { noteID: 'ambiguous-save-disk', title: 'Safe title', source: 'Safe body', images: [] };
  assert.equal((await make().publish(source)).status, 'needs-check');
  const anchor = (await baseStore.load(source.noteID)).createAnchor;
  const originalID = [...remote.posts.keys()][0];
  const original = structuredClone(remote.posts.get(originalID));
  remote.posts.set(originalID + 1, { ...original, id: originalID + 1, link: `${SITE}/posts/${originalID + 1}` });
  mode = 'ambiguous';
  const failed = await make().checkStatus(source.noteID, source);
  assert.equal(failed.reason, 'journal-unavailable');
  assert.equal(lookups, 1);
  const durable = await baseStore.load(source.noteID);
  assert.equal(durable.createLookupPending, true);
  assert.equal(durable.createAmbiguous, undefined);
  remote.posts.delete(originalID);
  mode = 'one';
  const before = lookups;
  const cold = await make().checkStatus(source.noteID, source);
  assert.equal(cold.manualRequired, true);
  assert.equal(cold.reason, 'create-lookup-incomplete');
  assert.equal(cold.postID, undefined);
  assert.equal(lookups, before);
  assert.equal((await baseStore.load(source.noteID)).createAnchor, anchor);
});

test('cold publisher keeps uncertain create pending and never resends create', async (t) => {
  const { createPublisher } = require('../src/publisher');
  const directory = path.join(await sandbox(t), 'plugin-data');
  const remote = clientFixture({ uncertainCreate: true });
  const makePublisher = () => createPublisher({
    client: remote.client,
    store: createJournalStore({ directory, siteUrl: SITE }),
    siteUrl: SITE,
  });
  const publication = {
    noteID: crypto.createHash('sha256').update('synthetic-vault/uncertain.md').digest('hex'),
    title: 'Safe title', source: 'Safe body', images: [],
  };

  const first = await makePublisher().publish(publication);
  assert.equal(first.status, 'needs-check');
  const cold = await makePublisher().publish(publication);
  assert.equal(cold.status, 'needs-check');
  assert.equal(remote.counts.create, 1);
  assert.equal(remote.posts.size, 1);
  assert.equal((await createJournalStore({ directory, siteUrl: SITE }).load(publication.noteID)).stage, 'creating');
});

test('journal paths are opaque to note IDs and never persist publisher content', async (t) => {
  const directory = path.join(await sandbox(t), 'plugin-data');
  const store = createJournalStore({ directory, siteUrl: SITE });
  const id = 'a host supplied path hash/.. should be rejected';
  await assert.rejects(store.load(id));
  await store.save('host-path-hash-17', record());
  const disk = await fs.readFile(path.join(directory, (await fs.readdir(directory))[0]), 'utf8');
  assert.doesNotMatch(disk, /password|authorization|Safe title|Safe body|sourcePath|bytes/i);
  assert.match(disk, /"noteID":"host-path-hash-17"/u);
  assert.equal(crypto.createHash('sha256').update('synthetic').digest('hex').length, 64);
});
