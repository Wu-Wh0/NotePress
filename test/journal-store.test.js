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
        id, author: 17, status: fields.status,
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
