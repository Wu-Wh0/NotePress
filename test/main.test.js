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
    if (options.href) this.attributes.href = options.href;
    this.textContent = options.text || '';
    this.listeners = {};
    this.disabled = false;
    this.srcdoc = '';
    this.style = {};
    this.className = options.cls || '';
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
  addClass(value) { this.className = [this.className, value].filter(Boolean).join(' '); }
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
  addRibbonIcon(icon, label, callback) { this.ribbon = { icon, label, callback }; return new FakeElement('button', { attr: { 'aria-label': label, title: label } }); }
  addCommand(command) { this.commands ||= []; this.commands.push(command); if (!this.command) this.command = command; }
  removeCommand(id) { this.commands = (this.commands || []).filter(command => command.id !== id); }
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
class FakeModal {
  constructor(app) { this.app = app; this.contentEl = new FakeElement('section'); FakeModal.last = this; }
  open() { this.onOpen(); }
  close() { this.closed = true; }
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
  addDropdown(callback) {
    const component = {
      options: {},
      addOption(value, label) { this.options[value] = label; return this; },
      setValue(value) { this.value = value; return this; },
      onChange(callback) { this.change = callback; return this; },
    };
    callback(component); this.dropdownComponent = component; return this;
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
  Modal: FakeModal,
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
  const leaves = [];
  let createdLeafCount = 0;
  let workspace;
  const createLeaf = () => ({
    async setViewState(state) {
      await workspace.beforeSetViewState?.(this, state);
      this.state = state;
      if (!leaves.includes(this)) leaves.push(this);
    },
  });
  workspace = {
    getActiveFile: () => note,
    getActiveViewOfType: () => markdownView,
    on(name, callback) { listeners.workspace[name] = callback; return { name }; },
    getLeavesOfType: (type) => leaves.filter(leaf => leaf.state?.type === type),
    getRightLeaf: () => null,
    getLeaf: () => { createdLeafCount++; return createLeaf(); },
    get createdLeafCount() { return createdLeafCount; },
    async revealLeaf(leaf) { this.revealed = leaf; },
  };
  return {
    note, listeners,
    app: {
      workspace,
      vault: {
        adapter: new FakeFileSystemAdapter(),
        configDir: '.obsidian',
        cachedRead: async () => { throw new Error('cachedRead should not be used for active editor'); },
        readBinary: async () => new ArrayBuffer(0),
        getAbstractFileByPath: () => null,
        on(name, callback) { listeners.vault[name] = callback; return { name }; },
      },
      metadataCache: { getFirstLinkpathDest: () => null },
      secretStorage: { getSecret: (reference) => reference === 'saved-ref' ? 'synthetic-only' : null },
    },
  };
}

test('openPreview coalesces concurrent opens and reveals the existing preview leaf', async () => {
  const main = loadMainWithSyntheticModules();
  const { app } = makeApp();
  const plugin = new main(app, { id: 'synthetic-wordpress' });
  await plugin.onload();

  const pendingOpens = [];
  app.workspace.beforeSetViewState = () => new Promise(resolve => { pendingOpens.push(resolve); });
  const firstOpen = plugin.openPreview();
  const concurrentOpen = plugin.openPreview();
  const createdBeforeOpenCompletes = app.workspace.createdLeafCount;
  pendingOpens.forEach(resolve => resolve());
  await Promise.all([firstOpen, concurrentOpen]);
  assert.equal(createdBeforeOpenCompletes, 1);

  app.workspace.beforeSetViewState = null;
  const existingLeaf = app.workspace.revealed;
  await plugin.openPreview();
  assert.equal(app.workspace.createdLeafCount, 1);
  assert.equal(app.workspace.revealed, existingLeaf);
  await plugin.onunload();
});

test('native rename forwards the file and old path; preview and command open one local confirmation modal', async () => {
  const main = loadMainWithSyntheticModules();
  const { app, note, listeners } = makeApp();
  const plugin = new main(app, { id: 'synthetic-wordpress' });
  await plugin.onload();
  const calls = [];
  plugin.controller.noteRenamed = async (file, oldPath) => { calls.push([file, oldPath]); return true; };
  plugin.controller.proposedOldPath = () => 'Drafts/post.md';
  plugin.controller.restoreAssociation = async oldPath => { calls.push(['restore', oldPath]); return { status: 'restored', message: '关联已恢复，请核对后更新' }; };
  note.path = 'Drafts/moved.md';
  listeners.vault.rename(note, 'Drafts/post.md');
  await Promise.resolve();
  assert.deepEqual(calls[0], [note, 'Drafts/post.md']);
  const view = plugin.viewFactory({});
  await view.onOpen();
  view.update({ html: '<p>test</p>', canRestore: true, canPublish: false });
  assert.equal(view.restoreButton.hidden, false);
  view.restoreButton.click();
  assert.equal(FakeModal.last.oldPath, 'Drafts/post.md');
  const confirm = settingComponents.at(-1).buttonComponent;
  await confirm.click();
  assert.deepEqual(calls.at(-1), ['restore', 'Drafts/post.md']);
  assert.equal(FakeModal.last.closed, true);
  plugin.commands.find(command => command.id === 'restore-published-association').callback();
  assert.equal(FakeModal.last.oldPath, 'Drafts/post.md');
  await plugin.onunload();
  notices.length = 0;
});

test('native modal freezes opened note intent and blocks confirmation after selecting another note', async () => {
  const main = loadMainWithSyntheticModules();
  const { app, note, listeners } = makeApp();
  const plugin = new main(app, { id: 'synthetic-wordpress' });
  await plugin.onload();
  let bindings = 0;
  plugin.getJournalStore = () => { bindings += 1; throw new Error('should not bind'); };
  plugin.openRestoreModal();
  const modal = FakeModal.last;
  assert.equal(modal.target.file, note);
  assert.equal(modal.target.path, note.path);
  modal.oldPath = 'Drafts/former.md';
  app.workspace.getActiveFile = () => new FakeTFile('Drafts/other.md');
  listeners.workspace['active-leaf-change']();
  const confirm = settingComponents.at(-1).buttonComponent;
  await confirm.click();
  assert.equal(modal.closed, undefined);
  assert.equal(bindings, 0);
  await plugin.onunload();
  notices.length = 0;
});

test('CommonJS plugin entry registers native preview, command, settings, and a sandboxed no-network frame', async () => {
  const main = loadMainWithSyntheticModules();
  const { app } = makeApp();
  const plugin = new main(app, { id: 'synthetic-wordpress' });
  await plugin.onload();

  assert.equal(plugin.viewType, main.VIEW_TYPE);
  assert.equal(plugin.ribbon.label, '打开博客预览');
  assert.equal(plugin.command.id, 'open-blog-preview');
  assert.deepEqual(plugin.settings, { siteUrl: 'https://blog.example', username: 'writer', secretRef: 'saved-ref', uiLanguage: 'zh-CN' });
  assert.deepEqual(plugin.savedData, { siteUrl: 'https://blog.example', username: 'writer', secretRef: 'saved-ref', uiLanguage: 'zh-CN' });
  assert.equal(Object.hasOwn(plugin.settings, 'password'), false);
  const realAdapter = app.vault.adapter;
  app.vault.adapter = { getBasePath: () => 'C:/unsafe-fake-adapter' };
  assert.equal(plugin.getJournalStore(plugin.settings), null);
  app.vault.adapter = realAdapter;
  await plugin.updateSetting('username', 'writer-updated');
  assert.deepEqual(plugin.savedData, { siteUrl: 'https://blog.example', username: 'writer-updated', secretRef: 'saved-ref', uiLanguage: 'zh-CN' });

  plugin.settingsTab.display();
  const languageSetting = settingComponents.filter(setting => setting.name === '界面语言').at(-1);
  assert.deepEqual(languageSetting.dropdownComponent.options, { 'zh-CN': '简体中文', en: 'English' });
  assert.equal(languageSetting.dropdownComponent.value, 'zh-CN');
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
  assert.equal(view.publishButton.textContent, '发布文章');
  assert.equal(view.checkButton.disabled, true);
  assert.equal(notices.length, 0);

  view.update({ html: '<p>synthetic</p>', siteUrl: 'https://blog.example', canPublish: false, needsCheck: true, manualRequired: true });
  assert.equal(view.publishButton.disabled, true);
  assert.equal(view.checkButton.disabled, true);
  assert.match(view.infoEl.children.map(child => child.textContent).join(''), /人工核对/);

  await view.onClose();
  await plugin.onunload();
});

test('preview uses a panel-sized frame and one toolbar without a permanently disabled check action', async () => {
  const main = loadMainWithSyntheticModules();
  const { app } = makeApp();
  const plugin = new main(app, { id: 'synthetic-wordpress' });
  await plugin.onload();
  const view = plugin.viewFactory({});
  await view.onOpen();
  assert.equal(view.frame.style.height || '', '');
  assert.equal(view.frame.style.minHeight || '', '');
  assert.match(view.contentEl.className, /native-wordpress-preview/);
  const toolbar = view.contentEl.children.find(child => child.className === 'native-wordpress-toolbar');
  assert.ok(toolbar.children.includes(view.infoEl));
  view.update({ html: '<p>ready</p>', canPublish: true, siteUrl: 'https://blog.example' });
  assert.equal(view.checkButton.hidden, true);
  view.update({ html: '<p>pending</p>', canPublish: false, needsCheck: true, siteUrl: 'https://blog.example' });
  assert.equal(view.checkButton.hidden, false);
  assert.equal(view.checkButton.disabled, false);
  view.update({ html: '<p>manual</p>', needsCheck: true, manualRequired: true, siteUrl: 'https://blog.example' });
  assert.equal(view.checkButton.hidden, true);
  assert.equal(view.publishButton.disabled, true);
  await view.onClose();
  await plugin.onunload();
});

test('connection settings immediately invalidate displayed publication while save is pending', async () => {
  const main = loadMainWithSyntheticModules();
  const { app } = makeApp();
  const plugin = new main(app, { id: 'synthetic-wordpress' });
  await plugin.onload();
  const view = plugin.viewFactory({});
  await view.onOpen();
  await plugin.controller.refresh();
  assert.equal(view.publishButton.disabled, false);
  let release;
  plugin.saveData = () => new Promise(resolve => { release = resolve; });
  let calls = 0;
  plugin.controller.publish = async () => { calls++; return { status: 'published' }; };
  const change = plugin.updateSetting('siteUrl', 'https://new.example');
  await Promise.resolve();
  assert.equal(view.publishButton.disabled, true);
  assert.equal(plugin.lastPreview, null);
  await plugin.runAction('publish');
  assert.equal(calls, 0);
  release();
  await change;
  await plugin.controller.refresh();
  assert.equal(view.publishButton.disabled, false);
  assert.equal(plugin.lastPreview.siteUrl, 'https://new.example');
  await view.onClose();
  await plugin.onunload();
});

test('application password settings explain purpose, WordPress source, local labels, and revocation without a wizard', async () => {
  const main = loadMainWithSyntheticModules();
  const { app } = makeApp();
  const plugin = new main(app, { id: 'synthetic-wordpress' });
  await plugin.onload();
  plugin.settingsTab.display();
  const setting = settingComponents.filter(item => item.name === '应用程序密码').at(-1);
  assert.match(setting.desc, /发布文章/);
  assert.match(setting.desc, /不是.*登录密码/);
  const help = plugin.settingsTab.containerEl.children.find(child => child.tagName === 'details');
  assert.ok(help);
  assert.equal(help.children[0].tagName, 'summary');
  const text = help.children.map(child => child.textContent).join(' ');
  assert.match(text, /WordPress 后台.*个人资料.*应用程序密码/);
  assert.match(text, /名称只是.*标签/);
  assert.match(text, /撤销/);
  assert.equal(setting.customComponent.value, 'saved-ref');
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

test('opaque preview document keeps wide content inside local scrollers and wraps article text', () => {
  const main = loadMainWithSyntheticModules();
  const html = '<article><p>long-unbroken-link-text</p><ul><li><ul><li>nested-long-text</li></ul></li></ul><pre><code>  keep all code\n  and spaces</code></pre><table><tr><td>wide cell</td></tr></table><div class="math-scroll">wide math</div></article>';
  const frame = main.buildFrameDocument(html);
  const css = frame.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  assert.ok(css, 'styles must be inside the iframe document');
  assert.match(css, /article\{[^}]*overflow-wrap:anywhere/);
  assert.match(css, /article pre\{[^}]*max-width:100%[^}]*overflow-x:auto[^}]*white-space:pre/);
  assert.match(css, /article table\{[^}]*display:block[^}]*max-width:100%[^}]*overflow-x:auto/);
  assert.match(css, /\.math-scroll\{[^}]*max-width:100%[^}]*overflow-x:auto/);
  assert.ok(frame.includes(html), 'preview must retain the full code, table, list and math markup');
});

test('opaque sandbox image document uses only byte-backed local raster data URLs', () => {
  const main = loadMainWithSyntheticModules();
  const assets = new Map([['blob:synthetic/local', 'data:image/png;base64,aW1hZ2U='], ['blob:synthetic/unsafe', 'https://outside.example/image']]);
  const frame = main.buildFrameDocument('<article><img src="blob:synthetic/local"><img src="blob:synthetic/missing"><img src="blob:synthetic/unsafe"></article>', '', assets);
  assert.match(frame, /src="data:image\/png;base64,aW1hZ2U="/);
  assert.doesNotMatch(frame, /src="blob:|src="https:/);
  assert.match(frame, /script-src 'none'/);
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

test('custom CSS overrides built-in styling without changing sandbox or offline fonts', () => {
  const main = loadMainWithSyntheticModules();
  const css = 'article{color:tomato}';
  const frame = main.buildFrameDocument('<p>body</p>', '@font-face{src:url(data:font/woff2;base64,AAAA)}', new Map(), css);
  assert.ok(frame.indexOf(css) > frame.indexOf('@font-face'));
  assert.match(frame, /connect-src 'none'/);
  for (const unsafe of ['</style><script>alert(1)</script>', '@import "https://evil.test/x";', 'a{background:url(https://evil.test/x)}', 'a{background:u\\72l(https://evil.test/x)}', 'a{background:image-set("https://evil.test/x" 1x)}']) {
    assert.ok(!main.buildFrameDocument('', '', new Map(), unsafe).includes(unsafe));
  }
});

test('local stylesheet persists, refreshes on modify/delete/rename and clears without network writes', async () => {
  const main = loadMainWithSyntheticModules();
  const { app, listeners } = makeApp();
  let css = 'article{color:tomato}';
  let exists = true;
  const reads = [];
  // Pure Vault adapter stub; real filesystem confinement is tested separately.
  app.vault.adapter.getBasePath = undefined;
  app.vault.adapter.stat = async p => p === 'styles/blog.css' && exists ? { type: 'file', size: Buffer.byteLength(css) } : null;
  app.vault.adapter.read = async p => { reads.push(p); return css; };
  const plugin = new main(app, { id: 'synthetic-wordpress' });
  await plugin.onload();
  const view = plugin.viewFactory({});
  await view.onOpen();
  await plugin.controller.refresh();
  await plugin.updateSetting('previewCssPath', 'styles/blog.css');
  await plugin.styleRefresh;
  assert.equal(plugin.savedData.previewCssPath, 'styles/blog.css');
  const reloadApp = makeApp().app;
  reloadApp.vault.adapter = app.vault.adapter;
  const restored = new main(reloadApp, { id: 'synthetic-wordpress' });
  restored.loadData = async () => ({ ...plugin.savedData, password: 'DO_NOT_KEEP' });
  await restored.onload();
  await restored.styleRefresh;
  assert.equal(restored.customCss, css);
  assert.equal(restored.savedData.password, undefined);
  await restored.onunload();
  assert.match(view.frame.srcdoc, /article\{color:tomato\}/);
  assert.equal(view.frame.attributes.sandbox, '');
  css = 'article{color:blue}';
  listeners.vault.modify({ path: 'styles/blog.css' });
  await plugin.styleRefresh;
  assert.match(view.frame.srcdoc, /article\{color:blue\}/);
  exists = false;
  listeners.vault.rename({ path: 'styles/moved.css' }, 'styles/blog.css');
  await plugin.styleRefresh;
  assert.doesNotMatch(view.frame.srcdoc, /article\{color:blue\}/);
  assert.match(view.feedbackEl.textContent, /CSS/);
  const previewBeforeLocaleSwitch = plugin.lastPreview;
  await plugin.updateLocale('en');
  assert.equal(plugin.lastPreview, previewBeforeLocaleSwitch);
  assert.match(view.feedbackEl.textContent, /Local CSS was not applied/i);
  const noticeCount = notices.length;
  await plugin.controller.refresh();
  await plugin.controller.refresh();
  assert.equal(notices.length, noticeCount);
  exists = true;
  assert.equal(typeof listeners.vault.create, 'function');
  listeners.vault.create({ path: 'styles/blog.css' });
  await plugin.styleRefresh;
  assert.match(view.frame.srcdoc, /article\{color:blue\}/);
  exists = false;
  listeners.vault.delete({ path: 'styles/blog.css' });
  await plugin.styleRefresh;
  assert.doesNotMatch(view.frame.srcdoc, /article\{color:blue\}/);
  await plugin.updateSetting('previewCssPath', '');
  assert.equal(plugin.customCss, '');
  assert.equal(plugin.styleMessage, '');
  assert.ok(reads.every(p => p === 'styles/blog.css'));
  await plugin.onunload();
});

test('late stylesheet reads cannot restore cleared, replaced or unloaded CSS', async () => {
  const main = loadMainWithSyntheticModules();
  const { app } = makeApp();
  const pending = [];
  app.vault.adapter.getBasePath = undefined;
  app.vault.adapter.stat = async () => ({ type: 'file', size: 20 });
  app.vault.adapter.read = () => new Promise(resolve => pending.push(resolve));
  const plugin = new main(app, { id: 'synthetic-wordpress' });
  await plugin.onload();
  await plugin.updateSetting('previewCssPath', 'old.css');
  const old = plugin.styleRefresh;
  await plugin.updateSetting('previewCssPath', 'new.css');
  pending[1]('article{color:blue}');
  await plugin.styleRefresh;
  pending[0]('article{color:red}');
  await old;
  assert.equal(plugin.customCss, 'article{color:blue}');
  await plugin.updateSetting('previewCssPath', 'clear.css');
  const clearing = plugin.styleRefresh;
  await plugin.updateSetting('previewCssPath', '');
  pending[2]('article{color:red}');
  await clearing;
  assert.equal(plugin.customCss, '');
  await plugin.updateSetting('previewCssPath', 'unload.css');
  const unloading = plugin.styleRefresh;
  await plugin.onunload();
  pending[3]('article{color:red}');
  await unloading;
  assert.equal(plugin.customCss, '');
  assert.equal(plugin.refreshTimer, null);
});

test('legacy and invalid locale config falls back to Chinese and saves beside existing settings', async () => {
  const main = loadMainWithSyntheticModules();
  const { app } = makeApp();
  const plugin = new main(app, { id: 'synthetic-wordpress' });
  plugin.loadData = async () => ({
    siteUrl: 'https://blog.example', username: 'writer', secretRef: 'saved-ref', previewCssPath: 'styles/blog.css',
    ...(plugin.invalidLocale === undefined ? {} : { uiLanguage: plugin.invalidLocale }),
  });
  plugin.invalidLocale = 'fr';
  await plugin.onload();
  await plugin.styleRefresh;
  clearTimeout(plugin.refreshTimer);
  plugin.refreshTimer = null;
  assert.equal(plugin.settings.uiLanguage, 'zh-CN');
  await plugin.updateLocale('en');
  assert.deepEqual(plugin.savedData, {
    siteUrl: 'https://blog.example', username: 'writer', secretRef: 'saved-ref',
    previewCssPath: 'styles/blog.css', uiLanguage: 'en',
  });
  await plugin.updateSetting('username', 'writer-updated');
  assert.deepEqual(plugin.savedData, {
    siteUrl: 'https://blog.example', username: 'writer-updated', secretRef: 'saved-ref',
    previewCssPath: 'styles/blog.css', uiLanguage: 'en',
  });
  await plugin.onunload();
});

test('English selector translates major plugin UI while preserving user values and preview gates', async () => {
  const main = loadMainWithSyntheticModules();
  const { app } = makeApp();
  const plugin = new main(app, { id: 'synthetic-wordpress' });
  plugin.loadData = async () => ({
    siteUrl: 'https://blog.example', username: 'writer <author>', secretRef: 'saved-ref', uiLanguage: 'en',
  });
  await plugin.onload();
  await plugin.styleRefresh;
  clearTimeout(plugin.refreshTimer);
  plugin.refreshTimer = null;
  plugin.settingsTab.display();
  const language = settingComponents.filter(item => item.name === 'Interface language').at(-1);
  assert.deepEqual(language.dropdownComponent.options, { 'zh-CN': '简体中文', en: 'English' });
  assert.equal(language.dropdownComponent.value, 'en');
  assert.equal(settingComponents.filter(item => item.name === 'Username').at(-1).textComponent.value, 'writer <author>');
  assert.equal(settingComponents.filter(item => item.name === 'WordPress HTTPS site URL').at(-1).textComponent.value, 'https://blog.example');
  assert.equal(settingComponents.filter(item => item.name === 'Connection test').at(-1).buttonComponent.text, 'Test connection');
  assert.equal(plugin.command.id, 'open-blog-preview');
  assert.deepEqual(plugin.commands.map(command => command.id), ['open-blog-preview', 'restore-published-association']);
  assert.equal(plugin.command.name, 'Open blog preview');
  const view = plugin.viewFactory({});
  await view.onOpen();
  const preview = {
    html: '<article><h1>文章原题</h1></article>', siteUrl: 'https://blog.example',
    publishedLink: 'https://blog.example/?p=27', dirty: true,
    issues: [{ code: 'missing_image', message: '有图片未找到；请检查图片引用。' }], canPublish: false,
  };
  plugin.lastPreview = preview;
  view.update(preview);
  assert.equal(view.publishButton.textContent, 'Update article');
  assert.equal(view.publishButton.disabled, true);
  assert.equal(view.infoEl.children[0].textContent, 'View article');
  assert.equal(view.infoEl.children[0].attributes.href, 'https://blog.example/?p=27');
  assert.match(view.infoEl.children.map(child => child.textContent).join(' '), /Unpublished changes/);
  assert.match(view.feedbackEl.textContent, /image/i);
  assert.match(view.frame.srcdoc, /文章原题/);
  const noticesBefore = notices.length;
  await plugin.runAction('publish');
  assert.equal(notices.at(-1), 'Wait for the preview or resolve its warnings first.');
  assert.equal(notices.length, noticesBefore + 1);
  plugin.lastPreview = { ...preview, canPublish: true };
  plugin.controller.publish = async () => ({ status: 'needs-check', reason: 'create-write-uncertain' });
  await plugin.runAction('publish');
  assert.match(notices.at(-1), /creation is uncertain/i);
  assert.doesNotMatch(notices.at(-1), /create-write-uncertain/);
  plugin.lastPreview = preview;
  await plugin.updateLocale('zh-CN');
  assert.equal(plugin.lastPreview, preview);
  assert.equal(view.publishButton.disabled, true);
  assert.equal(view.checkButton.hidden, true);
  assert.equal(view.publishButton.textContent, '更新文章');
  const pendingPreview = { ...preview, publishedLink: '', canPublish: true, needsCheck: true, manualRequired: false };
  plugin.lastPreview = pendingPreview;
  view.update(pendingPreview);
  view.setBusy(true);
  await plugin.updateLocale('en');
  assert.equal(view.checkButton.hidden, false);
  assert.equal(view.checkButton.disabled, true);
  assert.equal(view.publishButton.disabled, true);
  assert.equal(view.restoreButton.disabled, true);
  await view.onClose();
  await plugin.onunload();
  notices.length = 0;
});

test('locale-only change serializes saves and redraws without touching controller intent or preview', async () => {
  const main = loadMainWithSyntheticModules();
  const { app } = makeApp();
  const plugin = new main(app, { id: 'synthetic-wordpress' });
  await plugin.onload();
  await plugin.styleRefresh;
  clearTimeout(plugin.refreshTimer);
  plugin.refreshTimer = null;
  const preview = { html: '<p>unchanged</p>', canPublish: true };
  plugin.lastPreview = preview;
  const redrawn = [];
  plugin.currentView = { update(value) { redrawn.push(value); } };
  const modal = { renderCount: 0, render() { this.renderCount += 1; } };
  plugin.restoreModal = modal;
  const calls = [];
  for (const name of ['setSettings', 'invalidate', 'refresh', 'testConnection', 'publish', 'checkStatus', 'restoreAssociation']) {
    const original = plugin.controller[name].bind(plugin.controller);
    plugin.controller[name] = (...args) => { calls.push(name); return original(...args); };
  }
  let releaseFirstSave;
  let markFirstSaveStarted;
  const firstSaveStarted = new Promise(resolve => { markFirstSaveStarted = resolve; });
  const firstSaveGate = new Promise(resolve => { releaseFirstSave = resolve; });
  const snapshots = [];
  plugin.saveData = async value => {
    snapshots.push({ ...value });
    if (snapshots.length === 1) { markFirstSaveStarted(); await firstSaveGate; }
  };
  const settingsSave = plugin.updateSetting('username', 'writer-next');
  plugin.lastPreview = preview;
  redrawn.length = 0;
  const localeSave = plugin.updateLocale('en');
  await firstSaveStarted;
  assert.equal(snapshots.length, 1);
  assert.equal('uiLanguage' in snapshots[0], true);
  releaseFirstSave();
  await Promise.all([settingsSave, localeSave]);
  assert.equal(plugin.lastPreview, preview);
  assert.deepEqual(redrawn, [preview]);
  assert.equal(modal.renderCount, 1);
  assert.deepEqual(calls, ['setSettings']);
  assert.deepEqual(plugin.commands.map(command => [command.id, command.name]), [
    ['open-blog-preview', 'Open blog preview'],
    ['restore-published-association', 'Restore published article association'],
  ]);
  assert.equal(plugin.ribbonButtonEl.attributes.title, 'Open blog preview');
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots.at(-1).siteUrl, 'https://blog.example');
  assert.equal(snapshots.at(-1).username, 'writer-next');
  assert.equal(snapshots.at(-1).secretRef, 'saved-ref');
  assert.equal(snapshots.at(-1).uiLanguage, 'en');
  clearTimeout(plugin.refreshTimer);
  plugin.refreshTimer = null;
  calls.length = 0;
  redrawn.length = 0;
  await plugin.updateLocale('zh-CN');
  assert.equal(plugin.lastPreview, preview);
  assert.deepEqual(redrawn, [preview]);
  assert.deepEqual(calls, []);
  assert.equal(snapshots.at(-1).siteUrl, 'https://blog.example');
  assert.equal(snapshots.at(-1).username, 'writer-next');
  assert.equal(snapshots.at(-1).secretRef, 'saved-ref');
  assert.equal(snapshots.at(-1).uiLanguage, 'zh-CN');
  await plugin.onunload();
});

test('locale redraw preserves the recovery modal target, typed path, and confirmation guard', async () => {
  const main = loadMainWithSyntheticModules();
  const { app, note, listeners } = makeApp();
  const plugin = new main(app, { id: 'synthetic-wordpress' });
  await plugin.onload();
  plugin.openRestoreModal();
  const modal = FakeModal.last;
  const target = modal.target;
  modal.oldPath = 'Drafts/former.md';
  await plugin.updateLocale('en');
  assert.equal(modal.target, target);
  const modalSettings = settingComponents.filter(item => item.container === modal.contentEl);
  assert.equal(modalSettings.at(-2).textComponent.value, 'Drafts/former.md');
  assert.equal(modalSettings.at(-1).buttonComponent.text, 'Confirm restore association');
  app.workspace.getActiveFile = () => new FakeTFile('Drafts/other.md');
  listeners.workspace['active-leaf-change']();
  await modalSettings.at(-1).buttonComponent.click();
  assert.equal(modal.closed, undefined);
  assert.match(notices.at(-1), /active note or settings changed/i);
  await plugin.onunload();
  notices.length = 0;
});
