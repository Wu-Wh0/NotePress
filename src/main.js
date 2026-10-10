'use strict';

const obsidian = require('obsidian');
const path = require('node:path');
const { createHostController, sanitizeSettings } = require('./host-controller');
const { extractImageReferences, renderArticle } = require('./article');
const { createWordPressClient } = require('./wordpress-client');
const { createPublisher } = require('./publisher');
const { readPreviewCss, safeCustomCss } = require('./preview-css');
const { LANGUAGES, normalizeLocale, translate, issueMessage, resultMessage } = require('./i18n');

const { Plugin, ItemView, PluginSettingTab, Setting, SecretComponent, MarkdownView, TFile, FileSystemAdapter, Notice, Modal } = obsidian;
const VIEW_TYPE = 'native-wordpress-preview';
const CONTENT_SECURITY_POLICY = "default-src 'none'; img-src blob: data:; font-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';";
const BASE_CSS = 'html,body{margin:0;padding:0;background:var(--background-primary,#17191d);color:var(--text-normal,#e5e7eb);font-family:var(--font-text,system-ui,sans-serif)}body{padding:1.25rem;line-height:1.65}article{max-width:48rem;min-width:0;margin:0 auto;overflow-wrap:anywhere}img{max-width:100%;height:auto}article pre{max-width:100%;box-sizing:border-box;overflow-x:auto;white-space:pre;overflow-wrap:normal}article table{display:block;max-width:100%;overflow-x:auto}.math-scroll{max-width:100%;overflow-x:auto}.wiki-link-text{color:var(--text-accent,#93b4f4)}';

function pluginSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  return { ...sanitizeSettings(source), uiLanguage: normalizeLocale(source.uiLanguage) };
}

async function readSelectedSource(app, file) {
  const candidates = new Set();
  const active = app.workspace.getActiveViewOfType(MarkdownView);
  const views = [active, ...(app.workspace.getLeavesOfType?.('markdown') || []).map(leaf => leaf.view)];
  for (const view of views) {
    if (view?.file?.path !== file.path || !view.editor) continue;
    if (typeof view.getMode === 'function' && view.getMode() !== 'source') continue;
    candidates.add(view.editor.getValue().replace(/\r\n/g, '\n'));
  }
  if (candidates.size > 1) throw new Error('conflicting_editors');
  if (candidates.size === 1) return [...candidates][0];
  return (await app.vault.cachedRead(file)).replace(/\r\n/g, '\n');
}

function safeSiteUrl(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f\\]/u.test(value)
      || value.includes('?') || value.includes('#')) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password ? value : '';
  } catch {
    return '';
  }
}

function safePostUrl(value, siteValue) {
  const site = safeSiteUrl(siteValue);
  if (!site || typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f\\]/u.test(value)) return '';
  try {
    const base = new URL(site);
    const url = new URL(value);
    const query = [...url.searchParams];
    const nativeQuery = query.length === 1 && query[0][0] === 'p' && /^[1-9]\d*$/u.test(query[0][1])
      && Number.isSafeInteger(Number(query[0][1]));
    return url.protocol === 'https:' && url.origin === base.origin && !url.username && !url.password && !url.hash
      && (!url.search || nativeQuery) ? value : '';
  } catch {
    return '';
  }
}

function offlineCss(value) {
  if (typeof value !== 'string' || value.length > 4 * 1024 * 1024 || /@import\b/i.test(value)) return '';
  const urls = value.match(/url\(([^)]*)\)/gi) || [];
  if (urls.some((entry) => !/^url\(\s*['"]?data:/i.test(entry))) return '';
  return value.replace(/<\/style/gi, '<\\/style');
}

function articleWithoutLinks(html) {
  if (typeof html !== 'string' || html.length > 1024 * 1024) return '';
  if (typeof DOMParser === 'function') {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    for (const anchor of parsed.querySelectorAll('a')) {
      anchor.removeAttribute('href');
      anchor.removeAttribute('target');
      anchor.removeAttribute('rel');
    }
    return parsed.body.innerHTML;
  }
  return html
    .replace(/<a\b([^>]*)>/gi, (_tag, attrs) => `<span${attrs.replace(/\s+(?:href|target|rel)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')}>`)
    .replace(/<\/a\s*>/gi, '</span>');
}

function buildFrameDocument(html, katexCss = '', localImages = new Map(), customCss = '') {
  const styles = `${BASE_CSS}\n${offlineCss(katexCss)}\n${safeCustomCss(customCss) || ''}`;
  // Renderer output contains quoted raster-image src attributes. Blob URLs
  // belong to the parent origin and cannot load in an opaque sandbox frame.
  // Only substitute data backed by the controller's already bounded reads.
  const body = articleWithoutLinks(html).replace(/\bsrc="(blob:[^"]*)"/g, (_attribute, url) => {
    const data = localImages.get(url);
    return typeof data === 'string' && /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[A-Za-z0-9+/]+={0,2}$/.test(data)
      ? `src="${data}"` : '';
  });
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}"><meta name="referrer" content="no-referrer"><style>${styles}</style></head><body>${body}</body></html>`;
}

function localKatexCss() {
  try {
    const assets = require('./preview-assets');
    return typeof assets.katexCss === 'string' ? assets.katexCss : '';
  } catch {
    // The generated offline CSS module is integrated by the asset build step.
    return '';
  }
}

class BlogPreviewView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.preview = null;
    this.busy = false;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.plugin.text('preview.title'); }
  getIcon() { return 'file-text'; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('native-wordpress-preview');
    const toolbar = root.createDiv({ cls: 'native-wordpress-toolbar' });
    this.infoEl = toolbar.createDiv({ cls: 'native-wordpress-info' });
    const actions = toolbar.createDiv({ cls: 'native-wordpress-actions' });
    this.publishButton = actions.createEl('button', { text: this.plugin.text('preview.publish'), attr: { type: 'button' } });
    this.checkButton = actions.createEl('button', { text: this.plugin.text('preview.check'), attr: { type: 'button' } });
    this.restoreButton = actions.createEl('button', { text: this.plugin.text('preview.restore'), attr: { type: 'button' } });
    this.feedbackEl = root.createDiv({ cls: 'native-wordpress-feedback', attr: { 'aria-live': 'polite' } });
    this.frame = root.createEl('iframe', { cls: 'native-wordpress-frame', attr: { title: this.plugin.text('preview.toolbarTitle'), sandbox: '' } });
    this.frame.setAttribute('sandbox', '');
    this.publishButton.addEventListener('click', () => { void this.plugin.runAction('publish'); });
    this.checkButton.addEventListener('click', () => { void this.plugin.runAction('checkStatus'); });
    this.restoreButton.addEventListener('click', () => { this.plugin.openRestoreModal(); });
    this.plugin.attachView(this);
    this.update(this.plugin.lastPreview);
    this.plugin.scheduleRefresh();
  }

  async onClose() {
    this.plugin.detachView(this);
    if (this.frame) this.frame.srcdoc = '';
  }

  update(preview) {
    this.preview = preview || null;
    if (!this.infoEl || !this.publishButton || !this.checkButton) return;
    this.infoEl.empty();
    const siteUrl = safeSiteUrl(preview?.siteUrl || this.plugin.settings.siteUrl);
    const publishedUrl = safePostUrl(preview?.publishedLink || '', siteUrl);
    if (publishedUrl) {
      this.infoEl.createEl('a', { text: this.plugin.text('preview.viewArticle'), href: publishedUrl, attr: { target: '_blank', rel: 'noopener noreferrer' } });
    } else if (siteUrl) {
      this.infoEl.createEl('a', { text: this.plugin.text('preview.site'), href: siteUrl, attr: { target: '_blank', rel: 'noopener noreferrer' } });
    } else {
      this.infoEl.createSpan({ text: this.plugin.text('preview.siteUnset') });
    }
    const stateKey = preview?.manualRequired ? 'preview.stateManual' : preview?.needsCheck ? 'preview.stateNeedsCheck'
      : preview?.dirty ? 'preview.stateDirty'
        : preview?.publishedLink ? 'preview.statePublished' : 'preview.stateLocal';
    const stateText = this.plugin.text(stateKey);
    this.infoEl.createSpan({ text: stateText, cls: 'native-wordpress-state' });

    const issueText = Array.isArray(preview?.issues) ? preview.issues.map((item) => issueMessage(this.plugin.settings.uiLanguage, item.code)).filter(Boolean).join(' ') : '';
    const styleText = this.plugin.styleMessage ? this.plugin.text(this.plugin.styleMessage) : '';
    this.feedbackEl.setText([issueText, styleText].filter(Boolean).join(' '));
    this.publishButton.setText(this.plugin.text(preview?.publishedLink ? 'preview.update' : 'preview.publish'));
    this.publishButton.disabled = this.busy || !preview?.canPublish || preview?.needsCheck === true;
    this.checkButton.disabled = this.busy || preview?.needsCheck !== true || preview?.manualRequired === true;
    this.checkButton.hidden = preview?.needsCheck !== true || preview?.manualRequired === true;
    this.restoreButton.disabled = this.busy;
    this.restoreButton.hidden = preview?.canRestore !== true;
    if (this.frame) this.frame.setAttribute('title', this.plugin.text('preview.toolbarTitle'));
    if (this.frame && preview) this.frame.srcdoc = buildFrameDocument(preview.html, localKatexCss(), this.plugin.previewImages, this.plugin.customCss);
  }

  setBusy(value) {
    this.busy = value === true;
    this.update(this.preview);
  }

  showAction(message) {
    if (this.feedbackEl && message) this.feedbackEl.setText(message);
  }
}

class RestoreAssociationModal extends Modal {
  constructor(plugin, oldPath) {
    super(plugin.app);
    this.plugin = plugin;
    this.oldPath = oldPath;
  }

  onOpen() {
    this.target = this.plugin.controller.captureAssociationTarget();
    this.render();
  }

  render() {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: this.plugin.text('modal.title') });
    this.contentEl.createEl('p', { text: this.plugin.text('modal.description') });
    new Setting(this.contentEl).setName(this.plugin.text('modal.path'))
      .addText(text => text.setPlaceholder(this.plugin.text('modal.pathPlaceholder')).setValue(this.oldPath)
        .onChange(value => { this.oldPath = value; }));
    new Setting(this.contentEl).addButton(button => button.setButtonText(this.plugin.text('modal.confirm')).onClick(async () => {
      try {
        const result = await this.plugin.controller.restoreAssociation(this.oldPath, this.target);
        new Notice(resultMessage(this.plugin.settings.uiLanguage, result, 'restore'), 5000);
        if (result.status === 'restored') this.close();
      } catch { new Notice(this.plugin.text('modal.failed'), 5000); }
      finally { this.plugin.scheduleRefresh(); }
    }));
  }

  onClose() {
    if (this.plugin.restoreModal === this) this.plugin.restoreModal = null;
  }
}

class BlogSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const t = (key) => this.plugin.text(key);
    containerEl.createEl('h2', { text: t('settings.title') });
    new Setting(containerEl)
      .setName(t('settings.language'))
      .addDropdown((dropdown) => {
        for (const language of LANGUAGES) dropdown.addOption(language.value, language.label);
        dropdown.setValue(this.plugin.settings.uiLanguage)
          .onChange((value) => { void this.plugin.updateLocale(value); });
      });
    new Setting(containerEl)
      .setName(t('settings.site'))
      .setDesc(t('settings.siteDescription'))
      .addText((text) => text.setPlaceholder('https://example.com').setValue(this.plugin.settings.siteUrl)
        .onChange((value) => { void this.plugin.updateSetting('siteUrl', value); }));
    new Setting(containerEl)
      .setName(t('settings.username'))
      .setDesc(t('settings.usernameDescription'))
      .addText((text) => text.setValue(this.plugin.settings.username)
        .onChange((value) => { void this.plugin.updateSetting('username', value); }));
    new Setting(containerEl)
      .setName(t('settings.secret'))
      .setDesc(t('settings.secretDescription'))
      .addComponent((element) => new SecretComponent(this.app, element)
        .setValue(this.plugin.settings.secretRef)
        .onChange((value) => { void this.plugin.updateSetting('secretRef', value || ''); }));
    const passwordHelp = containerEl.createEl('details', { cls: 'native-wordpress-password-help' });
    passwordHelp.createEl('summary', { text: t('settings.passwordHelpTitle') });
    passwordHelp.createEl('p', { text: t('settings.passwordHelp1') });
    passwordHelp.createEl('p', { text: t('settings.passwordHelp2') });
    passwordHelp.createEl('p', { text: t('settings.passwordHelp3') });
    new Setting(containerEl)
      .setName(t('settings.previewCss'))
      .setDesc(t('settings.previewCssDescription'))
      .addText(text => text.setPlaceholder('styles/blog.css').setValue(this.plugin.settings.previewCssPath || '')
        .onChange(value => { void this.plugin.updateSetting('previewCssPath', value); }));
    new Setting(containerEl)
      .setName(t('settings.connection'))
      .setDesc(t('settings.connectionDescription'))
      .addButton((button) => button.setButtonText(t('settings.connectionButton')).onClick(async () => {
        const result = await this.plugin.controller.testConnection();
        new Notice(resultMessage(this.plugin.settings.uiLanguage, result, 'connection'), 5000);
      }));
  }
}

class NativeWordPressPlugin extends Plugin {
  text(key) {
    return translate(this.settings?.uiLanguage, key);
  }

  registerLocalizedCommands() {
    if (this.commandsRegistered) {
      this.removeCommand('open-blog-preview');
      this.removeCommand('restore-published-association');
    }
    this.addCommand({ id: 'open-blog-preview', name: this.text('command.openPreview'), callback: () => { void this.openPreview(); } });
    this.addCommand({ id: 'restore-published-association', name: this.text('command.restoreAssociation'), callback: () => this.openRestoreModal() });
    this.commandsRegistered = true;
  }

  async onload() {
    const stored = await this.loadData();
    this.settings = pluginSettings(stored);
    const hasUnknownSettings = stored && typeof stored === 'object' && !Array.isArray(stored)
      && Object.keys(stored).some((key) => !['siteUrl', 'username', 'secretRef', 'previewCssPath', 'uiLanguage'].includes(key));
    if (hasUnknownSettings) {
      try { await this.saveData({ ...this.settings }); } catch {
        this.settings.secretRef = '';
        new Notice(this.text('notice.legacySettings'), 5000);
      }
    }
    this.currentView = null;
    this.lastPreview = null;
    this.refreshTimer = null;
    this.journalStores = new Map();
    this.previewImages = new Map();
    this.styleGeneration = 0;
    this.unloaded = false;
    this.customCss = '';
    this.styleMessage = '';
    this.selectedFile = this.app.workspace.getActiveFile();
    this.controller = createHostController({
      getSettings: () => this.settings,
      getSelectedFile: () => {
        const file = this.app.workspace.getActiveFile();
        if (file instanceof TFile) { this.selectedFile = file; return file; }
        return this.app.workspace.activeLeaf?.view instanceof BlogPreviewView ? this.selectedFile : null;
      },
      isFile: (file) => file instanceof TFile,
      readSource: (file) => readSelectedSource(this.app, file),
      getAttachmentFolderPath: async () => {
        const configPath = `${this.app.vault.configDir}/app.json`;
        const stat = await this.app.vault.adapter.stat(configPath);
        if (!stat) return '';
        if (stat.size > 64 * 1024) return null;
        const config = JSON.parse(await this.app.vault.adapter.read(configPath));
        return typeof config.attachmentFolderPath === 'string' ? config.attachmentFolderPath : '';
      },
      resolveImage: (reference, notePath) => this.app.metadataCache.getFirstLinkpathDest(reference, notePath),
      readBinary: (file) => this.app.vault.readBinary(file),
      getSecret: (reference) => this.app.secretStorage?.getSecret(reference) ?? null,
      extractImageReferences,
      renderArticle,
      createObjectURL: (bytes, mime) => {
        const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        this.previewImages.set(url, `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`);
        return url;
      },
      revokeObjectURL: (url) => { this.previewImages.delete(url); URL.revokeObjectURL(url); },
      createClient: (options) => createWordPressClient(options),
      createPublisher: (options) => createPublisher(options),
      getStore: (settings) => this.getJournalStore(settings),
      pathExists: (oldPath) => !!this.app.vault.getAbstractFileByPath(oldPath),
      onPreview: (preview) => {
        this.lastPreview = preview;
        this.currentView?.update(preview);
      },
      onAction: (state) => {
        this.currentView?.setBusy(state.busy);
        if (state.result) this.currentView?.showAction(resultMessage(this.settings.uiLanguage, state.result));
      },
    });

    this.registerView(VIEW_TYPE, (leaf) => new BlogPreviewView(leaf, this));
    this.ribbonButtonEl = this.addRibbonIcon('file-text', this.text('command.openPreview'), () => { void this.openPreview(); });
    this.registerLocalizedCommands();
    this.settingsTab = new BlogSettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      this.controller.invalidate('active-leaf-change');
      this.scheduleRefresh();
    }));
    this.registerEvent(this.app.workspace.on('editor-change', (_editor, view) => {
      const active = this.selectedFile;
      if (!active || (view?.file?.path && view.file.path !== active.path)) return;
      this.controller.invalidate('editor-change');
      this.scheduleRefresh();
    }));
    this.registerEvent(this.app.vault.on('create', (file) => this.handleVaultChange(file?.path)));
    this.registerEvent(this.app.vault.on('modify', (file) => this.handleVaultChange(file?.path)));
    this.registerEvent(this.app.vault.on('delete', (file) => this.handleVaultChange(file?.path)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if ([oldPath, file?.path].includes(this.settings.previewCssPath)) this.refreshStyle();
      const changed = this.controller.invalidate('vault-rename', oldPath) || this.controller.invalidate('vault-rename', file?.path);
      if (changed) this.scheduleRefresh();
      void this.controller.noteRenamed(file, oldPath)
        .then(associated => { if (associated) this.scheduleRefresh(); })
        .catch(() => { new Notice(this.text('notice.associationCheckFailed'), 5000); this.scheduleRefresh(); });
    }));
    this.refreshStyle();
  }

  getJournalStore(settings) {
    const siteUrl = settings.siteUrl;
    if (!siteUrl) return null;
    if (this.journalStores.has(siteUrl)) return this.journalStores.get(siteUrl);
    const adapter = this.app.vault?.adapter;
    if (typeof FileSystemAdapter !== 'function' || !(adapter instanceof FileSystemAdapter)
        || typeof adapter.getBasePath !== 'function' || !this.app.vault.configDir || !this.manifest?.id) return null;
    let createJournalStore;
    try { ({ createJournalStore } = require('./journal-store')); } catch { return null; }
    if (typeof createJournalStore !== 'function') return null;
    try {
      const directory = path.join(adapter.getBasePath(), this.app.vault.configDir, 'plugins', this.manifest.id, 'journal');
      const store = createJournalStore({ directory, siteUrl });
      if (store && typeof store.load === 'function' && typeof store.save === 'function') this.journalStores.set(siteUrl, store);
      return store || null;
    } catch {
      return null;
    }
  }

  async openPreview() {
    if (this.previewOpening) return this.previewOpening;
    this.previewOpening = (async () => {
      const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
      const leaf = existingLeaf || this.app.workspace.getRightLeaf(false) || this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
      this.scheduleRefresh();
    })();
    try {
      await this.previewOpening;
    } finally {
      this.previewOpening = null;
    }
  }

  openRestoreModal() {
    const modal = new RestoreAssociationModal(this, this.controller.proposedOldPath());
    this.restoreModal = modal;
    modal.open();
    return modal;
  }

  attachView(view) {
    this.currentView = view;
  }

  detachView(view) {
    if (this.currentView === view) this.currentView = null;
  }

  handleVaultChange(filePath) {
    if (filePath && filePath === this.settings.previewCssPath) this.refreshStyle();
    if (this.controller.invalidate('vault-change', filePath)) this.scheduleRefresh();
  }

  refreshStyle() {
    if (this.unloaded) return;
    const generation = ++this.styleGeneration;
    const filePath = this.settings.previewCssPath || '';
    this.controller.invalidate('preview-style-change');
    this.customCss = '';
    this.styleMessage = '';
    this.currentView?.update(this.lastPreview);
    this.styleRefresh = readPreviewCss(this.app.vault.adapter, filePath).then(result => {
      if (this.unloaded || generation !== this.styleGeneration || filePath !== (this.settings.previewCssPath || '')) return;
      this.customCss = result.css;
      this.styleMessage = result.message ? 'style.cssFallback' : '';
      this.currentView?.update(this.lastPreview);
      this.scheduleRefresh();
    });
  }

  scheduleRefresh() {
    if (this.unloaded) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.currentView) void this.controller.refresh();
    }, 140);
  }

  async updateSetting(key, value) {
    if (this.unloaded || !['siteUrl', 'username', 'secretRef', 'previewCssPath'].includes(key)) return;
    this.settings = pluginSettings({ ...this.settings, [key]: value });
    this.controller.setSettings();
    if (key !== 'previewCssPath') {
      this.lastPreview = null;
      this.currentView?.update(null);
    }
    if (key === 'previewCssPath') this.refreshStyle();
    const snapshot = { ...this.settings };
    this._settingsSave = (this._settingsSave || Promise.resolve()).catch(() => {}).then(() => this.saveData(snapshot));
    try { await this._settingsSave; } catch {
      new Notice(this.text('notice.settingsSaveFailed'), 5000);
    }
    this.scheduleRefresh();
  }

  async updateLocale(value) {
    if (this.unloaded) return;
    const uiLanguage = normalizeLocale(value);
    if (uiLanguage === this.settings.uiLanguage) return;
    this.settings = { ...this.settings, uiLanguage };
    const snapshot = { ...this.settings };
    this.registerLocalizedCommands();
    this.ribbonButtonEl?.setAttribute('aria-label', this.text('command.openPreview'));
    this.ribbonButtonEl?.setAttribute('title', this.text('command.openPreview'));
    this.currentView?.update(this.lastPreview);
    this.restoreModal?.render();
    this.settingsTab?.display();
    this._settingsSave = (this._settingsSave || Promise.resolve()).catch(() => {}).then(() => this.saveData(snapshot));
    try { await this._settingsSave; } catch {
      new Notice(this.text('notice.settingsSaveFailed'), 5000);
    }
  }

  async runAction(action) {
    if (!this.lastPreview || (action === 'checkStatus'
      ? this.lastPreview.needsCheck !== true || this.lastPreview.manualRequired === true
      : !this.lastPreview.canPublish || this.lastPreview.needsCheck === true)) {
      new Notice(this.text('notice.previewWait'), 5000);
      return;
    }
    let result;
    try { result = action === 'checkStatus' ? await this.controller.checkStatus() : await this.controller.publish(); }
    catch { result = { status: 'blocked', reason: 'publish_failed' }; }
    const message = resultMessage(this.settings.uiLanguage, result);
    new Notice(message, 5000);
    this.scheduleRefresh();
  }

  async onunload() {
    this.unloaded = true;
    this.styleGeneration += 1;
    this.customCss = '';
    this.styleMessage = '';
    if (this.currentView?.frame) this.currentView.frame.srcdoc = '';
    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.controller?.dispose();
    this.currentView = null;
    this.journalStores.clear();
  }
}

module.exports = NativeWordPressPlugin;
module.exports.default = NativeWordPressPlugin;
module.exports.VIEW_TYPE = VIEW_TYPE;
module.exports.BlogPreviewView = BlogPreviewView;
module.exports.BlogSettingsTab = BlogSettingsTab;
module.exports.buildFrameDocument = buildFrameDocument;
module.exports.articleWithoutLinks = articleWithoutLinks;
module.exports.safePostUrl = safePostUrl;
module.exports.readSelectedSource = readSelectedSource;
