'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

class FakeElement {
  constructor(tag = 'div', options = {}) {
    this.tagName = tag;
    this.children = [];
    this.attributes = { ...(options.attr || {}) };
    this.textContent = options.text || '';
    this.listeners = {};
    this.disabled = false;
    this.srcdoc = '';
  }
  empty() { this.children = []; this.textContent = ''; }
  createDiv(options = {}) { return this.createEl('div', options); }
  createSpan(options = {}) { return this.createEl('span', options); }
  createEl(tag, options = {}) {
    const element = new FakeElement(tag, options);
    this.children.push(element);
    return element;
  }
  setText(text) { this.textContent = String(text); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  click() { if (!this.disabled) this.listeners.click?.({ target: this }); }
}

class FakeTFile {
  constructor(pathName, extension = 'md') {
    this.path = pathName;
    this.basename = path.posix.basename(pathName, `.${extension}`);
    this.extension = extension;
    this.stat = { size: 0, mtime: 1 };
  }
}

class FakePlugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
    this.registeredEvents = [];
  }
  async loadData() { return { siteUrl: 'https://blog.example', username: 'writer', secretRef: 'saved-ref', password: 'DO_NOT_KEEP' }; }
  async saveData(value) { this.savedData = value; }
  registerEvent(event) { this.registeredEvents.push(event); }
  registerView(type, factory) { this.viewType = type; this.viewFactory = factory; }
  addRibbonIcon(icon, label, callback) { this.ribbon = { icon, label, callback }; }
  addCommand(command) { this.command = command; }
  addSettingTab(tab) { this.settingsTab = tab; }
}

class FakeItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.contentEl = new FakeElement('section');
  }
}

class FakePluginSettingTab {
  constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = new FakeElement('section'); }
}

const settingComponents = [];
class FakeSetting {
  constructor(container) { this.container = container; settingComponents.push(this); }
  setName(value) { this.name = value; return this; }
  setDesc(value) { this.desc = value; return this; }
  addText(callback) {
    const component = { value: '', setPlaceholder(value) { this.placeholder = value; return this; }, setValue(value) { this.value = value; return this; }, onChange(callback) { this.change = callback; return this; } };
    callback(component); this.textComponent = component; return this;
  }
  addComponent(callback) { const element = new FakeElement(); callback(element); this.customComponent = element.component; return this; }
  addButton(callback) {
    const component = { setButtonText(value) { this.text = value; return this; }, onClick(callback) { this.click = callback; return this; } };
    callback(component); this.buttonComponent = component; return this;
  }
}

class FakeSecretComponent {
  constructor(app, element) { this.app = app; this.element = element; element.component = this; }
  setValue(value) { this.value = value; return this; }
  onChange(callback) { this.change = callback; return this; }
}

class FakeMarkdownView {}
class FakeFileSystemAdapter { getBasePath() { return 'C:/synthetic-vault'; } }
const notices = [];
class FakeNotice { constructor(message) { notices.push(message); } }
const fakeObsidian = {
  Plugin: FakePlugin, ItemView: FakeItemView, PluginSettingTab: FakePluginSettingTab, Setting: FakeSetting,
  SecretComponent: FakeSecretComponent, MarkdownView: FakeMarkdownView, TFile: FakeTFile,
  FileSystemAdapter: FakeFileSystemAdapter, Notice: FakeNotice,
};

function loadMainWithSyntheticModules() {
  const entry = require.resolve('../src/main');
  delete require.cache[entry];
  const originalLoad = Module._load;
  const stubs = {
    obsidian: fakeObsidian,
    './article': {
      extractImageReferences: () => [],
      renderArticle: ({ title }) => ({ blocked: false, html: `<article><h1>${title}</h1><a href="https://outside.example">link</a></article>`, bodyHtml: '<p>test</p>', issues: [] }),
    },
    './wordpress-client': { createWordPressClient: () => { throw new Error('should not create on preview'); } },
    './publisher': { createPublisher: () => { throw new Error('should not create on preview'); } },
  };
  Module._load = function patched(request, parent, isMain) {
    if (parent?.filename === entry && Object.hasOwn(stubs, request)) return stubs[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return require(entry); }
  finally { Module._load = originalLoad; }
}

function makeApp() {
  const note = new FakeTFile('Drafts/post.md');
  const listeners = { workspace: {}, vault: {} };
  const markdownView = { file: note, editor: { getValue: () => '# Preview body' } };
  const activeLeaf = { async setViewState(state) { this.state = state; } };
  return {
    note, listeners,
    app: {
      workspace: {
        getActiveFile: () => note,
        getActiveViewOfType: () => markdownView,
        on(name, callback) { listeners.workspace[name] = callback; return { name }; },
        getRightLeaf: () => activeLeaf,
        getLeaf: () => activeLeaf,
        async revealLeaf(leaf) { this.revealed = leaf; },
      },
      vault: {
        adapter: new FakeFileSystemAdapter(),
        configDir: '.obsidian',
        cachedRead: async () => { throw new Error('cachedRead should not be used for active editor'); },
        readBinary: async () => new ArrayBuffer(0),
        on(name, callback) { listeners.vault[name] = callback; return { name }; },
      },
      metadataCache: { getFirstLinkpathDest: () => null },
      secretStorage: { getSecret: (reference) => reference === 'saved-ref' ? 'synthetic-only' : null },
    },
  };
}

test('CommonJS plugin entry registers native preview, command, settings, and a sandboxed no-network frame', async () => {
  const main = loadMainWithSyntheticModules();
  const { app } = makeApp();
  const plugin = new main(app, { id: 'synthetic-wordpress' });
  await plugin.onload();

  assert.equal(plugin.viewType, main.VIEW_TYPE);
  assert.equal(plugin.ribbon.label, '打开博客预览');
  assert.equal(plugin.command.id, 'open-blog-preview');
  assert.deepEqual(plugin.settings, { siteUrl: 'https://blog.example', username: 'writer', secretRef: 'saved-ref' });
  assert.deepEqual(plugin.savedData, { siteUrl: 'https://blog.example', username: 'writer', secretRef: 'saved-ref' });
  assert.equal(Object.hasOwn(plugin.settings, 'password'), false);
  const realAdapter = app.vault.adapter;
  app.vault.adapter = { getBasePath: () => 'C:/unsafe-fake-adapter' };
  assert.equal(plugin.getJournalStore(plugin.settings), null);
  app.vault.adapter = realAdapter;
  await plugin.updateSetting('username', 'writer-updated');
  assert.deepEqual(plugin.savedData, { siteUrl: 'https://blog.example', username: 'writer-updated', secretRef: 'saved-ref' });

  plugin.settingsTab.display();
  assert.ok(settingComponents.some((setting) => setting.customComponent instanceof FakeSecretComponent));
  assert.equal(settingComponents.find((setting) => setting.customComponent instanceof FakeSecretComponent).customComponent.value, 'saved-ref');

  const view = plugin.viewFactory({});
  await view.onOpen();
  await new Promise((resolve) => setTimeout(resolve, 190));
  assert.equal(view.frame.attributes.sandbox, '');
  assert.match(view.frame.srcdoc, /default-src 'none'/);
  assert.match(view.frame.srcdoc, /img-src blob: data:/);
  assert.match(view.frame.srcdoc, /frame-src 'none'/);
  assert.doesNotMatch(view.frame.srcdoc, /<script\b/i);
  assert.doesNotMatch(view.frame.srcdoc, /href="https:\/\/outside\.example"/);
  assert.equal(view.publishButton.disabled, false);
  assert.equal(view.checkButton.disabled, true);
  assert.equal(notices.length, 0);

  view.update({ html: '<p>synthetic</p>', siteUrl: 'https://blog.example', canPublish: false, needsCheck: true, manualRequired: true });
  assert.equal(view.publishButton.disabled, true);
  assert.equal(view.checkButton.disabled, true);
  assert.match(view.infoEl.children.map(child => child.textContent).join(''), /人工核对/);

  await view.onClose();
  await plugin.onunload();
});

test('frame builder rejects remote CSS imports, removes article links, and preserves native plain permalinks', () => {
  const main = loadMainWithSyntheticModules();
  const frame = main.buildFrameDocument('<article><a href="https://outside.example">label</a></article>', '@import url(https://outside.example/x.css);');
  assert.match(frame, /default-src 'none'/);
  assert.doesNotMatch(frame, /href="https:\/\/outside\.example"/);
  assert.doesNotMatch(frame, /outside\.example\/x\.css/);
  assert.equal(main.safePostUrl('https://blog.example/?p=41', 'https://blog.example'), 'https://blog.example/?p=41');
  assert.equal(main.safePostUrl('https://blog.example/?other=41', 'https://blog.example'), '');
  assert.equal(main.safePostUrl('https://attacker.example/post', 'https://blog.example'), '');
});

test('preview-focused publication reads unsaved source and rejects conflicting source buffers', async () => {
  const main = loadMainWithSyntheticModules();
  const { app, note } = makeApp();
  app.workspace.getActiveViewOfType = () => null;
  const view = { file: note, getMode: () => 'source', editor: { getValue: () => 'unsaved\r\nbody' } };
  app.workspace.getLeavesOfType = () => [{ view }];
  assert.equal(await main.readSelectedSource(app, note), 'unsaved\nbody');
  app.workspace.getLeavesOfType = () => [{ view }, { view: { ...view, editor: { getValue: () => 'other body' } } }];
  await assert.rejects(main.readSelectedSource(app, note), /conflicting_editors/);
});

test('font-inlined CSS larger than the old limit remains in the sandbox document', () => {
  const main = loadMainWithSyntheticModules();
  const css = '@font-face{font-family:KaTeX_Main;src:url("data:font/woff2;base64,' + 'A'.repeat(300000) + '")}';
  assert.match(main.buildFrameDocument('<p>math</p>', css), /font-family:KaTeX_Main/);
});
