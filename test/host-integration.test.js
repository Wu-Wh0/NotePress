'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
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
  const state = { source: '正文 ![a](assets/a.png)', selected: note, previews: [], writes: [], post: null, bytes: image.bytes };
  image.stat.size = image.bytes.length;
  const siteUrl = 'https://blog.example';
  const store = () => createJournalStore({ directory, siteUrl });
  const client = {
    async probe() { return { ownerID: 2, capabilities: { publish_posts: true, upload_files: true } }; },
    async createPost(fields) { state.writes.push('create'); state.post = { id: 41, author: 2, title: { raw: fields.title }, content: { raw: fields.content }, status: fields.status, link: siteUrl + '/?p=41' }; return structuredClone(state.post); },
    async getPost(id) { assert.equal(id, 41); return structuredClone(state.post); },
    async updatePost(id, fields) { assert.equal(id, 41); state.writes.push('update'); for (const [key, value] of Object.entries(fields)) { if (key === 'title' || key === 'content') state.post[key] = { raw: value }; else state.post[key] = value; } return structuredClone(state.post); },
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
      createClient: () => client, createPublisher, getStore: store,
      createObjectURL: () => 'blob:synthetic/image', revokeObjectURL() {},
      onPreview: value => state.previews.push(value),
    });
  }
  return { state, image, controller, client };
}

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
