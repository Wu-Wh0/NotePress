'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const Module = require('node:module');

class FakeElement {
  constructor(tag, options = {}) {
    this.tag = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.style = {};
    this.textContent = options.text || '';
    if (options.cls) this.className = options.cls;
    for (const [key, value] of Object.entries(options.attr || {})) this.setAttribute(key, value);
  }
  createEl(tag, options) {
    const child = new FakeElement(tag, options);
    this.children.push(child);
    return child;
  }
  empty() { this.children = []; this.textContent = ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  async click() { for (const callback of this.listeners.click || []) await callback({ target: this }); }
}
class FakeModal {
  constructor(app) { this.app = app; this.contentEl = new FakeElement('div'); this.titleEl = new FakeElement('div'); }
  setTitle(value) { this.title = value; }
  open() { return this.onOpen(); }
  close() { return this.onClose?.(); }
}
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return {
    Plugin: class {}, Notice: class {}, ItemView: class {}, Modal: FakeModal,
  };
  return originalLoad.call(this, request, parent, isMain);
};
let EntryPreview;
try { EntryPreview = require('../plugin/main'); }
finally { Module._load = originalLoad; }
const { Coordinator } = require('../plugin/live');

const SELECTED = 'notes/selected.md';
const RELATIVE = 'images/cover.png';
const IMAGE = Buffer.from('synthetic-png-candidate');
const IMAGE_SHA = crypto.createHash('sha256').update(IMAGE).digest('hex');
const AUTH = `Bearer ${'x'.repeat(43)}`;

async function withCandidateServer(run, { delayed = false } = {}) {
  const requests = [];
  let release;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ method: req.method, path: req.url, body, authorization: req.headers.authorization });
      if (delayed) await new Promise(resolve => { release = resolve; });
      const payload = JSON.stringify({ path: body.path, sha256: IMAGE_SHA, mime: 'image/png', bytes: IMAGE.length });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { return await run({ origin, requests, release: () => release?.() }); }
  finally { release?.(); await new Promise(resolve => server.close(resolve)); }
}

function makePlugin(origin) {
  const app = { workspace: {} };
  const plugin = new EntryPreview();
  Object.assign(plugin, { app, config: { expectedVault: '/synthetic' } });
  plugin.setPublicationSession({
    origin, authorization: AUTH, selected: SELECTED, title: 'Filename title',
    approvedAssets: {}, approvedLabels: {},
  });
  const changes = [];
  plugin.live = { change: value => changes.push(value), stop() {} };
  plugin.writingView = { clearSessionPreview() {} };
  return { plugin, changes };
}
function findButton(root, label) {
  if (root.tag === 'button' && root.textContent === label) return root;
  for (const child of root.children) { const found = findButton(child, label); if (found) return found; }
  return undefined;
}

test('native writing-options modal requires a second click to approve a validated PNG and can remove it', async () => {
  await withCandidateServer(async ({ origin, requests }) => {
    const { plugin, changes } = makePlugin(origin);
    let persistentWrites = 0;
    plugin.saveData = async () => { persistentWrites++; };
    const configBefore = JSON.stringify(plugin.config);
    const modal = plugin.openWritingOptions();
    assert.ok(modal instanceof FakeModal);
    await modal.open();
    assert.equal(modal.noteLabel.textContent, `当前固定笔记：${SELECTED}`);
    modal.titleInput.value = 'Independent title';
    modal.assetPathInput.value = RELATIVE;

    await modal.inspectButton.click();
    assert.equal(requests.length, 1);
    assert.deepEqual({ method: requests[0].method, path: requests[0].path, body: requests[0].body }, {
      method: 'POST', path: '/v1/asset-candidate', body: { path: RELATIVE },
    });
    assert.equal(requests[0].authorization, AUTH);
    assert.match(modal.candidateStatus.textContent, new RegExp(IMAGE_SHA));
    assert.match(modal.candidateStatus.textContent, /尚未批准/);
    assert.deepEqual(plugin.publicationSession.approvedAssets, {}, 'candidate inspection alone is not approval');

    await modal.approveButton.click();
    assert.equal(plugin.publicationSession.title, 'Independent title');
    assert.deepEqual(plugin.publicationSession.approvedAssets, {
      [RELATIVE]: { sha256: IMAGE_SHA, mime: 'image/png' },
    });
    assert.deepEqual(changes.at(-1), { force: true });
    assert.equal(persistentWrites, 0);
    assert.equal(JSON.stringify(plugin.config), configBefore);
    assert.equal(findButton(modal.contentEl, '发布'), undefined);
    assert.equal(findButton(modal.contentEl, '批准发布'), undefined);

    assert.equal(modal.approvalRemoveButtons.length, 1);
    await modal.approvalRemoveButtons[0].click();
    assert.deepEqual(plugin.publicationSession.approvedAssets, {});
    assert.deepEqual(changes.at(-1), { force: true });
    assert.equal(persistentWrites, 0);
    modal.close();
  });
});

test('candidate response arriving after title/session change cannot become approval', async () => {
  await withCandidateServer(async ({ origin, release, requests }) => {
    const { plugin } = makePlugin(origin);
    const modal = plugin.openWritingOptions();
    await modal.open();
    modal.assetPathInput.value = RELATIVE;
    const pending = modal.inspectButton.click();
    while (requests.length === 0) await new Promise(resolve => setTimeout(resolve, 1));
    release();
    modal.titleInput.value = 'Newer title';
    await modal.applyTitleButton.click();
    release();
    await pending;
    assert.equal(modal.candidate, null);
    assert.deepEqual(plugin.publicationSession.approvedAssets, {});
    assert.equal(modal.approveButton.disabled, true);
    assert.match(modal.candidateStatus.textContent, /会话已变化|候选已失效/);
  }, { delayed: true });
});

test('approved-file modification revokes its hash and changing active note clears the local session', async () => {
  const handlers = {};
  let activeFile = { extension: 'md', path: SELECTED };
  const app = {
    vault: { on: (name, callback) => { handlers[`vault:${name}`] = callback; return {}; } },
    workspace: {
      getActiveFile: () => activeFile,
      on: (name, callback) => { handlers[`workspace:${name}`] = callback; return {}; },
      detachLeavesOfType() {},
    },
  };
  const plugin = new EntryPreview();
  Object.assign(plugin, {
    app, loadData: async () => ({ expectedVault: '/synthetic' }),
    registerView() {}, addCommand() {}, addRibbonIcon() {}, registerEvent() {},
  });
  await plugin.onload();
  plugin.setPublicationSession({
    origin: 'http://127.0.0.1:43127', authorization: AUTH, selected: SELECTED,
    title: 'Title', approvedAssets: { [RELATIVE]: { sha256: IMAGE_SHA, mime: 'image/png' } },
    approvedLabels: {},
  });
  const changes = [];
  let stopped = 0;
  plugin.live = { change: value => changes.push(value), stop: () => { stopped++; } };
  handlers['vault:modify']({ path: 'notes/images/cover.png' });
  assert.deepEqual(plugin.publicationSession.approvedAssets, {});
  assert.deepEqual(changes.at(-1), { force: true });

  handlers['workspace:file-open']({ path: 'notes/another.md' });
  assert.equal(plugin.publicationSession, null);
  assert.equal(stopped, 1);

  plugin.setPublicationSession({
    origin: 'http://127.0.0.1:43127', authorization: AUTH, selected: 'notes/another.md',
    title: 'Second title', approvedAssets: { [RELATIVE]: { sha256: IMAGE_SHA, mime: 'image/png' } },
    approvedLabels: {},
  });
  plugin.live = { change: value => changes.push(value), stop: () => { stopped++; } };
  activeFile = { extension: 'md', path: 'notes/third.md' };
  handlers['workspace:active-leaf-change']({ view: { file: activeFile } });
  assert.equal(plugin.publicationSession, null);
  assert.equal(stopped, 2);
  await plugin.onunload();
});

test('waiting hides a reusable preview without revoking its resource URLs', async () => {
  let factory;
  const app = { plugins: {getPlugin:()=>plugin}, vault: {on:()=>({})}, workspace: {on:()=>({})} };
  const plugin = new EntryPreview();
  Object.assign(plugin,{app,loadData:async()=>({expectedVault:'/synthetic'}),registerView:(id,f)=>{if(id==='blog-entry-writing-preview')factory=f;},addCommand(){},addRibbonIcon(){},registerEvent(){}});
  await plugin.onload();
  const view=factory({});view.app=app;view.contentEl=new FakeElement('div');
  await view.onOpen();
  let disposed=0;
  const out={srcdoc:'<p>cached preview</p>',dispose(){disposed++;}};
  view.showSessionPreview(out);
  view.update({state:'waiting'});
  assert.equal(view.frame.hidden,true);
  assert.equal(disposed,0,'waiting must not revoke still-reusable blob resources');
  view.update({state:'generating'});
  assert.equal(disposed,0);
  view.update({state:'synced',out});
  assert.equal(view.frame.hidden,false);
  await view.onClose();
  plugin.clearLiveNotice();
  assert.equal(disposed,1);
});

test('coordinator keys title and approvals, bypasses approved-asset cache, and drops in-flight stale options', async () => {
  let selected = { path: SELECTED, source_sha256: 'a'.repeat(64), title: 'Title A', approved_assets: {} };
  const events = [];
  const sent = [];
  let releaseOld;
  const coordinator = new Coordinator({
    capture: async () => ({ ...selected, approved_assets: { ...selected.approved_assets } }),
    send: async value => {
      sent.push({ title: value.title, assets: JSON.stringify(value.approved_assets) });
      if (value.title === 'Old pending title') {
        return await new Promise(resolve => { releaseOld = () => resolve({ title: value.title, expires_at: Date.now() / 1000 + 60, dispose() { this.disposed = true; } }); });
      }
      return { title: value.title, expires_at: Date.now() / 1000 + 60, dispose() { this.disposed = true; } };
    },
    emit: event => events.push(event), delay: 30000,
  });
  async function runNow(force = false) {
    coordinator.change({ force });
    clearTimeout(coordinator.timer);
    coordinator.timer = null;
    return coordinator.run();
  }
  try {
    await runNow();
    selected = { ...selected, title: 'Title B' };
    await runNow();
    assert.equal(sent.length, 2, 'title-only update must not reuse by source hash');
    selected = { ...selected, path: 'notes/other.md', source_sha256: 'b'.repeat(64) };
    await runNow();
    assert.equal(sent.length, 3, 'path/source switching must miss the prior source cache');
    selected = { ...selected, path: SELECTED, source_sha256: 'a'.repeat(64) };
    await runNow();
    assert.equal(sent.length, 4);
    selected = { ...selected, approved_assets: { [RELATIVE]: { sha256: IMAGE_SHA, mime: 'image/png' } } };
    await runNow();
    await runNow();
    assert.equal(sent.length, 6, 'approved asset previews must recheck instead of reusing a cached response');

    selected = { ...selected, title: 'Old pending title' };
    const oldRun = runNow();
    while (!releaseOld) await new Promise(resolve => setTimeout(resolve, 1));
    selected = { ...selected, title: 'Current title' };
    const before = events.length;
    coordinator.change({ force: true });
    clearTimeout(coordinator.timer);
    coordinator.timer = null;
    releaseOld();
    await oldRun;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(sent.some(item => item.title === 'Current title'));
    assert.equal(events.slice(before).some(event => event.state === 'synced' && event.out?.title === 'Old pending title'), false);
  } finally { coordinator.stop(); }
});
