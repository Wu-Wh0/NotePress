'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const entryPath = path.resolve(__dirname, '../desktop/entry.js');
const settingsPath = path.resolve(__dirname, '../desktop/settings.js');
const realEntryRequire = createRequire(entryPath);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function makeHarness({ loadData = () => Promise.resolve({ siteUrl: 'https://example.test', username: 'author', secretName: 'wp-secret' }), saveData, probe = async () => ({ userId: 7 }) } = {}) {
  const callbacks = { workspace: new Map(), vault: new Map() };
  const notices = [];
  const secretsRead = [];
  const commands = [];
  const tabs = [];
  const saveCalls = [];
  const secretValues = new Map([['wp-secret', 'TEST_ONLY_SYNTHETIC_SECRET'], ['secret-new', 'TEST_ONLY_NEW_SECRET']]);
  const app = {
    workspace: {
      on(name, callback) { callbacks.workspace.set(name, callback); return {}; },
      getActiveFile: () => ({ path: 'notes/example.md' }),
      getLeavesOfType: () => [],
      detachLeavesOfType() {},
    },
    vault: {
      on(name, callback) { callbacks.vault.set(name, callback); return {}; },
      adapter: { getBasePath: () => '' },
    },
    secretStorage: { getSecret(name) { secretsRead.push(name); return secretValues.get(name) ?? null; } },
    mock: { loadData, saveData, saveCalls, commands, tabs },
  };
  class Container {
    constructor() { this.settings = []; }
    empty() { this.settings = []; }
  }
  class Plugin {
    constructor(hostApp) { this.app = hostApp; }
    registerView() {}
    addCommand(command) { commands.push(command); }
    addRibbonIcon() {}
    registerEvent() {}
    loadData() { return loadData(); }
    saveData(value) {
      const snapshot = structuredClone(value);
      saveCalls.push(snapshot);
      return saveData ? saveData(snapshot, saveCalls.length) : Promise.resolve();
    }
    addSettingTab(tab) { tabs.push(tab); }
  }
  class PluginSettingTab {
    constructor(hostApp, plugin) { this.app = hostApp; this.plugin = plugin; this.containerEl = new Container(); }
  }
  class Setting {
    constructor(containerEl) {
      this.containerEl = containerEl;
      this.controlEl = { setting: this };
      this.descEl = { textContent: '', setText(value) { this.textContent = value; } };
      containerEl.settings.push(this);
    }
    setName(value) { this.name = value; return this; }
    setDesc(value) { this.desc = value; this.descEl.setText(value); return this; }
    addText(callback) { this.text = new TextComponent(); callback(this.text); return this; }
    addButton(callback) { this.button = new ButtonComponent(); callback(this.button); return this; }
  }
  class TextComponent {
    setPlaceholder(value) { this.placeholder = value; return this; }
    setValue(value) { this.value = value; return this; }
    onChange(callback) { this.callback = callback; return this; }
    change(value) { this.value = value; return this.callback(value); }
  }
  class ButtonComponent {
    setButtonText(value) { this.text = value; return this; }
    onClick(callback) { this.callback = callback; return this; }
    click() { return this.callback(); }
  }
  class SecretComponent {
    constructor(hostApp, controlEl) { this.app = hostApp; this.controlEl = controlEl; controlEl.secretComponent = this; }
    setValue(value) { this.value = value ?? ''; return this; }
    onChange(callback) { this.callback = callback; return this; }
    change(value) { this.value = value; return this.callback(value); }
  }
  class Notice { constructor(message) { notices.push(message); } }
  const obsidian = { Plugin, PluginSettingTab, Setting, SecretComponent, Notice, ItemView: class {}, Modal: class {} };
  function loadSettings() {
    if (!fs.existsSync(settingsPath)) return class MissingSettingsTab {};
    const source = fs.readFileSync(settingsPath, 'utf8');
    const module = { exports: {} };
    const factory = vm.runInThisContext(`(function(require,module,exports,__dirname){\n${source}\n})`, { filename: settingsPath });
    factory(id => id === 'obsidian' ? obsidian : createRequire(settingsPath)(id), module, module.exports, path.dirname(settingsPath));
    return module.exports;
  }
  const settingsTab = loadSettings();
  const module = { exports: {} };
  const source = fs.readFileSync(entryPath, 'utf8');
  const factory = vm.runInThisContext(`(function(require,module,exports,__dirname){\n${source}\n})`, { filename: entryPath });
  factory(id => {
    if (id === 'obsidian') return obsidian;
    if (id === './settings') return settingsTab;
    if (id === './connection') return { probeWordPress: probe };
    return realEntryRequire(id);
  }, module, module.exports, path.dirname(entryPath));
  const plugin = new module.exports(app);
  return { plugin, app, callbacks, notices, secretsRead, commands, tabs, saveCalls, secretValues };
}
function setting(tab, name) { return tab.containerEl.settings.find(item => item.name === name); }

 test('loads only the allowed saved connection keys and defers secret lookup/probe until the explicit button click', async () => {
  const gate = deferred();
  const probeCalls = [];
  const h = makeHarness({ loadData: () => gate.promise, probe: async input => { probeCalls.push(input); return { userId: 7 }; } });
  const loading = h.plugin.onload();
  assert.ok(h.callbacks.workspace.has('active-leaf-change'), 'offline event handlers are initialized synchronously');
  assert.equal(h.secretsRead.length, 0);
  assert.equal(probeCalls.length, 0);
  assert.equal(h.tabs.length, 0, 'settings registration waits for persisted settings');
  gate.resolve({ siteUrl: 'https://example.test/blog', username: 'author', secretName: 'wp-secret', privateOldField: 'must-not-survive' });
  await loading;
  assert.deepEqual(h.plugin.connectionSettings, { siteUrl: 'https://example.test/blog', username: 'author', secretName: 'wp-secret' });
  assert.equal(h.tabs.length, 1);
  const tab = h.tabs[0];
  tab.display();
  assert.equal(tab.containerEl.settings.length, 4, 'three connection fields and one test row; no redundant status row');
  assert.equal(tab.secretComponent.value, 'wp-secret');
  assert.equal(h.secretsRead.length, 0, 'opening settings does not read a credential');
  const button = setting(tab, '测试连接').button;
  await button.click();
  assert.deepEqual(h.secretsRead, ['wp-secret']);
  assert.equal(probeCalls.length, 1);
  assert.deepEqual({ siteUrl: probeCalls[0].siteUrl, username: probeCalls[0].username, secret: probeCalls[0].secret }, {
    siteUrl: 'https://example.test/blog', username: 'author', secret: 'TEST_ONLY_SYNTHETIC_SECRET',
  });
  assert.ok(probeCalls[0].signal instanceof AbortSignal);
  assert.ok(tab.connectionDescription.includes('不上传文章'));
  assert.ok(h.notices.includes('连接已验证；发布接线尚未完成。'));
  await tab.secretComponent.change('secret-new');
  await h.plugin.connectionSaveQueue;
  assert.deepEqual(h.saveCalls.at(-1), { siteUrl: 'https://example.test/blog', username: 'author', secretName: 'secret-new' });
  assert.equal(JSON.stringify(h.saveCalls).includes('TEST_ONLY'), false, 'saved settings contain no secret value');
});

test('a configuration change aborts a pending probe and its stale success cannot update status or notify', async () => {
  const pending = deferred();
  const h = makeHarness({ probe: input => { hProbe.push(input); return pending.promise; } });
  const hProbe = [];
  await h.plugin.onload();
  const tab = h.tabs[0]; tab.display();
  const request = h.plugin.testConnection();
  assert.equal(hProbe.length, 1);
  const signal = hProbe[0].signal;
  const previousNotices = h.notices.length;
  await setting(tab, '站点 HTTPS 地址').text.change('https://changed.test');
  assert.equal(signal.aborted, true);
  const changedStatus = h.plugin.connectionStatusMessage;
  pending.resolve({ userId: 7 });
  await request;
  assert.equal(h.plugin.connectionStatusMessage, changedStatus);
  assert.equal(h.notices.length, previousNotices);
});

test('only the latest of two explicit connection checks can report success', async () => {
  const first = deferred(), second = deferred();
  let count = 0;
  const h = makeHarness({ probe: () => (++count === 1 ? first.promise : second.promise) });
  await h.plugin.onload(); h.tabs[0].display();
  const firstRequest = h.plugin.testConnection();
  const secondRequest = h.plugin.testConnection();
  assert.equal(count, 2);
  second.resolve({ userId: 8 });
  await secondRequest;
  assert.deepEqual(h.notices, ['连接已验证；发布接线尚未完成。']);
  first.resolve({ userId: 7 });
  await firstRequest;
  assert.deepEqual(h.notices, ['连接已验证；发布接线尚未完成。']);
});

test('unload aborts an in-flight connection check and suppresses its late result', async () => {
  const pending = deferred();
  let input;
  const h = makeHarness({ probe: value => { input = value; return pending.promise; } });
  await h.plugin.onload(); h.tabs[0].display();
  const request = h.plugin.testConnection();
  h.plugin.onunload();
  assert.equal(input.signal.aborted, true);
  pending.resolve({ userId: 7 });
  await request;
  assert.equal(h.notices.length, 0);
});

test('serialized saves preserve the latest settings snapshot when writes are slow', async () => {
  const firstSave = deferred();
  const h = makeHarness({ loadData: () => Promise.resolve({}), saveData: (_snapshot, number) => number === 1 ? firstSave.promise : Promise.resolve() });
  await h.plugin.onload(); h.tabs[0].display();
  const site = setting(h.tabs[0], '站点 HTTPS 地址').text;
  const username = setting(h.tabs[0], '用户名').text;
  site.change('https://one.test');
  username.change('second-author');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.saveCalls.length, 1, 'the second write waits for the first');
  firstSave.resolve();
  await h.plugin.connectionSaveQueue;
  assert.deepEqual(h.saveCalls, [
    { siteUrl: 'https://one.test', username: '', secretName: '' },
    { siteUrl: 'https://one.test', username: 'second-author', secretName: '' },
  ]);
});

test('probe errors map to fixed Chinese text without reflecting exception details', async () => {
  const h = makeHarness({ probe: async () => { throw Object.assign(new Error('https://private.test SECRET MUST NOT APPEAR'), { code: 'auth_failed' }); } });
  await h.plugin.onload(); h.tabs[0].display();
  await h.plugin.testConnection();
  assert.deepEqual(h.notices, ['连接失败：账号验证未通过。']);
  assert.equal(JSON.stringify(h.notices).includes('private.test'), false);
  assert.equal(JSON.stringify(h.notices).includes('SECRET'), false);
});
