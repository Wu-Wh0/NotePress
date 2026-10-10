'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHostController, sanitizeSettings } = require('../src/host-controller');

class FakeTFile {
  constructor(path, bytes = Buffer.alloc(0), extension) {
    this.path = path;
    this.basename = path.split('/').at(-1).replace(/\.[^.]+$/, '');
    this.extension = extension || path.split('.').at(-1).toLowerCase();
    this.bytes = Buffer.from(bytes);
    this.stat = { size: this.bytes.length, mtime: 1 };
  }
}

function references(source) {
  if (/!\[\[[^\]]+\.md(?:\|[^\]]*)?\]\]/i.test(source)) throw new Error('unsupported_note_embed');
  return [...source.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => ({
    sourcePath: match[1],
    alt: '',
    kind: /^https?:\/\//i.test(match[1]) ? 'remote' : 'local',
  }));
}

function fixture({ source = '正文', files = {}, publisherHooks = {}, store = null, maxImageBytes, maxTotalImageBytes } = {}) {
  const note = new FakeTFile('notes/post.md');
  const settings = { siteUrl: 'https://blog.example', username: 'writer', secretRef: 'wp-password' };
  const counters = { reads: [], resolves: [], objectUrls: 0, revoked: [], probe: 0, publish: 0, checkStatus: 0 };
  const fileMap = new Map([['notes/post.md', note], ...Object.entries(files).map(([path, bytes]) => [path, new FakeTFile(path, bytes)])]);
  const state = { source, selected: note, settings };
  const memoryStore = store || {
    async load() { return null; },
    async save() {},
  };
  const controller = createHostController({
    getSettings: () => state.settings,
    getSelectedFile: () => state.selected,
    isFile: (file) => file instanceof FakeTFile,
    readSource: async () => state.source,
    resolveImage: async (path, notePath) => {
      counters.resolves.push([path, notePath]);
      if (path.includes('/')) return fileMap.get(path.startsWith('./') ? `notes/${path.slice(2)}` : `notes/${path}`) || fileMap.get(path);
      return fileMap.get(`notes/${path}`) || null;
    },
    readBinary: async (file) => {
      counters.reads.push(file.path);
      return file.bytes;
    },
    getSecret: (ref) => ref === 'wp-password' ? 'synthetic-secret' : null,
    extractImageReferences: references,
    renderArticle: ({ source: body, title, assetUrls }) => ({
      blocked: false,
      html: `<article><h1>${title}</h1><p>${body}</p>${Object.values(assetUrls).map((url) => `<img src="${url}">`).join('')}</article>`,
      bodyHtml: `<p>${body}</p>`,
      issues: [],
    }),
    createObjectURL: () => `blob:synthetic/${++counters.objectUrls}`,
    revokeObjectURL: (url) => counters.revoked.push(url),
    createClient: () => ({ async probe() { counters.probe += 1; return { ownerID: 7 }; } }),
    createPublisher: ({ client }) => ({
      async publish(plan) {
        await client.probe();
        counters.publish += 1;
        if (publisherHooks.publish) return publisherHooks.publish(plan, counters);
        return { status: 'published', postID: 9, link: 'https://blog.example/post/9' };
      },
      async checkStatus(noteID, plan) {
        await client.probe();
        counters.checkStatus += 1;
        if (publisherHooks.checkStatus) return publisherHooks.checkStatus(noteID, plan, counters);
        return { status: 'published', postID: 9, link: 'https://blog.example/post/9' };
      },
    }),
    getStore: () => memoryStore,
    ...(maxImageBytes === undefined ? {} : { maxImageBytes }),
    ...(maxTotalImageBytes === undefined ? {} : { maxTotalImageBytes }),
  });
  return { controller, state, counters, note, fileMap, memoryStore };
}

test('settings whitelist drops plaintext or unknown fields and never promotes them to secretRef', () => {
  assert.deepEqual(sanitizeSettings({
    siteUrl: 'https://blog.example', username: 'writer', secretRef: 'wp-password',
    password: 'NEVER_STORE', secret: 'NEVER_STORE', localCssPath: 'C:/private.css', extra: 'x',
  }), { siteUrl: 'https://blog.example', username: 'writer', secretRef: 'wp-password' });
});

test('manual reconciliation is visible after reload and does not promise automatic checking', async () => {
  for (const stage of ['creating', 'uploading-media']) {
    const f = fixture({ store: { async load() { return { siteUrl: 'https://blog.example', stage, media: [] }; }, async save() {} },
      publisherHooks: {
        publish: async () => ({ status: 'needs-check', manualRequired: true }),
        checkStatus: async () => ({ status: 'needs-check', manualRequired: true }),
      } });
    const preview = await f.controller.refresh();
    assert.equal(preview.manualRequired, true);
    assert.equal(preview.canPublish, false);
    assert.equal(preview.issues.some(issue => issue.code === 'manual_check'), true);
    assert.match((await f.controller.publish()).message, /人工核对/);
    assert.match((await f.controller.checkStatus()).message, /人工核对/);
    f.controller.dispose();
  }
});

test('only anchored schema 2 creating offers a read-only status check', async () => {
  let saved = 0;
  const f = fixture({ store: { async load() { return { schema: 2,
    createAnchor: `obsidian-create-${'a'.repeat(32)}`, siteUrl: 'https://blog.example', stage: 'creating', media: [] }; },
  async save() { saved += 1; } }, publisherHooks: {
    checkStatus: async () => ({ status: 'draft', postID: 9, canResume: true }),
  } });
  const preview = await f.controller.refresh();
  assert.equal(preview.needsCheck, true);
  assert.equal(preview.manualRequired, false);
  assert.equal(f.counters.checkStatus, 0);
  assert.equal(saved, 0);
  await f.controller.checkStatus();
  assert.equal(f.counters.checkStatus, 1);
  assert.equal(f.counters.publish, 0);
  f.controller.dispose();
});

test('preview resolves only the selected note image and never probes or writes', async () => {
  const f = fixture({ source: '正文 ![cover](assets/pic.png)', files: { 'notes/assets/pic.png': Buffer.from('image') } });
  const preview = await f.controller.refresh();

  assert.equal(preview.status, 'ready');
  assert.deepEqual(f.counters.resolves, [['assets/pic.png', 'notes/post.md']]);
  assert.deepEqual(f.counters.reads, ['notes/assets/pic.png']);
  assert.equal(preview.html.includes('blob:synthetic/1'), true);
  assert.equal(f.counters.probe, 0);
  assert.equal(f.counters.publish, 0);
  assert.equal(f.counters.checkStatus, 0);
  assert.equal(preview.noteID.length, 64);
  assert.doesNotMatch(JSON.stringify(preview), /notes\/post\.md|notes\/assets/);
});

test('remote images are placeholders and never resolve or fetch automatically', async () => {
  const f = fixture({ source: '![remote](https://images.example/photo.png)' });
  const preview = await f.controller.refresh();

  assert.equal(preview.status, 'warning');
  assert.deepEqual(f.counters.resolves, []);
  assert.deepEqual(f.counters.reads, []);
  assert.match(preview.html, /https:\/\/preflight\.invalid\/image/);
  assert.deepEqual(preview.issues.map(({ code }) => code), ['remote_image']);
});

test('basename-only image references fail closed when the native resolver cannot prove uniqueness', async () => {
  const f = fixture({ source: '![cover](cover.png)', files: { 'notes/cover.png': Buffer.from('image') } });
  const preview = await f.controller.refresh();

  assert.equal(preview.status, 'warning');
  assert.deepEqual(preview.issues.map(({ code }) => code), ['ambiguous_image']);
  assert.deepEqual(f.counters.reads, []);
});

test('image reads are bounded before bytes are loaded', async () => {
  const f = fixture({ source: '![cover](assets/pic.png)', files: { 'notes/assets/pic.png': Buffer.alloc(8) }, maxImageBytes: 4 });
  const preview = await f.controller.refresh();

  assert.equal(preview.status, 'warning');
  assert.deepEqual(preview.issues.map(({ code }) => code), ['image_too_large']);
  assert.deepEqual(f.counters.reads, []);
});

test('source, image, selection and settings changes invalidate the frozen publication plan', async () => {
  for (const mutate of [
    (f) => { f.state.source = 'changed'; },
    (f) => { const image = f.fileMap.get('notes/assets/pic.png'); image.bytes = Buffer.from('changed'); image.stat = { size: image.bytes.length, mtime: 2 }; },
    (f) => { f.state.selected = new FakeTFile('notes/other.md'); f.controller.invalidate('active-leaf-change'); f.state.selected = f.note; f.controller.invalidate('active-leaf-change'); },
    (f) => { f.state.settings = { ...f.state.settings, siteUrl: 'https://other.example' }; f.controller.setSettings(); },
    (f) => { f.state.settings = { ...f.state.settings, previewCssPath: 'styles/new.css' }; },
    (f) => { f.controller.invalidate('preview-style-change'); },
  ]) {
    let plan;
    const f = fixture({
      source: '![cover](assets/pic.png)',
      files: { 'notes/assets/pic.png': Buffer.from('image') },
      publisherHooks: { publish: async (frozen) => { plan = frozen; return { status: 'blocked' }; } },
    });
    const result = await f.controller.publish();
    assert.equal(result.status, 'blocked');
    assert.equal(await plan.isCurrent(), true);
    mutate(f);
    assert.equal(await plan.isCurrent(), false);
  }
});

test('publish is explicit and checkStatus invokes only the read-only reconciliation method', async () => {
  const f = fixture({ source: '正文' });
  await f.controller.refresh();
  assert.equal(f.counters.probe, 0);
  assert.equal(f.counters.publish, 0);

  const checked = await f.controller.checkStatus();
  assert.equal(checked.status, 'published');
  assert.equal(f.counters.checkStatus, 1);
  assert.equal(f.counters.publish, 0);
  assert.equal(f.counters.probe, 1);

  const published = await f.controller.publish();
  assert.equal(published.status, 'published');
  assert.equal(f.counters.publish, 1);
  assert.equal(f.counters.probe, 2);
});

test('total image budget stops reading later resources', async () => {
  const f = fixture({
    source: '![one](assets/one.png) ![two](assets/two.png)',
    files: { 'notes/assets/one.png': Buffer.alloc(3), 'notes/assets/two.png': Buffer.alloc(3) },
    maxTotalImageBytes: 5,
  });
  const preview = await f.controller.refresh();

  assert.equal(preview.status, 'warning');
  assert.deepEqual(preview.issues.map(({ code }) => code), ['image_too_large']);
  assert.deepEqual(f.counters.reads, ['notes/assets/one.png']);
});

test('connection test performs only the read-only probe', async () => {
  const f = fixture();
  const result = await f.controller.testConnection();

  assert.equal(result.status, 'connected');
  assert.equal(f.counters.probe, 1);
  assert.equal(f.counters.publish, 0);
  assert.equal(f.counters.checkStatus, 0);
});

test('an input change during an awaited publish gate cancels the write', async () => {
  let entered;
  let release;
  const atGate = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let f;
  let writes = 0;
  f = fixture({
    source: '原文',
    publisherHooks: {
      publish: async (plan) => {
        entered();
        await gate;
        if (!await plan.isCurrent()) return { status: 'blocked', reason: 'input-changed' };
        writes += 1;
        return { status: 'published' };
      },
    },
  });
  const action = f.controller.publish();
  await atGate;
  f.state.source = '修改后的文本';
  f.controller.invalidate('editor-change');
  release();
  const result = await action;

  assert.equal(writes, 0);
  assert.equal(result.reason, 'input_changed');
});

test('preview generations revoke prior blob URLs and unload revokes the remaining lease', async () => {
  const f = fixture({ source: '![cover](assets/pic.png)', files: { 'notes/assets/pic.png': Buffer.from('image') } });
  await f.controller.refresh();
  await f.controller.refresh();
  assert.deepEqual(f.counters.revoked, ['blob:synthetic/1']);
  f.controller.dispose();
  assert.deepEqual(f.counters.revoked, ['blob:synthetic/1', 'blob:synthetic/2']);
});
