'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHostController } = require('../src/host-controller');
const { renderArticle, extractImageReferences } = require('../src/article');
const { createPublisher } = require('../src/publisher');
const { createJournalStore } = require('../src/journal-store');

function setup(directory, attachmentFolder = null) {
  const note = { path: 'notes/post.md', basename: 'post', extension: 'md', stat: { size: 30, mtime: 1 } };
  const image = { path: 'notes/assets/a.png', extension: 'png', bytes: Buffer.from('SIMULATED-image'), stat: { size: 15, mtime: 1 } };
  const state = { source: '正文 ![a](assets/a.png)', selected: note, previews: [], writes: [], lookups: [], post: null, bytes: image.bytes,
    vaultPaths: new Set([note.path]), ownerID: 2 };
  image.stat.size = image.bytes.length;
  const siteUrl = 'https://blog.example';
  const store = () => createJournalStore({ directory, siteUrl });
  const client = {
    async probe() { return { ownerID: state.ownerID, capabilities: { publish_posts: true, upload_files: true } }; },
    async createPost(fields) { state.writes.push('create'); state.post = { id: 41, type: 'post', author: 2, title: { raw: fields.title }, content: { raw: fields.content }, status: fields.status, slug: fields.slug, link: siteUrl + '/?p=41' }; return structuredClone(state.post); },
    async getPost(id) { assert.equal(id, 41); return structuredClone(state.post); },
    async updatePost(id, fields) { assert.equal(id, 41); state.writes.push('update'); for (const [key, value] of Object.entries(fields)) { if (key === 'title' || key === 'content') state.post[key] = { raw: value }; else state.post[key] = value; } if (fields.status === 'publish' && state.post.slug === '') state.post.slug = (fields.title || state.post.title.raw).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'post'; return structuredClone(state.post); },
    async findPosts(criteria) {
      if (!criteria || criteria.status !== 'any' || criteria.page !== 1 || criteria.perPage !== 2 || typeof criteria.slug !== 'string') throw new Error('SIMULATED-invalid-findPosts-query');
      state.lookups.push(structuredClone(criteria));
      const post = state.post;
      return post && post.slug === criteria.slug && ['draft', 'publish', 'pending', 'private', 'future'].includes(post.status)
        ? [structuredClone(post)].slice(0, criteria.perPage) : [];
    },
    async uploadMedia(bytes, mime) { state.writes.push('media'); return { id: 51, author: 2, mime_type: mime, source_url: siteUrl + '/image.png' }; },
  };
  function controller() {
    return createHostController({
      getSettings: () => ({ siteUrl, username: 'SIMULATED-writer', secretRef: 'test-secret' }),
      getSelectedFile: () => state.selected,
      isFile: file => file === note || file === image,
      readSource: async () => state.source,
      resolveImage: async () => image,
      readBinary: async () => state.bytes,
      getSecret: () => 'SIMULATED-only',
      getAttachmentFolderPath: async () => attachmentFolder,
      renderArticle, extractImageReferences,
      createClient: () => client, createPublisher, getStore: () => {
        const disk = store();
        const bind = disk.bind;
        disk.bind = (...args) => bind(...args.slice(0, 4), async () => {
          state.beforeBind?.();
          return args[4]();
        });
        return disk;
      },
      pathExists: oldPath => state.vaultPaths.has(oldPath),
      createObjectURL: () => 'blob:synthetic/image', revokeObjectURL() {},
      onPreview: value => state.previews.push(value),
    });
  }
  return { state, note, image, controller, client, store };
}

test('SIMULATED rename and cold move restore only local association; explicit updates reuse post 41', async t => {
  const f = setup(await temporary(t));
  const first = f.controller();
  assert.equal((await first.publish()).status, 'published');
  const oldPath = f.note.path;
  f.state.vaultPaths.delete(oldPath);
  f.note.path = 'notes/renamed.md';
  f.note.basename = 'renamed';
  f.state.vaultPaths.add(f.note.path);
  f.state.source = '正文，已改标题';
  await first.noteRenamed(f.note, oldPath);
  assert.equal((await first.refresh()).canRestore, true);
  assert.equal((await first.publish()).status, 'blocked');
  const writesBeforeRestore = f.state.writes.length;
  assert.equal((await first.restoreAssociation(oldPath)).status, 'restored');
  assert.equal(f.state.writes.length, writesBeforeRestore);
  assert.equal((await first.refresh()).dirty, true);
  assert.equal((await first.publish()).postID, 41);
  assert.equal(f.state.writes.filter(item => item === 'create').length, 1);
  assert.equal(f.state.writes.filter(item => item === 'media').length, 1);
  first.dispose();

  const secondOldPath = f.note.path;
  f.state.vaultPaths.delete(secondOldPath);
  f.note.path = 'notes/second.md';
  f.note.basename = 'second';
  f.state.vaultPaths.add(f.note.path);
  f.state.source += ' 再修改';
  const cold = f.controller();
  assert.equal((await cold.restoreAssociation('')).status, 'blocked');
  assert.equal((await cold.restoreAssociation(secondOldPath)).status, 'restored');
  assert.equal((await cold.publish()).postID, 41);
  assert.deepEqual(f.state.writes.filter(item => item === 'create'), ['create']);
  cold.dispose();
});

test('restore refuses remote drift, old path still present, and occupied destination without writes', async t => {
  const f = setup(await temporary(t));
  const c = f.controller();
  assert.equal((await c.publish()).status, 'published');
  const oldPath = f.note.path;
  f.note.path = 'notes/new.md';
  f.note.basename = 'new';
  f.state.vaultPaths.add(f.note.path);
  const writes = f.state.writes.length;
  assert.equal((await c.restoreAssociation(oldPath)).reason, 'old-path-exists');
  f.state.vaultPaths.delete(oldPath);
  const originalContent = f.state.post.content.raw;
  f.state.post.content.raw = 'remote drift';
  assert.equal((await c.restoreAssociation(oldPath)).status, 'blocked');
  assert.equal(f.state.writes.length, writes);
  f.state.post.content.raw = originalContent;
  const oldID = crypto.createHash('sha256').update(oldPath).digest('hex');
  const newID = crypto.createHash('sha256').update(f.note.path).digest('hex');
  const receipt = await f.store().load(oldID);
  await f.store().save(newID, { ...receipt, noteID: newID });
  assert.equal((await c.restoreAssociation(oldPath)).status, 'blocked');
  assert.equal(f.state.writes.length, writes);
  c.dispose();
});

test('restore blocks owner mismatch, pending journal and failed local bind without publishing', async t => {
  const f = setup(await temporary(t));
  const c = f.controller();
  assert.equal((await c.publish()).status, 'published');
  const oldPath = f.note.path;
  f.state.vaultPaths.delete(oldPath);
  f.note.path = 'notes/moved.md';
  f.note.basename = 'moved';
  f.state.vaultPaths.add(f.note.path);
  await c.noteRenamed(f.note, oldPath);
  const writes = f.state.writes.length;
  f.state.ownerID = 3;
  assert.equal((await c.restoreAssociation(oldPath)).reason, 'owner-mismatch');
  f.state.ownerID = 2;
  const rename = fs.rename;
  fs.rename = async () => { throw new Error('SIMULATED-association-save-failure'); };
  try { assert.equal((await c.restoreAssociation(oldPath)).reason, 'association-save-failed'); }
  finally { fs.rename = rename; }
  assert.equal((await c.publish()).status, 'blocked');
  assert.equal(f.state.writes.length, writes);
  c.dispose();

  const cold = f.controller();
  assert.equal((await cold.publish()).status, 'blocked');
  assert.deepEqual(f.state.writes.filter(item => item === 'create'), ['create']);
  assert.equal((await cold.restoreAssociation(oldPath)).status, 'restored');
  assert.equal((await cold.publish()).postID, 41);
  assert.deepEqual(f.state.writes.filter(item => item === 'create'), ['create']);
  cold.dispose();

  const pending = setup(await temporary(t));
  const pendingID = crypto.createHash('sha256').update(pending.note.path).digest('hex');
  await pending.store().save(pendingID, { schema: 1, noteID: pendingID, siteUrl: 'https://blog.example',
    ownerID: 2, planHash: 'a'.repeat(64), sourceHash: 'a'.repeat(64), titleHash: 'a'.repeat(64),
    stage: 'creating', media: [] });
  const beforePath = pending.note.path;
  pending.state.vaultPaths.delete(beforePath);
  pending.note.path = 'notes/pending-moved.md';
  pending.note.basename = 'pending-moved';
  pending.state.vaultPaths.add(pending.note.path);
  const pendingController = pending.controller();
  await pendingController.noteRenamed(pending.note, beforePath);
  assert.equal((await pendingController.restoreAssociation(beforePath)).status, 'blocked');
  assert.equal((await pendingController.publish()).status, 'blocked');
  assert.deepEqual(pending.state.writes, []);
  pendingController.dispose();
});

test('restore rejects selection and source changes during awaited disk bind without activating target', async t => {
  const f = setup(await temporary(t));
  const c = f.controller();
  assert.equal((await c.publish()).status, 'published');
  const oldPath = f.note.path;
  f.state.vaultPaths.delete(oldPath);
  f.note.path = 'notes/changed-during-bind.md';
  f.state.vaultPaths.add(f.note.path);
  await c.noteRenamed(f.note, oldPath);
  const writes = f.state.writes.length;
  f.state.beforeBind = () => { f.state.source = 'changed while bind awaited'; };
  assert.equal((await c.restoreAssociation(oldPath)).status, 'blocked');
  delete f.state.beforeBind;
  assert.deepEqual(await f.store().resolve(crypto.createHash('sha256').update(f.note.path).digest('hex')),
    { noteID: null, retired: true });
  assert.equal((await f.controller().publish()).status, 'blocked');
  assert.equal(f.state.writes.length, writes);
  c.dispose();
});

test('two unconfirmed online renames keep the final path blocked until original receipt is restored', async t => {
  const f = setup(await temporary(t));
  const c = f.controller();
  assert.equal((await c.publish()).status, 'published');
  const original = f.note.path;
  f.state.vaultPaths.delete(original);
  f.note.path = 'notes/intermediate.md';
  f.state.vaultPaths.add(f.note.path);
  await c.noteRenamed(f.note, original);
  const intermediate = f.note.path;
  f.state.vaultPaths.delete(intermediate);
  f.note.path = 'notes/final.md';
  f.state.vaultPaths.add(f.note.path);
  await c.noteRenamed(f.note, intermediate);
  assert.equal(c.proposedOldPath(), original);
  c.dispose();
  const cold = f.controller();
  assert.equal((await cold.publish()).status, 'blocked');
  assert.deepEqual(f.state.writes.filter(item => item === 'create'), ['create']);
  assert.equal((await cold.restoreAssociation(original)).status, 'restored');
  f.state.source += ' changed';
  assert.equal((await cold.publish()).postID, 41);
  assert.deepEqual(f.state.writes.filter(item => item === 'create'), ['create']);
  cold.dispose();
});

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'wp-host-integration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('real renderer, publisher and disk journal publish a referenced image then cold-update the same post', async t => {
  const f = setup(await temporary(t));
  const first = f.controller();
  const preview = await first.refresh();
  assert.equal(preview.canPublish, true);
  assert.deepEqual(f.state.writes, []);
  const published = await first.publish();
  assert.equal(published.status, 'published');
  assert.equal(published.postID, 41);
  assert.equal(f.state.writes.filter(x => x === 'create').length, 1);
  first.dispose();
  f.state.source += '\n更新';
  const second = f.controller();
  const changed = await second.refresh();
  assert.equal(changed.dirty, true);
  const updated = await second.publish();
  assert.equal(updated.status, 'published');
  assert.equal(updated.postID, 41);
  assert.equal(f.state.writes.filter(x => x === 'create').length, 1);
  assert.equal(f.state.writes.filter(x => x === 'media').length, 1);
  second.dispose();
});

test('unsupported note embed and empty selection replace the last visible preview rather than leaving old publish controls', async t => {
  const f = setup(await temporary(t));
  const c = f.controller();
  await c.refresh();
  f.state.source = '![[private-note.md]]';
  c.invalidate('editor-change');
  await c.refresh();
  assert.equal(f.state.previews.at(-1).canPublish, false);
  assert.equal(f.state.previews.at(-1).html, '');
  f.state.selected = null;
  c.invalidate('active-leaf-change');
  await c.refresh();
  assert.equal(f.state.previews.at(-1).status, 'empty');
  assert.deepEqual(f.state.writes, []);
  c.dispose();
});

test('basename image resolves exactly to the configured current-note attachment folder', async t => {
  const f = setup(await temporary(t), './assets');
  f.state.source = '![[a.png]]';
  const c = f.controller();
  assert.equal((await c.refresh()).canPublish, true);
  assert.equal((await c.publish()).status, 'published');
  c.dispose();
});

test('known draft recovery is read-only and cold continuation requires a separate publish without duplicate resources', async t => {
  for (const phase of ['draft-created', 'updating-draft']) {
    const f = setup(await temporary(t));
    const get = f.client.getPost;
    const update = f.client.updatePost;
    let armed = true;
    f.client.getPost = async id => {
      if (armed && phase === 'draft-created') { armed = false; throw new Error('SIMULATED-read-failure'); }
      return get(id);
    };
    f.client.updatePost = async (id, fields) => {
      const response = await update(id, fields);
      if (armed && phase === 'updating-draft' && fields.status === 'draft') {
        armed = false;
        throw new Error('SIMULATED-lost-ack');
      }
      return response;
    };
    const first = f.controller();
    assert.equal((await first.publish()).status, 'needs-check');
    first.dispose();
    const cold = f.controller();
    const before = [...f.state.writes];
    assert.equal((await cold.refresh()).canPublish, false);
    const checked = await cold.checkStatus();
    assert.equal(checked.status, 'draft');
    assert.equal(checked.canResume, true);
    assert.match(checked.message, /已核对.*再次点击发布/);
    assert.deepEqual(f.state.writes, before);
    assert.equal(f.state.post.status, 'draft');
    cold.dispose();
    const resumed = f.controller();
    assert.equal((await resumed.refresh()).canPublish, true);
    assert.equal((await resumed.publish()).status, 'published');
    assert.equal(f.state.post.id, 41);
    assert.equal(f.state.writes.filter(x => x === 'create').length, 1);
    assert.equal(f.state.writes.filter(x => x === 'media').length, 1);
    resumed.dispose();
  }
});

test('SIMULATED host cold recovery after lost schema2 create ACK uses disk journal and explicit publish', async t => {
  const directory = await temporary(t);
  const f = setup(directory);
  const first = f.controller();
  const preview = await first.refresh();
  assert.equal(preview.canPublish, true);
  const create = f.client.createPost;
  f.client.createPost = async fields => { await create(fields); throw new Error('SIMULATED-lost-create-ACK'); };
  assert.equal((await first.publish()).status, 'needs-check');
  first.dispose();

  const noteID = crypto.createHash('sha256').update('notes/post.md').digest('hex');
  const journalKey = crypto.createHash('sha256').update(JSON.stringify(['https://blog.example', noteID])).digest('hex');
  const journalPath = path.join(directory, `journal-${journalKey}.json`);
  const persisted = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  assert.equal(persisted.schema, 2);
  assert.match(persisted.createAnchor, /^obsidian-create-[a-f0-9]{32}$/u);
  const anchor = persisted.createAnchor;
  assert.equal(f.state.post.slug, anchor);
  const writesBeforeCheck = [...f.state.writes];

  const second = f.controller();
  const interrupted = await second.refresh();
  assert.equal(interrupted.needsCheck, true);
  assert.equal(interrupted.manualRequired, false);
  assert.equal(interrupted.canPublish, false);
  const checked = await second.checkStatus();
  assert.equal(checked.status, 'draft');
  assert.equal(checked.canResume, true);
  assert.match(checked.message, /已核对.*再次点击发布/u);
  assert.deepEqual(f.state.writes, writesBeforeCheck);
  assert.equal(JSON.parse(await fs.readFile(journalPath, 'utf8')).createAnchor, anchor);
  second.dispose();

  const third = f.controller();
  assert.equal((await third.refresh()).canPublish, true);
  assert.equal(JSON.parse(await fs.readFile(journalPath, 'utf8')).createAnchor, anchor);
  const published = await third.publish();
  assert.equal(published.status, 'published');
  assert.equal(published.postID, 41);
  assert.equal(f.state.post.id, 41);
  assert.equal(f.state.post.status, 'publish');
  assert.equal(f.state.writes.filter(write => write === 'create').length, 1);
  assert.equal(f.state.writes.filter(write => write === 'media').length, 1);
  assert.equal(f.state.lookups.length, 1);
  third.dispose();
});
