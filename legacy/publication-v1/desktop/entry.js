'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Plugin, Notice, ItemView, Modal } = require('obsidian');
const DirectConnectionSettingTab = require('./settings');
const { probeWordPress } = require('./connection');
const {
  renderDocument, readApprovedPng, readSelectedNote, createFixedInputPackage, safeAssetPath, PreviewGeneration,
} = require('./core');

const VIEW_TYPE = 'blog-publisher-local-preview';
const MAX_SOURCE_BYTES = 65536;
const CONNECTION_SUCCESS = '连接已验证；发布接线尚未完成。';
const CONNECTION_ERRORS = Object.freeze({
  invalid_site: '连接失败：站点地址不符合 HTTPS 要求。',
  invalid_account: '连接失败：账号信息无效。',
  missing_secret: '连接失败：未找到所选发布凭据。',
  auth_failed: '连接失败：账号验证未通过。',
  account_permissions: '连接失败：账号缺少所需权限。',
  api_missing: '连接失败：站点未提供所需连接接口。',
  invalid_response: '连接失败：站点返回无效响应。',
  response_too_large: '连接失败：站点响应超出限制。',
  redirect_blocked: '连接失败：站点重定向被阻止。',
  network_error: '连接失败：网络请求未完成。',
  timeout: '连接失败：连接超时。',
  cancelled: '连接已取消。',
});

function savedConnectionSettings(data) {
  return {
    siteUrl: typeof data?.siteUrl === 'string' ? data.siteUrl : '',
    username: typeof data?.username === 'string' ? data.username : '',
    secretName: typeof data?.secretName === 'string' ? data.secretName : '',
  };
}

function validSecretName(name) {
  return typeof name === 'string' && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name);
}

function notePathValid(value) {
  return typeof value === 'string' && value.endsWith('.md') && value.length <= 1024
    && !/[\\:\x00-\x1f\x7f]/.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.') && part === part.normalize('NFC'));
}

function activeEditor(app, file) {
  const views = (app.workspace.getLeavesOfType('markdown') || [])
    .map(leaf => leaf.view)
    .filter(view => view?.file?.path === file.path && view.getMode?.() === 'source' && view.editor);
  if (new Set(views.map(view => view.editor.getValue())).size > 1) throw new Error('conflicting_editors');
  return views[0]?.editor || null;
}

function safeResourcePath(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.includes(':') || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('resource_path_invalid');
  }
  const full = path.resolve(root, ...relative.split('/'));
  const rel = path.relative(root, full);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('resource_path_invalid');
  return full;
}

function readPluginFile(root, relative, maxBytes) {
  const full = safeResourcePath(root, relative);
  let cursor = root;
  for (const part of path.relative(root, full).split(path.sep)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error('resource_file_invalid');
    if (cursor === full) {
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) throw new Error('resource_file_invalid');
    } else if (!stat.isDirectory()) throw new Error('resource_file_invalid');
  }
  const real = fs.realpathSync(full);
  if (path.resolve(real).toLowerCase() !== path.resolve(full).toLowerCase()) throw new Error('resource_file_invalid');
  return fs.readFileSync(full);
}

function loadResources(root) {
  const cssBytes = readPluginFile(root, 'assets/katex.min.css', 1024 * 1024);
  const css = cssBytes.toString('utf8');
  if (!Buffer.from(css, 'utf8').equals(cssBytes) || ['@import', 'expression', 'javascript:', 'http:', 'https:', 'data:', 'file:', '<'].some(value => css.toLowerCase().includes(value))) {
    throw new Error('resource_css_invalid');
  }
  const resources = Object.create(null);
  resources['assets/katex.min.css'] = cssBytes;
  for (const match of css.matchAll(/url\(([^)]*)\)/gi)) {
    const raw = match[1].trim();
    const relative = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")) ? raw.slice(1, -1) : raw;
    if (!relative.startsWith('fonts/')) throw new Error('resource_font_invalid');
    const name = relative.slice('fonts/'.length);
    const extension = ['.woff2', '.woff', '.ttf'].find(value => name.endsWith(value));
    const stem = extension ? name.slice(0, -extension.length) : '';
    if (!stem.startsWith('KaTeX_') || ![...stem.slice(6)].every(char => /[A-Za-z0-9_-]/.test(char))) throw new Error('resource_font_invalid');
    const assetPath = `assets/${relative}`;
    if (!Object.hasOwn(resources, assetPath)) resources[assetPath] = readPluginFile(root, assetPath, 4 * 1024 * 1024);
  }
  return resources;
}

function bundleSha256(root) {
  const bundle = path.join(root, 'main.js');
  const stat = fs.lstatSync(bundle);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error('compiler_identity_unavailable');
  return crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest('hex');
}

class LocalPreviewView extends ItemView {
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return '离线预览'; }

  async onOpen() {
    this.contentEl.empty();
    this.ownedLeases = new Set();
    this.frame = this.contentEl.createEl('iframe');
    this.frame.setAttribute('sandbox', 'allow-same-origin');
    this.frame.setAttribute('title', '离线预览');
    this.frame.style.cssText = 'width:100%;height:100%;border:0;background:var(--background-primary)';
    this.frame.hidden = true;
  }

  showDocument(html, lease, revision) {
    if (!this.frame) { lease.dispose(); return; }
    this.ownedLeases ??= new Set();
    this.ownedLeases.add(lease);
    this.frame.hidden = false;
    this.frame.removeAttribute('src');
    this.frame.removeAttribute('srcdoc');
    this.frame.addEventListener('load', () => {
      if (!this.plugin.generation.isCurrent(revision)) return;
      for (const old of this.ownedLeases) if (old !== lease) old.dispose();
      this.ownedLeases = new Set([lease]);
    }, { once: true });
    this.frame.srcdoc = html;
  }

  clear() {
    this.frame?.removeAttribute('srcdoc');
    this.frame?.removeAttribute('src');
    if (this.frame) this.frame.hidden = true;
    for (const lease of this.ownedLeases || []) lease.dispose();
    this.ownedLeases = new Set();
  }

  async onClose() {
    this.clear();
    this.plugin.previewViewClosed(this);
    this.contentEl.empty();
  }
}

class PreviewOptionsModal extends Modal {
  constructor(plugin, session) {
    super(plugin.app);
    this.plugin = plugin;
    this.session = session;
    this.candidate = null;
    this.epoch = 0;
  }

  onOpen() {
    this.contentEl.empty();
    this.setTitle('离线预览设置');
    this.contentEl.createEl('p', { text: this.session.path });
    this.contentEl.createEl('label', { text: '独立标题' });
    this.titleInput = this.contentEl.createEl('input');
    this.titleInput.type = 'text';
    this.titleInput.maxLength = 200;
    this.titleInput.value = this.session.title;
    this.titleButton = this.contentEl.createEl('button', { text: '应用标题' });
    this.titleButton.addEventListener('click', () => this.applyTitle());
    this.contentEl.createEl('hr');
    this.contentEl.createEl('label', { text: '当前笔记目录下的 PNG 相对路径' });
    this.assetInput = this.contentEl.createEl('input');
    this.assetInput.type = 'text';
    this.assetInput.maxLength = 1024;
    this.assetInput.placeholder = 'images/cover.png';
    this.checkButton = this.contentEl.createEl('button', { text: '检查 PNG' });
    this.approveButton = this.contentEl.createEl('button', { text: '明确批准' });
    this.approveButton.disabled = true;
    this.status = this.contentEl.createEl('p', { text: '图片须单独批准。' });
    this.assetInput.addEventListener('input', () => {
      this.epoch += 1;
      this.candidate = null;
      this.approveButton.disabled = true;
      this.status.textContent = '路径已变化，请重新检查。';
    });
    this.checkButton.addEventListener('click', () => this.inspectAsset());
    this.approveButton.addEventListener('click', () => this.approveAsset());
    const approvals = Object.entries(this.session.approvedAssets);
    this.approvalList = this.contentEl.createEl('div');
    if (!approvals.length) this.approvalList.createEl('p', { text: '无已批准图片。' });
    for (const [assetPath] of approvals) {
      const row = this.approvalList.createEl('div');
      row.createEl('span', { text: assetPath });
      const remove = row.createEl('button', { text: '移除' });
      remove.addEventListener('click', () => {
        if (!this.current()) return;
        delete this.session.approvedAssets[assetPath];
        this.plugin.invalidatePreview();
        this.status.textContent = '批准已移除。';
        this.close();
      });
    }
  }

  current() {
    if (this.plugin.session !== this.session || this.plugin.app.workspace.getActiveFile()?.path !== this.session.path) {
      this.epoch += 1;
      this.candidate = null;
      this.approveButton.disabled = true;
      this.status.textContent = '笔记已变化；请重新设置。';
      return false;
    }
    return true;
  }

  applyTitle() {
    if (!this.current()) return;
    const title = this.titleInput.value;
    if (!title.trim() || title.length > 200 || /[\x00-\x1f\x7f]/.test(title)) {
      this.status.textContent = '标题不符合要求。';
      return;
    }
    this.session.title = title;
    this.plugin.invalidatePreview();
    this.status.textContent = '标题已更新。';
  }

  inspectAsset() {
    const relative = this.assetInput.value;
    const epoch = ++this.epoch;
    this.candidate = null;
    this.approveButton.disabled = true;
    if (!this.current() || !safeAssetPath(relative)) {
      this.status.textContent = '不支持此 PNG 路径。';
      return;
    }
    try {
      const read = readApprovedPng(this.plugin.vaultRoot(), this.session.path, relative);
      if (epoch !== this.epoch || !this.current()) return;
      this.candidate = { path: relative, sha256: read.sha256 };
      this.approveButton.disabled = false;
      this.status.textContent = 'PNG 可用；尚未批准。';
    } catch {
      this.status.textContent = 'PNG 检查未通过。';
    }
  }

  approveAsset() {
    if (!this.current() || !this.candidate || this.assetInput.value !== this.candidate.path) {
      this.status.textContent = '候选已失效，请重新检查。';
      this.approveButton.disabled = true;
      return;
    }
    try {
      const current = readApprovedPng(this.plugin.vaultRoot(), this.session.path, this.candidate.path);
      if (current.sha256 !== this.candidate.sha256) throw new Error('asset_changed');
      this.session.approvedAssets[this.candidate.path] = { sha256: current.sha256, mime: 'image/png' };
      this.plugin.invalidatePreview();
      this.status.textContent = '图片已明确批准。';
      this.close();
    } catch {
      this.candidate = null;
      this.approveButton.disabled = true;
      this.status.textContent = '图片已变化；请重新检查。';
    }
  }

  onClose() { this.candidate = null; }
}

module.exports = class BlogPublisherLocal extends Plugin {
  async onload() {
    this.generation = new PreviewGeneration();
    this.session = null;
    this.fixedInput = null;
    this.previewView = null;
    this.resources = null;
    this.unloaded = false;
    this.registerView(VIEW_TYPE, leaf => new LocalPreviewView(leaf));
    this.addCommand({ id: 'local-offline-preview', name: '当前笔记 → 离线预览', callback: () => this.openPreview() });
    this.addCommand({ id: 'local-preview-options', name: '设置离线预览标题与 PNG', callback: () => this.openOptions() });
    this.addCommand({ id: 'local-fixed-input', name: '生成本机固定输入包（未发送）', callback: () => this.generateFixedInput() });
    this.addRibbonIcon('eye', '当前笔记 → 离线预览', () => this.openPreview());
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.selectionChanged()));
    this.registerEvent(this.app.workspace.on('editor-change', (_editor, view) => {
      if (this.session?.path === view?.file?.path) this.invalidatePreview();
    }));
    this.registerEvent(this.app.vault.on('modify', file => this.inputChanged(file.path)));
    this.registerEvent(this.app.vault.on('delete', file => this.inputChanged(file.path)));
    this.registerEvent(this.app.vault.on('rename', (_file, oldPath) => this.inputChanged(oldPath)));

    this.connectionSettings = { siteUrl: '', username: '', secretName: '' };
    this.connectionSettingsRevision = 0;
    this.connectionProbeGeneration = 0;
    this.connectionProbeController = null;
    this.connectionSaveQueue = Promise.resolve();
    this.connectionStatusMessage = '尚未测试连接。';
    const loadRevision = this.connectionSettingsRevision;
    let data;
    try { data = await this.loadData(); } catch { data = null; }
    if (this.unloaded) return;
    if (this.connectionSettingsRevision === loadRevision) this.connectionSettings = savedConnectionSettings(data);
    this.connectionSettingsTab = new DirectConnectionSettingTab(this.app, this);
    this.addSettingTab(this.connectionSettingsTab);
  }

  setConnectionStatus(message) {
    this.connectionStatusMessage = message;
    this.connectionSettingsTab?.setStatus(message);
  }

  invalidateConnectionProbe() {
    this.connectionProbeGeneration += 1;
    const controller = this.connectionProbeController;
    this.connectionProbeController = null;
    controller?.abort();
  }

  updateConnectionSetting(key, value) {
    if (!['siteUrl', 'username', 'secretName'].includes(key)) return Promise.resolve();
    if (typeof value !== 'string' && !(key === 'secretName' && value === null)) return Promise.resolve();
    const nextValue = value === null ? '' : value;
    if (this.connectionSettings[key] === nextValue) return Promise.resolve();
    this.connectionSettings = { ...this.connectionSettings, [key]: nextValue };
    this.connectionSettingsRevision += 1;
    this.invalidateConnectionProbe();
    this.setConnectionStatus('连接设置已变化，请重新测试。');
    const snapshot = {
      siteUrl: this.connectionSettings.siteUrl,
      username: this.connectionSettings.username,
      secretName: this.connectionSettings.secretName,
    };
    const revision = this.connectionSettingsRevision;
    this.connectionSaveQueue = this.connectionSaveQueue
      .catch(() => {})
      .then(() => this.saveData(snapshot))
      .catch(() => {
        if (!this.unloaded && revision === this.connectionSettingsRevision) this.setConnectionStatus('连接设置未能保存。');
      });
    return this.connectionSaveQueue;
  }

  async testConnection() {
    if (this.unloaded) return false;
    const generation = ++this.connectionProbeGeneration;
    this.connectionProbeController?.abort();
    const controller = new AbortController();
    this.connectionProbeController = controller;
    const isCurrent = () => !this.unloaded
      && generation === this.connectionProbeGeneration
      && this.connectionProbeController === controller;
    this.setConnectionStatus('正在测试连接…');
    try {
      const { siteUrl, username, secretName } = this.connectionSettings;
      if (!validSecretName(secretName)) throw Object.assign(new Error(), { code: 'missing_secret' });
      const storage = this.app.secretStorage;
      if (!storage || typeof storage.getSecret !== 'function') throw Object.assign(new Error(), { code: 'missing_secret' });
      let secret;
      try { secret = storage.getSecret(secretName); } catch { throw Object.assign(new Error(), { code: 'missing_secret' }); }
      if (typeof secret !== 'string' || !secret) throw Object.assign(new Error(), { code: 'missing_secret' });
      await probeWordPress({ siteUrl, username, secret, signal: controller.signal });
      if (!isCurrent()) return false;
      this.setConnectionStatus(CONNECTION_SUCCESS);
      new Notice(CONNECTION_SUCCESS);
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      let code;
      try { code = error?.code; } catch { code = undefined; }
      const message = Object.hasOwn(CONNECTION_ERRORS, code) ? CONNECTION_ERRORS[code] : '连接失败：无法验证连接。';
      this.setConnectionStatus(message);
      new Notice(message);
      return false;
    } finally {
      if (isCurrent()) this.connectionProbeController = null;
    }
  }

  vaultRoot() { return this.app.vault.adapter.getBasePath(); }

  pluginRoot() { return safeResourcePath(this.vaultRoot(), this.manifest.dir); }

  ensureSession(file) {
    if (!file || !notePathValid(file.path)) throw new Error('note_path_invalid');
    if (this.session?.path !== file.path) {
      this.generation.invalidate();
      this.previewView?.clear();
      const name = file.path.split('/').at(-1).slice(0, -3);
      this.session = { path: file.path, title: name, approvedAssets: Object.create(null) };
      this.fixedInput = null;
    }
    return this.session;
  }

  selectionChanged() {
    const pathNow = this.app.workspace.getActiveFile()?.path;
    if (this.session && pathNow !== this.session.path) {
      this.generation.invalidate();
      this.session = null;
      this.fixedInput = null;
      this.previewView?.clear();
      this.previewView = null;
    }
  }

  inputChanged(filePath) {
    if (!this.session) return;
    if (filePath === this.session.path) {
      this.invalidatePreview();
      return;
    }
    for (const assetPath of Object.keys(this.session.approvedAssets)) {
      if (path.posix.join(path.posix.dirname(this.session.path), assetPath) !== filePath) continue;
      delete this.session.approvedAssets[assetPath];
      this.invalidatePreview();
      return;
    }
  }

  async capture(file, requireSaved) {
    if (!file || !notePathValid(file.path)) throw new Error('note_path_invalid');
    const editor = activeEditor(this.app, file);
    const disk = readSelectedNote(this.vaultRoot(), file.path);
    if (requireSaved) {
      if (Buffer.byteLength(disk, 'utf8') > MAX_SOURCE_BYTES) throw new Error('note_too_large');
      // Obsidian normalizes CRLF in the editor; package the unchanged disk bytes.
      if (editor && editor.getValue() !== disk.replace(/\r\n/g, '\n')) throw new Error('note_unsaved');
      return disk;
    }
    const source = editor ? editor.getValue() : disk;
    if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) throw new Error('note_too_large');
    return source;
  }

  async openPreview() {
    const file = this.app.workspace.getActiveFile();
    try {
      this.ensureSession(file);
      const token = this.generation.begin();
      let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
      if (!leaf) {
        leaf = this.app.workspace.getLeaf('split');
        await leaf.setViewState({ type: VIEW_TYPE, active: true });
      }
      if (!this.generation.isCurrent(token) || this.app.workspace.getActiveFile()?.path !== file.path) return;
      this.previewView = leaf.view;
      this.previewView.plugin = this;
      await this.renderPreview(file, token, false);
    } catch {
      new Notice('离线预览被阻断。');
    }
  }

  async renderPreview(file, token, showNotice = true) {
    let lease;
    try {
      const session = this.ensureSession(file);
      const source = await this.capture(file, false);
      if (!this.generation.isCurrent(token) || this.app.workspace.getActiveFile()?.path !== file.path) return;
      if (!this.resources) this.resources = loadResources(this.pluginRoot());
      const frameWindow = this.previewView?.frame?.ownerDocument?.defaultView;
      if (!frameWindow?.URL?.createObjectURL || typeof frameWindow.Blob !== 'function') throw new Error('preview_frame_unavailable');
      const urls = new Set();
      lease = { dispose: () => { for (const url of urls) frameWindow.URL.revokeObjectURL(url); urls.clear(); } };
      const createUrl = (bytes, mime) => {
        const value = frameWindow.URL.createObjectURL(new frameWindow.Blob([bytes], { type: mime }));
        urls.add(value);
        return value;
      };
      const assetUrls = Object.create(null);
      const currentAssets = Object.create(null);
      for (const [assetPath, approval] of Object.entries(session.approvedAssets)) {
        const image = readApprovedPng(this.vaultRoot(), session.path, assetPath);
        if (image.sha256 !== approval.sha256) {
          delete session.approvedAssets[assetPath];
          lease.dispose();
          this.previewView?.clear();
          new Notice('图片已变化，旧批准已撤销。');
          return;
        }
        currentAssets[assetPath] = { sha256: image.sha256, mime: 'image/png' };
        assetUrls[assetPath] = createUrl(image.bytes, 'image/png');
      }
      const cssBytes = this.resources['assets/katex.min.css'];
      const css = cssBytes.toString('utf8').replace(/url\(([^)]*)\)/gi, (_match, item) => {
        const raw = item.trim();
        const relative = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")) ? raw.slice(1, -1) : raw;
        const resourcePath = `assets/${relative}`;
        const font = this.resources[resourcePath];
        if (!font || !resourcePath.startsWith('assets/fonts/')) throw new Error('preview_font_invalid');
        const mime = resourcePath.endsWith('.woff2') ? 'font/woff2' : resourcePath.endsWith('.woff') ? 'font/woff' : 'font/ttf';
        return `url("${createUrl(font, mime)}")`;
      });
      const html = renderDocument({ text: source, title: session.title, approvedAssets: currentAssets, assetUrls, katexCss: css });
      if (!this.generation.isCurrent(token) || this.app.workspace.getActiveFile()?.path !== file.path || this.unloaded) {
        lease.dispose();
        return;
      }
      this.previewView?.showDocument(html, lease, token);
      if (showNotice) new Notice('离线预览已更新。');
    } catch {
      lease?.dispose();
      if (this.generation.isCurrent(token)) {
        this.previewView?.clear();
        if (showNotice) new Notice('内容不符合离线预览规则。');
      }
    }
  }

  async openOptions() {
    const file = this.app.workspace.getActiveFile();
    try {
      const session = this.ensureSession(file);
      new PreviewOptionsModal(this, session).open();
    } catch {
      new Notice('请先打开一篇 Markdown 笔记。');
    }
  }

  invalidatePreview() {
    this.generation.invalidate();
    this.previewView?.clear();
    this.fixedInput = null;
    const file = this.app.workspace.getActiveFile();
    if (file && this.session?.path === file.path && this.previewView) {
      const token = this.generation.begin();
      void this.renderPreview(file, token, false);
    }
  }

  async generateFixedInput() {
    const file = this.app.workspace.getActiveFile();
    this.fixedInput = null;
    let token;
    try {
      const session = this.ensureSession(file);
      token = this.generation.begin();
      const source = await this.capture(file, true);
      if (!this.generation.isCurrent(token) || this.app.workspace.getActiveFile()?.path !== file.path || this.session !== session) return;
      if (!this.resources) this.resources = loadResources(this.pluginRoot());
      const assetBytes = Object.create(null);
      for (const [assetPath, approval] of Object.entries(session.approvedAssets)) {
        const image = readApprovedPng(this.vaultRoot(), session.path, assetPath);
        if (image.sha256 !== approval.sha256) {
          delete session.approvedAssets[assetPath];
          this.fixedInput = null;
          this.previewView?.clear();
          new Notice('图片已变化，旧批准已撤销。');
          return;
        }
        assetBytes[assetPath] = image.bytes;
      }
      // Apply the same finite syntax/approval gate; these URLs are never loaded.
      const validationUrls = Object.fromEntries(Object.entries(session.approvedAssets)
        .map(([assetPath, approval]) => [assetPath, `blob:local-validation/${approval.sha256}`]));
      renderDocument({ text: source, title: session.title, approvedAssets: session.approvedAssets, assetUrls: validationUrls });
      const compilerSha256 = bundleSha256(this.pluginRoot());
      const fixed = createFixedInputPackage({
        path: session.path, source, title: session.title, labels: {}, approvedAssets: session.approvedAssets,
        assets: assetBytes, resources: this.resources, compilerSha256,
      });
      if (!this.generation.isCurrent(token) || this.app.workspace.getActiveFile()?.path !== file.path || this.session !== session) return;
      this.fixedInput = fixed;
      new Notice('固定输入包已生成；仅本机，服务器未接收。');
    } catch (error) {
      if (!token || this.generation.isCurrent(token)) new Notice(error?.message === 'note_unsaved' ? '请先保存当前笔记。' : '固定输入包生成被阻断。');
    }
  }

  previewViewClosed(view) {
    if (this.previewView === view) {
      this.generation.invalidate();
      this.previewView = null;
    }
  }

  onunload() {
    this.unloaded = true;
    this.invalidateConnectionProbe();
    this.generation.close();
    this.fixedInput = null;
    this.session = null;
    this.previewView?.clear();
    this.previewView = null;
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }
};
