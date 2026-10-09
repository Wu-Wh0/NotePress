'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function loadPlugin() {
  const entry = path.resolve(__dirname, '../desktop/entry.js');
  const realRequire = createRequire(entry);
  class Plugin {
    constructor(app) { this.app = app; }
    registerView() {}
    addCommand() {}
    addRibbonIcon() {}
    registerEvent() {}
    loadData() { return Promise.resolve({}); }
    saveData() { return Promise.resolve(); }
    addSettingTab(tab) { this.app.settingTabs ??= []; this.app.settingTabs.push(tab); }
  }
  class PluginSettingTab {
    constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = { empty() {} }; }
  }
  class Setting {
    constructor(containerEl) { this.controlEl = {}; this.containerEl = containerEl; }
    setName() { return this; }
    setDesc() { return this; }
    addText(callback) { callback({ setPlaceholder() { return this; }, setValue() { return this; }, onChange() { return this; } }); return this; }
    addButton(callback) { callback({ setButtonText() { return this; }, onClick() { return this; } }); return this; }
  }
  class SecretComponent {
    constructor() {}
    setValue() { return this; }
    onChange() { return this; }
  }
  class MockSettingsTab extends PluginSettingTab { display() {} }
  const obsidian = { Plugin, PluginSettingTab, Setting, SecretComponent, Notice: class {}, ItemView: class {}, Modal: class {} };
  const module = { exports: {} };
  const factory = vm.runInThisContext(`(function(require,module,exports,__dirname){\n${fs.readFileSync(entry, 'utf8')}\n})`, { filename: entry });
  factory(id => id === 'obsidian' ? obsidian : id === './settings' ? MockSettingsTab : id === './connection' ? { probeWordPress: async () => ({}) } : realRequire(id),
    module, module.exports, path.dirname(entry));
  return module.exports;
}
function host() {
  const callbacks = { workspace: new Map(), vault: new Map() };
  const note = { path: 'notes/example.md' };
  const events = target => ({ on(name, callback) { callbacks[target].set(name, callback); return {}; } });
  const app = {
    workspace: { ...events('workspace'), getActiveFile: () => note, getLeavesOfType: () => [] },
    vault: { ...events('vault'), adapter: { getBasePath: () => '' } },
  };
  return { app, callbacks, note };
}

test('fixed input detects image drift without a vault event and clears the stale preview', async () => {
  const temp = fs.mkdtempSync(path.join(process.env.TMPDIR || 'E:/Hermes/cache/scratch', 'desktop-image-drift-'));
  try {
    fs.mkdirSync(path.join(temp, 'notes'));
    fs.writeFileSync(path.join(temp, 'notes/example.md'), '![approved](cover.png)\n');
    const imagePath = path.join(temp, 'notes/cover.png');
    fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgZGL+DwABFAEG1rmmRQAAAABJRU5ErkJggg==', 'base64'));
    const { app, note } = host();
    app.vault.adapter.getBasePath = () => temp;
    const plugin = new (loadPlugin())(app);
    await plugin.onload();
    const session = plugin.ensureSession(note);
    const approved = require('../desktop/core').readApprovedPng(temp, note.path, 'cover.png');
    session.approvedAssets['cover.png'] = { sha256: approved.sha256, mime: 'image/png' };
    plugin.resources = { 'assets/katex.min.css': Buffer.from('body{}') };
    plugin.fixedInput = { stale: true };
    let clears = 0;
    plugin.previewView = { clear() { clears += 1; } };
    const oldGeneration = plugin.generation.begin();
    // Deliberately do not deliver a vault event: the capture path must fail closed itself.
    fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPg5GD/DwABTgEYKZ81xwAAAABJRU5ErkJggg==', 'base64'));
    await plugin.generateFixedInput();
    assert.equal(plugin.fixedInput, null);
    assert.equal(session.approvedAssets['cover.png'], undefined);
    assert.equal(plugin.generation.isCurrent(oldGeneration), false);
    assert.equal(clears, 1, 'image drift must clear the previously displayed preview');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('fixed input blocks unapproved image syntax and clears a previous package', async () => {
  const temp = fs.mkdtempSync(path.join(process.env.TMPDIR || 'E:/Hermes/cache/scratch', 'desktop-block-'));
  try {
    fs.mkdirSync(path.join(temp, 'notes'));
    fs.writeFileSync(path.join(temp, 'notes/example.md'), '![unapproved](unapproved.png)\n');
    fs.mkdirSync(path.join(temp, '.obsidian/plugins/blog-publisher-local'), { recursive: true });
    fs.writeFileSync(path.join(temp, '.obsidian/plugins/blog-publisher-local/main.js'), 'synthetic-bundle');
    const { app, note } = host();
    app.workspace.getActiveFile = () => note;
    app.vault.adapter.getBasePath = () => temp;
    const plugin = new (loadPlugin())(app);
    plugin.manifest = { dir: '.obsidian/plugins/blog-publisher-local' };
    plugin.onload();
    plugin.resources = { 'assets/katex.min.css': Buffer.from('body{}') };
    plugin.fixedInput = { stale: true };
    await plugin.generateFixedInput();
    assert.equal(plugin.fixedInput, null);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('saved capture accepts host-normalized CRLF editor text without rewriting source bytes', async () => {
  const temp = fs.mkdtempSync(path.join(process.env.TMPDIR || 'E:/Hermes/cache/scratch', 'desktop-crlf-'));
  try {
    fs.mkdirSync(path.join(temp, 'notes'));
    const raw = 'First\r\nSecond\r\n';
    fs.writeFileSync(path.join(temp, 'notes/example.md'), raw);
    const { app, note } = host();
    app.vault.adapter.getBasePath = () => temp;
    let value = raw.replaceAll('\r\n', '\n');
    app.workspace.getLeavesOfType = () => [{ view: { file: note, getMode: () => 'source', editor: { getValue: () => value } } }];
    const plugin = new (loadPlugin())(app);
    assert.equal(await plugin.capture(note, true), raw);
    value = 'changed\n';
    await assert.rejects(() => plugin.capture(note, true), /note_unsaved/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('fixed input locates installed assets through the host manifest directory', async () => {
  const temp = fs.mkdtempSync(path.join(process.env.TMPDIR || 'E:/Hermes/cache/scratch', 'desktop-host-dir-'));
  try {
    fs.mkdirSync(path.join(temp, 'notes'));
    fs.writeFileSync(path.join(temp, 'notes/example.md'), 'Plain body\n');
    const relative = '.obsidian/plugins/blog-publisher-local';
    fs.cpSync(path.resolve(__dirname, '../../../../publication-v1/direct-plugin/dist'), path.join(temp, relative), { recursive: true });
    const { app } = host();
    app.vault.adapter.getBasePath = () => temp;
    const plugin = new (loadPlugin())(app);
    plugin.manifest = { dir: relative };
    await plugin.onload();
    await plugin.generateFixedInput();
    assert.ok(plugin.fixedInput, 'host manifest directory must be used instead of loader __dirname');
    assert.equal(JSON.parse(plugin.fixedInput.manifestBytes).selected, 'notes/example.md');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('capture rejects conflicting editors for the same selected note', async () => {
  const temp = fs.mkdtempSync(path.join(process.env.TMPDIR || 'E:/Hermes/cache/scratch', 'desktop-conflict-'));
  try {
    fs.mkdirSync(path.join(temp, 'notes'));
    fs.writeFileSync(path.join(temp, 'notes/example.md'), 'saved');
    const { app, note } = host();
    app.vault.adapter.getBasePath = () => temp;
    app.workspace.getLeavesOfType = () => ['saved', 'different'].map(value => ({ view: {
      file: note, getMode: () => 'source', editor: { getValue: () => value },
    } }));
    const plugin = new (loadPlugin())(app);
    await assert.rejects(() => plugin.capture(note, false), /conflicting_editors/);
    await assert.rejects(() => plugin.capture(note, true), /conflicting_editors/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('registered vault changes invalidate only selected source and approved image inputs', async () => {
  const { app, callbacks, note } = host();
  const plugin = new (loadPlugin())(app);
  await plugin.onload();
  plugin.ensureSession(note);
  plugin.session.approvedAssets['cover.png'] = { sha256: 'a'.repeat(64), mime: 'image/png' };
  plugin.fixedInput = { packageSha256: 'old' };
  const modify = callbacks.vault.get('modify');
  assert.equal(typeof modify, 'function', 'plugin must subscribe to approved input changes on disk');
  modify({ path: 'unrelated.png' });
  assert.equal(plugin.fixedInput.packageSha256, 'old');
  modify({ path: 'notes/cover.png' });
  assert.equal(plugin.fixedInput, null);
  assert.equal(plugin.session.approvedAssets['cover.png'], undefined);
  plugin.fixedInput = { packageSha256: 'old-source' };
  modify(note);
  assert.equal(plugin.fixedInput, null);
});

test('registered editor change invalidates the actual prepared input and old preview generation', async () => {
  const { app, callbacks, note } = host();
  const plugin = new (loadPlugin())(app);
  await plugin.onload();
  plugin.ensureSession(note);
  let clears = 0;
  plugin.previewView = { clear: () => { clears += 1; } };
  plugin.renderPreview = async () => {};
  const old = plugin.generation.begin();
  plugin.fixedInput = { packageSha256: 'old' };
  const change = callbacks.workspace.get('editor-change');
  assert.equal(typeof change, 'function', 'plugin must subscribe to the real editor-change event');
  change({}, { file: note });
  assert.equal(plugin.fixedInput, null);
  assert.equal(plugin.generation.isCurrent(old), false);
  assert.ok(clears > 0);
  plugin.fixedInput = { packageSha256: 'unchanged' };
  change({}, { file: { path: 'unrelated.md' } });
  assert.equal(plugin.fixedInput.packageSha256, 'unchanged');
});
