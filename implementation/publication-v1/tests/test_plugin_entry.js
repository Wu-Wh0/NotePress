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

    assert.equal(result.ok, true);
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
