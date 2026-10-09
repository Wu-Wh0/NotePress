const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const Module = require('node:module');

// The plugin entry depends on Obsidian host classes; the behavior under test is real.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') {
    return {
      Plugin: class Plugin {},
      Notice: class Notice {},
      ItemView: class ItemView {},
      Modal: class Modal {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let EntryPreview;
try {
  EntryPreview = require('../plugin/main');
} finally {
  Module._load = originalLoad;
}

const selectedPath = '文章/学习/第一篇.md';
const savedText = '# 已保存正文';

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

async function withBridge(reply, run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ method: req.method, url: req.url, body });
      const out = reply({ req, body, origin: `http://127.0.0.1:${server.address().port}` });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run({ origin, requests });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function makeApp({ filePath = selectedPath, diskText = savedText, editorText, finalLeaf } = {}) {
  const file = { extension: 'md', path: filePath };
  const reads = [];
  const markdownLeaves = editorText === undefined ? [] : [{
    view: { file, getMode: () => 'source', editor: { getValue: () => editorText } },
  }];
  const workspace = {
    activeEditor: undefined,
    getActiveFile: () => file,
    getLeavesOfType(type) {
      if (type === 'markdown') return markdownLeaves;
      if (type === 'blog-entry-final-preview') return finalLeaf ? [finalLeaf] : [];
      if (type === 'blog-entry-writing-preview') return [];
      return [];
    },
    getLeaf() {
      return { view: { update() {} }, setViewState: async () => {} };
    },
    revealLeaf: async () => {},
  };
  const app = {
    vault: {
      adapter: { getBasePath: () => '/synthetic' },
      read: async requested => {
        reads.push(requested);
        return diskText;
      },
      getMarkdownFiles() {
        throw new Error('vault_enumeration_forbidden');
      },
    },
    workspace,
  };
  return { app, file, reads, workspace };
}

async function withConnectedBridge(run, { tamperAsset = false } = {}) {
  const requests = [];
  const operationId = '4'.repeat(32);
  const packageId = '5'.repeat(64);
  const title = '独立冻结标题';
  const css = Buffer.from('.frozen{color:#222}', 'utf8');
  const cssSha = sha256(css);
  const sourceSha = sha256(savedText);
  const labelsSha = sha256('{}');
  const titleSha = sha256(title);
  const sitePin = 'https://publication-v1.example.test';
  const snapshot = {
    schema: 'publication-v1', operation_key: operationId, selected: selectedPath,
    source_sha256: sourceSha, labels_sha256: labelsSha, title,
    publisher_id: 1, site_origin: `${sitePin}/`, visibility: 'public', target_id: 0,
    baseline_sha256: '6'.repeat(64), manifest_sha256: packageId,
    compiler: { name: 'fixture' }, compiler_sha256: '7'.repeat(64),
    inventory: { 'assets/katex.min.css': { bytes: css.length, sha256: cssSha, mime: 'text/css' } },
    content: '<p>冻结</p>', rendered: '<p>冻结字节</p>',
    policy: { schema: 'publication-v1' }, policy_sha256: '8'.repeat(64),
    expires_at: Math.floor(Date.now() / 1000) + 300,
  };
  const stable = value => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const snapshotJson = JSON.stringify(stable(snapshot));
  const digest = sha256(snapshotJson);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      requests.push({ method: req.method, url: req.url, body, authorization: req.headers.authorization });
      let status = 200;
      let value;
      if (req.url === '/v1/prepare' && req.method === 'POST') {
        status = 201;
        value = { operation_id: operationId, state: 'pending', remote_digest: digest,
          manifest_sha256: packageId, source_sha256: sourceSha, labels_sha256: labelsSha,
          title_sha256: titleSha, selected_path: selectedPath, image_sha256: {} };
      } else if (req.url === `/v1/frozen/${operationId}`) {
        value = { operation_id: operationId, digest, state: 'pending', snapshot_json: snapshotJson,
          package_id: packageId, publication_approval: false };
      } else if (req.url === `/v1/frozen/${operationId}/assets`) {
        const resourceBytes = tamperAsset ? Buffer.concat([css, Buffer.from('tamper')]) : css;
        value = { operation_id: operationId, digest, package_id: packageId, assets: {
          'assets/katex.min.css': { bytes: css.length, sha256: cssSha,
            content_type: 'text/css', data: resourceBytes.toString('base64') },
        } };
      } else {
        status = 404; value = { code: 'no_route' };
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { return await run({ origin, requests, operationId, packageId, digest, title, sitePin }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('actual final-preview entry accepts a Chinese nested selected note', async () => {
  await withBridge(({ origin }) => {
    const html = '<p>规范化预览</p>';
    const previewId = '1'.repeat(32);
    return {
      preview_id: previewId,
      package_id: '2'.repeat(64),
      digest: '3'.repeat(64),
      html,
      preview_sha256: sha256(html),
      preview_url: `${origin}/preview/${previewId}`,
      state: 'pending',
      publication_approval: false,
    };
  }, async ({ origin, requests }) => {
    const finalLeaf = { view: { show() {}, invalidate() {} } };
    const { app, file, reads } = makeApp({ finalLeaf });
    const plugin = new EntryPreview();
    Object.assign(plugin, {
      app,
      config: { expectedVault: '/synthetic', bridgeOrigin: origin },
      freezeEpoch: 0,
      busy: false,
    });

    const result = await plugin.generate();

    assert.equal(result.ok, true, result.code);
    assert.equal(result.path, selectedPath);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/generate');
    assert.deepEqual(requests[0].body, {
      path: selectedPath,
      source_sha256: sha256(savedText),
    });
    assert.deepEqual(reads, [file, file]);
  });
});

for (const [changeLabel, changedPath] of [['source', selectedPath], ['labels', selectedPath.replace(/\.md$/, '.labels.json')]]) {
test(`explicit connected session presents the frozen snapshot and invalidates on ${changeLabel} edits`, async () => {
  await withConnectedBridge(async ({ origin, requests, operationId, packageId, digest, title, sitePin }) => {
    class Element {
      constructor(tag, options = {}) { this.tag = tag; this.attributes = {}; this.style = {}; this.children = []; this.textContent = options.text || ''; }
      createEl(tag, options) { const child = new Element(tag, options); this.children.push(child); return child; }
      empty() { this.children = []; this.textContent = ''; }
      setAttribute(name, value) { this.attributes[name] = String(value); }
      removeAttribute(name) { delete this.attributes[name]; }
    }
    const finalLeaf = { view: null };
    const { app, reads } = makeApp({ finalLeaf });
    const vaultEvents = {};
    app.vault.on = (type, handler) => { vaultEvents[type] = handler; return {}; };
    app.workspace.on = () => ({});
    app.workspace.detachLeavesOfType = () => {};
    const plugin = new EntryPreview();
    const factories = {};
    Object.assign(plugin, {
      app, freezeEpoch: 0, busy: false, loadData: async () => ({ expectedVault: '/synthetic' }),
      registerView: (id, factory) => { factories[id] = factory; }, addCommand() {}, addRibbonIcon() {}, registerEvent() {},
    });
    await plugin.onload();
    const view = factories['blog-entry-final-preview'](finalLeaf);
    view.app = app;
    view.contentEl = new Element('div');
    await view.onOpen();
    view.frame.ownerDocument = { defaultView: {
      Blob: class Blob { constructor(parts, options) { this.parts = parts; this.type = options.type; } },
      URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} },
    } };
    finalLeaf.view = view;
    plugin.setPublicationSession({
      origin, authorization: `Bearer ${'x'.repeat(43)}`, selected: selectedPath, title,
      approvedAssets: {}, approvedLabels: {}, workflowConnected: true, sitePin,
    });

    const result = await plugin.generate();

    assert.equal(result.ok, true, result.code);
    assert.equal(result.operation_id, operationId);
    assert.equal(result.package_id, packageId);
    assert.equal(result.digest, digest);
    assert.deepEqual(requests.map(item => `${item.method} ${item.url}`), [
      'POST /v1/prepare', `GET /v1/frozen/${operationId}`, `GET /v1/frozen/${operationId}/assets`,
    ]);
    assert.ok(requests.every(item => item.authorization === `Bearer ${'x'.repeat(43)}`));
    assert.equal(requests[0].body.title, title);
    assert.equal(reads.length, 4);
    assert.match(view.frame.srcdoc, /冻结字节/);
    assert.match(view.frame.srcdoc, /Content-Security-Policy/);
    assert.equal(view.frame.attributes.sandbox, 'allow-same-origin');
    assert.equal(view.frame.src, undefined, 'frozen rendering must not navigate the iframe to WordPress');
    vaultEvents.modify({ path: changedPath });
    assert.equal(view.frame.hidden, true, 'editing the source must immediately hide the frozen frame');
    assert.equal(plugin.last.valid, false, 'editing must invalidate the displayed confirmation state');
  });
});
}

test('session drift during pane reveal prevents presenting the stale frozen result', async () => {
  await withConnectedBridge(async ({ origin, title, sitePin }) => {
    const frame = { ownerDocument: { defaultView: {
      Blob: class Blob {}, URL: { createObjectURL: () => 'blob:drift', revokeObjectURL() {} },
    } }, removeAttribute() {}, setAttribute() {} };
    let shown = false;
    const finalLeaf = { view: { frame, show() { shown = true; }, invalidate() {} } };
    const { app } = makeApp({ finalLeaf });
    const plugin = new EntryPreview();
    Object.assign(plugin, { app, config: { expectedVault: '/synthetic' }, freezeEpoch: 0, busy: false });
    plugin.setPublicationSession({
      origin, authorization: `Bearer ${'x'.repeat(43)}`, selected: selectedPath, title,
      approvedAssets: {}, approvedLabels: {}, workflowConnected: true, sitePin,
    });
    app.workspace.revealLeaf = async () => plugin.setPublicationSession(null);

    const result = await plugin.generate();

    assert.equal(result.ok, false);
    assert.equal(result.code, 'publication_session_changed');
    assert.equal(shown, false);
  });
});

test('frozen renderer rejects resource bytes that differ from the bound inventory', async () => {
  const { renderFrozenSession } = require('../plugin/session_client');
  await withConnectedBridge(async ({ origin, operationId, packageId, digest, title, sitePin }) => {
    const session = {
      origin, authorization: `Bearer ${'x'.repeat(43)}`, selected: selectedPath, title,
      approvedAssets: {}, workflowConnected: true, sitePin,
    };
    const selected = { path: selectedPath, source_sha256: sha256(savedText) };
    const receipt = {
      operation_id: operationId, state: 'pending', digest, package_id: packageId,
      source_sha256: selected.source_sha256, labels_sha256: sha256('{}'), title_sha256: sha256(title),
    };
    let created = 0;
    const browserWindow = {
      Blob: class Blob {},
      URL: { createObjectURL() { created++; return 'blob:unexpected'; }, revokeObjectURL() {} },
    };
    await assert.rejects(renderFrozenSession(session, selected, receipt, browserWindow), /frozen_asset_integrity_invalid/);
    assert.equal(created, 0, 'unverified bytes must never become renderable blob URLs');
  }, { tamperAsset: true });
});

test('frozen renderer pins snapshot digest to the prepared receipt', async () => {
  const { renderFrozenSession } = require('../plugin/session_client');
  await withConnectedBridge(async ({ origin, operationId, packageId, title, sitePin }) => {
    const session = { origin, authorization: `Bearer ${'x'.repeat(43)}`, selected: selectedPath,
      title, approvedAssets: {}, workflowConnected: true, sitePin };
    const selected = { path: selectedPath, source_sha256: sha256(savedText) };
    const receipt = { operation_id: operationId, digest: '0'.repeat(64), package_id: packageId,
      source_sha256: selected.source_sha256, labels_sha256: sha256('{}'), title_sha256: sha256(title) };
    const browserWindow = { Blob: class Blob {},
      URL: { createObjectURL: () => 'blob:unexpected', revokeObjectURL() {} } };
    await assert.rejects(renderFrozenSession(session, selected, receipt, browserWindow), /frozen_snapshot_invalid/);
  });
});

test('actual live entry accepts the Chinese note and captures unsaved editor text', async () => {
  const unsavedText = '# 尚未保存的正文';
  await withBridge(({ body, origin }) => {
    const html = '<p>实时预览</p>';
    return {
      html,
      preview_sha256: sha256(html),
      preview_url: `${origin}/live/preview`,
      mode: 'live',
      state: 'live',
      publication_approval: false,
      path: body.path,
      source_sha256: body.source_sha256,
    };
  }, async ({ origin, requests }) => {
    const { app, reads } = makeApp({ editorText: unsavedText });
    const events = [];
    app.workspace.getLeaf = () => ({
      view: { update: event => events.push(event) },
      setViewState: async () => {},
    });
    const plugin = new EntryPreview();
    Object.assign(plugin, {
      app,
      config: { expectedVault: '/synthetic', bridgeOrigin: origin },
    });

    const started = await plugin.startLive();
    assert.equal(started.ok, true);
    try {
      await plugin.live.run();
      assert.equal(plugin.liveLast.state, 'synced');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, '/live');
      assert.equal(requests[0].body.path, selectedPath);
      assert.equal(requests[0].body.text, unsavedText);
      assert.equal(requests[0].body.source_sha256, sha256(unsavedText));
      assert.deepEqual(reads, []);
      assert.equal(events.at(-1).state, 'synced');
    } finally {
      plugin.live?.stop();
    }
  });
});
