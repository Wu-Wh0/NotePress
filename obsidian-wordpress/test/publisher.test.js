'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createPublisher } = require('../src/publisher');

function fixture(options = {}) {
  const state = { calls: [], posts: new Map(), media: new Map(), nextPostID: 1, nextMediaID: 1, saveCount: 0 };
  const client = {
    async probe() { state.calls.push(['probe']); return { ownerID: 17, capabilities: { publish_posts: true, upload_files: true } }; },
    async createPost(fields) {
      state.calls.push(['createPost', fields]);
      if (options.createError) throw options.createError;
      const id = state.nextPostID++;
      const post = { id, author: 17, status: fields.status, title: { raw: fields.title }, content: { raw: fields.content }, link: `https://blog.example/post/${id}` };
      state.posts.set(id, post);
      return { id };
    },
    async uploadMedia(bytes, mime, filename) {
      state.calls.push(['uploadMedia', Buffer.from(bytes), mime, filename]);
      const id = state.nextMediaID++;
      const media = { id, author: 17, mime_type: mime, source_url: `https://blog.example/media/${id}` };
      state.media.set(id, media);
      return options.mediaResponse ? options.mediaResponse(media) : media;
    },
    async updatePost(id, fields) {
      state.calls.push(['updatePost', id, fields]);
      const post = state.posts.get(id);
      Object.assign(post, fields);
      if (Object.hasOwn(fields, 'title')) post.title = { raw: options.filterTitle ? options.filterTitle(fields.title) : fields.title };
      if (Object.hasOwn(fields, 'content')) post.content = { raw: options.filterContent ? options.filterContent(fields.content) : fields.content };
      if (options.uncertainPublish && fields.status === 'publish') throw new Error('synthetic_uncertain_publish');
      return { id };
    },
    async getPost(id) {
      state.calls.push(['getPost', id]);
      return structuredClone(state.posts.get(id));
    },
  };
  const records = new Map();
  const store = {
    async load(noteID) { return records.has(noteID) ? structuredClone(records.get(noteID)) : null; },
    async save(noteID, record) {
      if (options.failSaveAt === state.saveCount + 1) throw new Error('synthetic_store_failure');
      state.saveCount = (state.saveCount || 0) + 1;
      records.set(noteID, structuredClone(record));
    },
  };
  return { state, records, client, store };
}

const siteUrl = 'https://blog.example';

function plan(overrides = {}) {
  return { noteID: 'note-17', title: 'A title', source: 'A body', images: [], ...overrides };
}

test('construction is inert; an explicit publish creates and reads back one post', async () => {
  const f = fixture();
  const publisher = createPublisher({ client: f.client, store: f.store, siteUrl });
  assert.deepEqual(f.state.calls, []);

  const [result, repeated] = await Promise.all([publisher.publish(plan()), publisher.publish(plan())]);

  assert.equal(result.status, 'published');
  assert.equal(repeated.status, 'published');
  assert.equal(repeated.postID, result.postID);
  assert.equal(result.postID, 1);
  assert.equal(result.link, 'https://blog.example/post/1');
  assert.equal(f.state.calls.filter(([name]) => name === 'createPost').length, 1);
  assert.equal(f.state.calls.filter(([name]) => name === 'updatePost').length, 2);
  assert.equal(f.state.posts.get(1).status, 'publish');
});

test('probe must confirm publishing and upload capabilities before any write', async () => {
  const f = fixture();
  f.client.probe = async () => {
    f.state.calls.push(['probe']);
    return { ownerID: 17, capabilities: { publish_posts: false, upload_files: true } };
  };
  const result = await createPublisher({ client: f.client, store: f.store, siteUrl }).publish(plan());
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'missing-capability');
  assert.equal(f.state.calls.some(([name]) => ['createPost', 'uploadMedia', 'updatePost'].includes(name)), false);
});

test('uploads only referenced images by content hash and keeps paths/body out of the journal', async () => {
  const crypto = require('node:crypto');
  const f = fixture();
  const bytes = Buffer.from('synthetic image bytes');
  const publicationPlan = plan({
    source: '---\nprivate: SECRET\n---\n\n![cover](private/cover.png)',
    images: [{ sourcePath: 'private/cover.png', bytes, mime: 'image/png' }],
  });
  const result = await createPublisher({ client: f.client, store: f.store, siteUrl }).publish(publicationPlan);
  const upload = f.state.calls.find(([name]) => name === 'uploadMedia');
  const journalText = JSON.stringify(f.records.get(publicationPlan.noteID));
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');

  assert.equal(result.status, 'published');
  assert.equal(upload[3], `${digest}.png`);
  assert.deepEqual(upload[1], bytes);
  assert.match(f.state.posts.get(result.postID).content.raw, /https:\/\/blog\.example\/media\/1/);
  assert.doesNotMatch(f.state.posts.get(result.postID).content.raw, /<article>|article-title|<h1/);
  assert.doesNotMatch(f.state.posts.get(result.postID).content.raw, /private\/cover\.png|SECRET/);
  assert.doesNotMatch(journalText, /private\/cover\.png|SECRET|A body|A title|synthetic image bytes/);
});

test('untrusted media owner, MIME, or URL origin blocks article updates', async () => {
  const bytes = Buffer.from('image');
  const variants = [
    media => ({ ...media, author: 18 }),
    media => ({ ...media, mime_type: 'image/gif' }),
    media => ({ ...media, source_url: 'https://media-attacker.example/image.png' }),
  ];
  for (const mediaResponse of variants) {
    const f = fixture({ mediaResponse });
    const publicationPlan = plan({
      source: '![[cover.png]]',
      images: [{ sourcePath: 'cover.png', bytes, mime: 'image/png' }],
    });
    const result = await createPublisher({ client: f.client, store: f.store, siteUrl }).publish(publicationPlan);
    assert.equal(result.status, 'needs-check');
    assert.equal(f.state.calls.filter(([name]) => name === 'updatePost').length, 0);
    assert.equal(f.records.get('note-17').stage, 'uploading-media');
  }
});

test('missing, extra, unsupported, and note-embed resources block before remote writes', async () => {
  const bytes = Buffer.from('x');
  const cases = [
    [plan({ source: '![[missing.png]]' }), 'MISSING_IMAGE'],
    [plan({ images: [{ sourcePath: 'unused.png', bytes, mime: 'image/png' }] }), 'UNREFERENCED_IMAGE'],
    [plan({ source: '![[cover.png]]', images: [{ sourcePath: 'cover.png', bytes, mime: 'image/svg+xml' }] }), 'UNSUPPORTED_IMAGE'],
    [plan({ title: '' }), 'invalid_title'],
    [plan({ source: '![[private/note.md]]' }), 'unsupported_note_embed'],
  ];
  for (const [publicationPlan, reason] of cases) {
    const f = fixture();
    const result = await createPublisher({ client: f.client, store: f.store, siteUrl }).publish(publicationPlan);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, reason);
    assert.equal(f.state.calls.some(([name]) => ['createPost', 'uploadMedia', 'updatePost'].includes(name)), false);
  }
});

test('a failed initial journal save and a stale input both cause zero remote writes', async () => {
  const failed = fixture({ failSaveAt: 1 });
  const failedResult = await createPublisher({ client: failed.client, store: failed.store, siteUrl }).publish(plan());
  assert.equal(failedResult.status, 'blocked');
  assert.equal(failedResult.reason, 'journal-unavailable');
  assert.equal(failed.state.calls.some(([name]) => ['createPost', 'uploadMedia', 'updatePost'].includes(name)), false);

  const stale = fixture();
  const staleResult = await createPublisher({ client: stale.client, store: stale.store, siteUrl }).publish(plan({ isCurrent: async () => false }));
  assert.equal(staleResult.status, 'blocked');
  assert.equal(staleResult.reason, 'input-changed');
  assert.equal(stale.state.saveCount, 0);
  assert.equal(stale.state.calls.some(([name]) => ['createPost', 'uploadMedia', 'updatePost'].includes(name)), false);
});

test('server filtering that changes draft content stops before publish', async () => {
  const f = fixture({ filterContent: content => `${content}filtered` });
  const result = await createPublisher({ client: f.client, store: f.store, siteUrl }).publish(plan());
  assert.equal(result.status, 'draft');
  assert.equal(f.state.posts.get(result.postID).status, 'draft');
  assert.equal(f.state.calls.filter(([name]) => name === 'updatePost').length, 1);
  assert.equal(f.records.get('note-17').stage, 'updating-draft');
});

test('an indeterminate create remains pending and is never automatically created again', async () => {
  const f = fixture({ createError: Object.assign(new Error('synthetic'), { dispatched: true, indeterminate: true }) });
  const publisher = createPublisher({ client: f.client, store: f.store, siteUrl });
  const first = await publisher.publish(plan());
  const second = await publisher.publish(plan());
  const status = await publisher.checkStatus('note-17', plan());

  assert.equal(first.status, 'needs-check');
  assert.equal(second.status, 'needs-check');
  assert.equal(status.status, 'needs-check');
  assert.equal(f.state.calls.filter(([name]) => name === 'createPost').length, 1);
  assert.equal(f.state.posts.size, 0);
});

test('an explicit update reuses the known post ID and remote drift blocks all writes', async () => {
  const f = fixture();
  const publisher = createPublisher({ client: f.client, store: f.store, siteUrl });
  const first = await publisher.publish(plan());
  const edited = plan({ title: 'Updated title', source: 'Updated body' });
  const second = await publisher.publish(edited);
  assert.equal(second.status, 'published');
  assert.equal(second.postID, first.postID);
  assert.equal(f.state.calls.filter(([name]) => name === 'createPost').length, 1);
  assert.equal(f.state.posts.get(first.postID).title.raw, 'Updated title');
  assert.equal(f.state.posts.get(first.postID).status, 'publish');

  f.state.posts.get(first.postID).content.raw = 'remote edit';
  const writesBefore = f.state.calls.filter(([name]) => ['createPost', 'uploadMedia', 'updatePost'].includes(name)).length;
  const conflict = await publisher.publish(plan({ title: 'Another title', source: 'Another body' }));
  const writesAfter = f.state.calls.filter(([name]) => ['createPost', 'uploadMedia', 'updatePost'].includes(name)).length;
  assert.equal(conflict.status, 'conflict');
  assert.equal(writesAfter, writesBefore);
});

test('an uncertain final publish is reconciled by exact readback without another write', async () => {
  const f = fixture({ uncertainPublish: true });
  const publisher = createPublisher({ client: f.client, store: f.store, siteUrl });
  const first = await publisher.publish(plan());
  const callsAfterPublish = f.state.calls.filter(([name]) => ['createPost', 'uploadMedia', 'updatePost'].includes(name)).length;
  const checked = await publisher.checkStatus('note-17', plan());
  const repeated = await publisher.publish(plan());

  assert.equal(first.status, 'needs-check');
  assert.equal(checked.status, 'published');
  assert.equal(checked.postID, first.postID);
  assert.equal(repeated.status, 'published');
  assert.equal(f.state.calls.filter(([name]) => ['createPost', 'uploadMedia', 'updatePost'].includes(name)).length, callsAfterPublish);
  assert.equal(f.records.get('note-17').stage, 'completed');
});

test('native plain permalink URLs are accepted for draft and published readback', async () => {
  const f = fixture();
  const create = f.client.createPost;
  f.client.createPost = async fields => {
    const created = await create(fields);
    f.state.posts.get(created.id).link = `https://blog.example/?p=${created.id}`;
    return created;
  };
  const published = await createPublisher({ client: f.client, store: f.store, siteUrl }).publish(plan());
  assert.equal(published.status, 'published');
  assert.equal(published.link, 'https://blog.example/?p=1');
});

test('created draft is read and bound to its exact ID before uploading article images', async () => {
  const f = fixture();
  const get = f.client.getPost;
  f.client.getPost = async id => ({ ...await get(id), id: id + 100 });
  const published = await createPublisher({ client: f.client, store: f.store, siteUrl }).publish(plan({
    source: '![[cover.png]]', images: [{ sourcePath: 'cover.png', bytes: Buffer.from('synthetic'), mime: 'image/png' }],
  }));
  assert.equal(published.status, 'needs-check');
  assert.equal(f.state.calls.some(([name]) => ['uploadMedia', 'updatePost'].includes(name)), false);
});

test('input changed during media journal persistence blocks the upload itself', async () => {
  const f = fixture();
  let current = true;
  const save = f.store.save;
  f.store.save = async (noteID, record) => {
    await save(noteID, record);
    if (record.stage === 'uploading-media') current = false;
  };
  const published = await createPublisher({ client: f.client, store: f.store, siteUrl }).publish(plan({
    source: '![[cover.png]]', images: [{ sourcePath: 'cover.png', bytes: Buffer.from('synthetic'), mime: 'image/png' }],
    isCurrent: async () => current,
  }));
  assert.equal(published.status, 'blocked');
  assert.equal(published.reason, 'input-changed');
  assert.equal(f.state.calls.some(([name]) => ['uploadMedia', 'updatePost'].includes(name)), false);
});

test('known-ID recovery does not accept a different post with otherwise matching content', async () => {
  const f = fixture({ uncertainPublish: true });
  const publisher = createPublisher({ client: f.client, store: f.store, siteUrl });
  assert.equal((await publisher.publish(plan())).status, 'needs-check');
  const get = f.client.getPost;
  f.client.getPost = async id => ({ ...await get(id), id: id + 100 });
  const checked = await publisher.checkStatus('note-17', plan());
  assert.equal(checked.status, 'needs-check');
  assert.equal(f.records.get('note-17').stage, 'publishing');
});

test('update cancelled after final journal save restores the completed receipt and permits a fresh same-ID intent', async () => {
  const f = fixture();
  const publisher = createPublisher({ client: f.client, store: f.store, siteUrl });
  const first = await publisher.publish(plan());
  const previous = structuredClone(f.records.get('note-17'));
  const priorPost = structuredClone(f.state.posts.get(first.postID));
  const writes = () => f.state.calls.filter(([name]) => ['createPost', 'uploadMedia', 'updatePost'].includes(name)).length;
  const before = writes();
  const save = f.store.save;
  let current = true;
  let armed = true;
  f.store.save = async (noteID, record) => {
    await save(noteID, record);
    if (armed && record.stage === 'updating-post' && record.expectedBodyHash) { current = false; armed = false; }
  };
  const edited = plan({ source: 'Changed body', isCurrent: async () => current });
  const cancelled = await publisher.publish(edited);
  assert.equal(cancelled.reason, 'input-changed');
  assert.equal(writes(), before);
  assert.deepEqual(f.state.posts.get(first.postID), priorPost);
  assert.deepEqual(f.records.get('note-17'), previous);
  current = true;
  const retry = await publisher.publish(edited);
  assert.equal(retry.status, 'published');
  assert.equal(retry.postID, first.postID);
  assert.equal(f.state.calls.filter(([name]) => name === 'createPost').length, 1);
});

test('cancelled update preserves acknowledged media without deleting it or blindly uploading it again', async () => {
  for (const cancelStage of ['uploading-media', 'media-uploaded']) {
    const f = fixture();
    const publisher = createPublisher({ client: f.client, store: f.store, siteUrl });
    const first = await publisher.publish(plan());
    const previous = structuredClone(f.records.get('note-17'));
    const postWritesBefore = f.state.calls.filter(([name]) => name === 'updatePost').length;
    const save = f.store.save;
    let current = true;
    let armed = true;
    f.store.save = async (noteID, record) => {
      await save(noteID, record);
      if (armed && record.stage === cancelStage) { current = false; armed = false; }
    };
    const edited = plan({ source: '![[cover.png]]', images: [{ sourcePath: 'cover.png', bytes: Buffer.from('synthetic'), mime: 'image/png' }], isCurrent: async () => current });
    const cancelled = await publisher.publish(edited);
    assert.equal(cancelled.reason, 'input-changed');
    assert.equal(f.state.calls.filter(([name]) => name === 'updatePost').length, postWritesBefore);
    const restored = f.records.get('note-17');
    assert.equal(restored.stage, 'completed');
    assert.equal(restored.planHash, previous.planHash);
    assert.equal(restored.remoteHash, previous.remoteHash);
    assert.equal(restored.media.length, cancelStage === 'media-uploaded' ? 1 : 0);
    assert.equal(f.state.media.size, restored.media.length);
    current = true;
    const retry = await publisher.publish(edited);
    assert.equal(retry.status, 'published');
    assert.equal(retry.postID, first.postID);
    assert.equal(f.state.calls.filter(([name]) => name === 'uploadMedia').length, 1);
    assert.equal(f.state.media.size, 1);
  }
});

test('indeterminate post update retains its previous receipt but is never restored as an unsent cancellation', async () => {
  const f = fixture();
  const publisher = createPublisher({ client: f.client, store: f.store, siteUrl });
  const first = await publisher.publish(plan());
  const previous = structuredClone(f.records.get('note-17'));
  const update = f.client.updatePost;
  f.client.updatePost = async (id, fields) => {
    await update(id, fields);
    throw Object.assign(new Error('synthetic_write_ack_lost'), { dispatched: true, indeterminate: true });
  };
  const edited = plan({ source: 'Changed body' });
  assert.equal((await publisher.publish(edited)).status, 'needs-check');
  const pending = f.records.get('note-17');
  assert.equal(pending.stage, 'updating-post');
  assert.deepEqual(pending.previousReceipt, previous);
  const writes = f.state.calls.filter(([name]) => name === 'updatePost').length;
  assert.equal((await publisher.publish(edited)).status, 'needs-check');
  assert.equal(f.state.calls.filter(([name]) => name === 'updatePost').length, writes);
  const checked = await publisher.checkStatus('note-17', edited);
  assert.equal(checked.status, 'published');
  assert.equal(checked.postID, first.postID);
  assert.equal(f.records.get('note-17').previousReceipt, undefined);
});
