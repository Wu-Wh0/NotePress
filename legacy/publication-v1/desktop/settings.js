'use strict';

const { PluginSettingTab, Setting, SecretComponent } = require('obsidian');

module.exports = class DirectConnectionSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    this.siteUrlInput = null;
    this.usernameInput = null;
    this.secretComponent = null;
    this.connectionDescription = '只检查连接，不上传文章。';

    const siteSetting = new Setting(containerEl)
      .setName('站点 HTTPS 地址')
      .setDesc('填写 WordPress 站点的 HTTPS 地址。');
    siteSetting.addText(text => {
      this.siteUrlInput = text
        .setPlaceholder('https://example.com')
        .setValue(this.plugin.connectionSettings.siteUrl)
        .onChange(value => this.plugin.updateConnectionSetting('siteUrl', value));
    });

    const usernameSetting = new Setting(containerEl)
      .setName('用户名')
      .setDesc('填写用于连接验证的 WordPress 用户名。');
    usernameSetting.addText(text => {
      this.usernameInput = text
        .setPlaceholder('WordPress 用户名')
        .setValue(this.plugin.connectionSettings.username)
        .onChange(value => this.plugin.updateConnectionSetting('username', value));
    });

    const secretSetting = new Setting(containerEl)
      .setName('发布凭据')
      .setDesc('选择 Obsidian 安全存储中的凭据；此设置只保存名称，不保存凭据值。');
    this.secretComponent = new SecretComponent(this.app, secretSetting.controlEl)
      .setValue(this.plugin.connectionSettings.secretName)
      .onChange(name => this.plugin.updateConnectionSetting('secretName', name));

    this.statusSetting = new Setting(containerEl)
      .setName('测试连接')
      .setDesc(this.connectionDescription)
      .addButton(button => button
        .setButtonText('测试连接')
        .onClick(() => this.plugin.testConnection())
      );
  }

  setStatus(message) {
    if (this.statusSetting) this.statusSetting.setDesc(message);
  }
};
