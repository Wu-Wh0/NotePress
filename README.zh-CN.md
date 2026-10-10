# NotePress

[English](README.md) | 简体中文

在 Obsidian 中写作、本地预览，再发布到自己的 WordPress 博客。

NotePress 是一个 Obsidian 桌面插件，通过 WordPress 原生 HTTPS REST API 发布文章。你点击发布，才会上传当前文章及其引用的本地图片；编辑和预览不会上传内容。不需要额外安装 WordPress 插件、独立运行时，也不需要切到浏览器再次批准。

> 安装请以 [Releases 中已发布的版本](https://github.com/Wu-Wh0/Wh0-0-Blog/releases)为准。NotePress 0.2.0 使用新 ID `notepress`。如果已安装 0.1.0（`wordpress-publisher`），请先阅读迁移说明。

[安装](#安装) · [首次发布](#首次发布) · [从 0.1.0 升级](#从-010-升级) · [支持的内容](#支持的内容) · [开发](#开发)

## 能做什么

- 本地博客样式预览，显示公式、表格、代码和文章引用的图片。
- 明确点击后发布或更新同一篇文章，读回远端结果后才提示成功。
- 检查远端修改冲突，保守处理无法确认的写入结果。
- 通过明确确认，恢复已发布笔记改名或移动后的文章关联。
- 简体中文和英文界面，以及可选的本地预览 CSS。

NotePress 不是双向同步工具。文章以 Obsidian 笔记为源，预览也不会逐像素复刻所有 WordPress 主题。

## 使用条件

- **Obsidian 桌面版 1.11.4 或更新版本**，暂不支持移动端。
- 可通过 HTTPS 访问的 WordPress 站点，已启用 REST API 和应用程序密码。
- 具有发布文章、上传文件权限的 WordPress 作者账号。

插件目前尚未上架 Obsidian 社区插件市场。

## 安装

### 使用 BRAT

安装已发布的 NotePress 版本：

1. 在 Obsidian 社区插件市场安装并启用 [BRAT](https://github.com/TfTHacker/obsidian42-brat)。
2. 在 BRAT 设置中添加仓库 `Wu-Wh0/Wh0-0-Blog`，选择已发布的 NotePress 版本。
3. 在「设置 → 第三方插件」中启用 NotePress。

仓库已公开，正常下载不需要 GitHub token。初期建议手动检查更新，升级前阅读发布说明。如果已经安装 0.1.0，请先迁移，不要直接并排安装两个版本。

### 手动安装

1. 从 NotePress [发布页](https://github.com/Wu-Wh0/Wh0-0-Blog/releases)下载 `notepress.zip`，或分别下载 `main.js`、`manifest.json`、`styles.css`。
2. 将三个文件直接放到 `<Vault>/.obsidian/plugins/notepress/`，解压后不要多套一层文件夹。若使用自定义 Obsidian 配置目录，请用该目录替换 `.obsidian`。
3. 重启 Obsidian，在「设置 → 第三方插件」中启用 NotePress。

## 首次发布

1. 打开 NotePress 设置，选择「简体中文」或「English」，默认中文。
2. 填写 WordPress 的 HTTPS 站点根地址和作者用户名。
3. 通过 Obsidian 安全存储选择应用程序密码，再点击「测试连接」。
4. 打开一篇 Markdown 文章，运行「打开博客预览」，处理预览中的提示。
5. 点击「发布文章」。结果核对成功后，通过「查看文章」打开博客上的成稿。

发布后的修改仍留在本地，直到你点击「更新文章」。插件使用记录中的原文章 ID，不会另建一篇。切换界面语言不会翻译文章，也不会改变连接设置。

### WordPress 应用程序密码

应用程序密码允许插件以你的 WordPress 作者身份上传图片、发布和更新文章。它不是网站登录密码，可以单独撤销；它使用该账号已有的权限，并不额外限制为某个插件专用权限。

1. 在 WordPress 后台打开「用户 → 个人资料 → 应用程序密码」，为 Obsidian 创建一条。生成的密码只显示一次。
2. 在插件的「应用程序密码」选择器中，将密码保存到 Obsidian 安全存储并选中。名称只是本地标签，可以自定；保存本地秘密不会在 WordPress 创建密码。插件配置只保留引用，不保存密码值。
3. 填写对应站点和用户名，点击「测试连接」。不要把密码发到聊天、写进笔记、URL 或日志。
4. 停用时，在同一 WordPress 页面撤销这条应用程序密码。只删除 Obsidian 中的秘密不会撤销服务端权限。找不到入口时，检查 WordPress 版本、HTTPS 和站点是否允许应用程序密码。

设置页也提供了可展开的简短说明。

## 从 0.1.0 升级

0.1.0 的名称是「博客发布」，ID 为 `wordpress-publisher`；NotePress 0.2.0 的 ID 为 `notepress`。此次 ID 变更需要一次本地迁移，BRAT 安装本身不会迁移旧插件的数据。

**必须保留整个旧插件目录，包括 `data.json` 和 `journal/`。**其中有连接引用和发布关联；丢失 journal 可能让已发布文章被误认成未发布。

迁移前先完成或核对尚未确定结果的发布，并关闭 Obsidian。将旧插件目录和 `community-plugins.json` 的恢复副本保存在活跃插件目录之外。把 `plugins/wordpress-publisher/` 改名为 `plugins/notepress/`，只用新版替换三个安装文件，然后在 `community-plugins.json` 中将启用 ID `wordpress-publisher` 替换为 `notepress`。保留其他插件 ID 和已有数据文件。

如果两个目录已经同时存在，请先停止并处理冲突，不要合并 journal，也不要同时启用两个版本。重启后，核对连接设置及一篇已发布文章的关联，再点击发布或更新。迁移完成后，可将仓库加入 BRAT，接收后续更新。

## 支持的内容

| 内容 | 处理方式 |
| --- | --- |
| Markdown 段落、标题、列表、表格、代码 | 支持 |
| 行内和块公式 | 本地 KaTeX 预览，发布正文使用原生 MathML |
| Obsidian 图片嵌入、Markdown 图片 | 只上传文章实际引用且能准确定位的本地图片 |
| 双链 | 转为带标记的显示文字，不公开目标笔记或 Vault 路径 |
| 笔记属性 | 不进入发布正文 |
| 非图片笔记嵌入、动态插件查询、原始 HTML、隐藏 Obsidian 注释 | 阻断发布；代码中的字面注释分隔符保持原样 |
| 远程图片、路径歧义图片 | 不自动下载或猜测，提示你修正引用 |

旧站图片 URL 或根相对 `/images/` 路径，需要你主动将图片放到 Vault 附件中并修改引用。插件不会自动迁移或下载这些图片。

### 本地预览 CSS

在「本地预览 CSS」中填写 Vault 相对路径，例如 `styles/blog.css`；留空使用内置样式。CSS 只影响预览，不上传到站点。修改后本地刷新，文件缺失或无效时退回内置样式并显示提示。

文件必须位于 Vault 内，不隐藏、不通过链接指向其他位置，大小不超过 128 KiB。不支持外部资源引用（`@import`、`url()`、`image-set()`）、CSS 转义字符及 `<`。插件内置的离线公式字体仍可用。

## 恢复与发布边界

### 笔记改名或移动

运行「恢复已发布文章关联」，确认原来的 Vault 相对路径；原路径必须已不存在。恢复要求同站点、同作者的完整本地已发布回执，插件会读回准确的远端文章后再恢复关联。

恢复操作不会发布、上传、修改 Markdown 或另建文章。请先核对预览，再单独点击「更新文章」。如果是在 Obsidian 关闭期间移动了笔记，或冷启动后发现关联缺失，请在发布前恢复关联：标题和正文不能证明文章身份，插件不会扫描 Vault 来猜测。

### 写入结果不确定或远端发生变化

写入结果不确定时，若界面提供「核对结果」，请先使用它。不要删除发布 journal 或反复点击发布来强行重试。远端文章已经变化时，插件会阻断覆盖。

已知 ID 的草稿与最终文章写入可以通过准确读回核对。新文章创建使用临时关联 slug 支持只读核对，但客户端生成 ID 不等于 WordPress 提供了幂等保证。早期无关联锚点的创建记录、结果不确定的图片上传仍需人工核对。

WordPress 原生 REST 不提供原子事务或比较后写入保证。远端修改仍可能发生在基线读取之后；图片也可能在文章发布前就可通过公开地址访问。过滤导致实质内容损失或读回不匹配时，插件会阻断完成，不会静默提示成功。

<details>
<summary>技术恢复边界</summary>

- 只有唯一且严格核对通过的创建锚点候选才能被认领；查询不写远端，也不重试创建。已观察到歧义或持久核对中断时保持阻断。临时锚点在正式发布前清除，最终 slug 或链接中不得残留。
- 已知 ID 草稿续发要求准确核对作者、状态、标题、正文和计划。下一次单独点击发布会再次检查基线，沿用同一 ID，不重复创建或已确认的图片上传。
- 尚有待处理操作的记录不能移动关联，已退休路径不能复用旧回执。关联索引保存路径哈希和稳定 ID，不保存可读路径或笔记正文。
- 无法在本地保存改名保护标记时，当次会话会阻断发布，但不能保证新标记跨重启保留。
- journal 保存哈希、ID 和安全 URL，不保存文章正文或凭据。预览标题、容器和 CSS 与发布正文分离。

</details>

## 开发

在各操作系统中分别安装锁定依赖，再测试和构建：

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
```

安装 ZIP 只含三个插件安装文件；KaTeX 字体嵌入 bundle，Obsidian API 和 Node 内置模块由宿主提供。

测试需要支持 `node:test` 的 Node.js、Git，以及供本地 TLS 夹具使用的 OpenSSL。`OPENSSL_BIN` 可指定 OpenSSL，`WORDPRESS_TEST_SCRATCH` 可指定网络夹具目录；其他临时夹具使用 `TMPDIR` 或平台临时目录。不要提交依赖、证书、数据库、凭据、生成安装包或私有验收资料。

## Draft 发布流程

发布标签使用 `0.2.0` 这样的裸数字语义版本，不带 `v`。标签必须与 package、lock、manifest 版本一致，且对应提交可从 `main` 到达。保留已有 0.1.0，不复用标签覆盖版本。

工作流只准备 GitHub Draft，拒绝覆盖已有发布。它会下载并逐字节核对三个安装文件、`notepress.zip` 和 `SHA256SUMS.txt`，由维护者审核后单独发布。具体清单见 [CONTRIBUTING.md](CONTRIBUTING.md)。

依赖升级需同步 `build.mjs` 中 `EXPECTED.markdownIt`、`EXPECTED.katex`、`EXPECTED.esbuild` 与 package/lock 的批准版本，不能削弱锁定检查。插件版本变更还需同步 `EXPECTED.packageVersion`、package、lock 的两处版本、manifest 和 `versions.json`。

## 模块与验证

- `wordpress-client.js`：原生 HTTPS REST、有界响应和写入结果分类。
- `article.js`：无文件系统或网络访问的安全解析与渲染。
- `publisher.js`、`journal-store.js`：固定发布意图、持久日志、冷恢复、已知 ID 核对和冲突检查。
- `host-controller.js`、`main.js`：当前编辑源及图片选择、事件失效、本地预览、原生设置和明确动作按钮。
- `build.mjs` 与 GitHub Actions：确定性打包、Windows/Ubuntu 测试构建，以及只生成 Draft 的发布流程。

协作与验证层次见 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题按 [SECURITY.md](SECURITY.md) 私下报告，不放进公开 issue。

自动化测试覆盖合成 TLS、真实磁盘持久化及使用合成远端响应的完整模块组合，不代替原生 GUI、真实 WordPress HTTP、站点主题或作者确认的验收。
