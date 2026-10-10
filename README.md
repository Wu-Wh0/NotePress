# Obsidian WordPress publisher

A desktop Obsidian plugin for local article previews and explicit publication through WordPress's native HTTPS REST API. No custom WordPress plugin, browser approval step, external Node runtime or WSL is required by the installed plugin.

The built-in local preview provides a readable blog layout; it is not a pixel-accurate copy of an arbitrary production WordPress theme. Local automated checks alone do not establish native Obsidian behavior or deployed-theme compatibility.

## Manual installation from a GitHub Release

1. Download `wordpress-publisher.zip` from the GitHub Release, or download its three installation files: `main.js`, `manifest.json` and `styles.css`.
2. Place those three files directly in `<vault>/.obsidian/plugins/wordpress-publisher/` (extract the ZIP there if using it).
3. Use Obsidian desktop 1.11.4 or later, enable the plugin, configure the WordPress HTTPS site and author username, and select an application password through Obsidian's secret storage. Plugin settings retain only the secret reference. The plugin is not listed in the Obsidian community marketplace.
4. Open the article and use **博客预览**. Editing and previewing never upload content. **发布文章** authorizes this article and its referenced local images; after confirmed publication, the button becomes **更新文章**. **核对结果** reads an uncertain result without retrying a write.

### WordPress application password

An application password lets this plugin act as your WordPress author through the API: upload referenced images, publish and update articles. It is **not your website login password**, and you can revoke it separately. It uses the account's existing permissions, not a plugin-specific restricted permission set.

1. In your site's WordPress dashboard, open **Users → Profile → Application Passwords** and create an entry for Obsidian. WordPress shows the generated password only once.
2. In the plugin's **应用程序密码** selector, add that password to Obsidian's secret storage, save it and select it. The secret name is only a local label: choose any name you recognize. Adding a local secret does not generate a WordPress application password. Plugin settings save only the reference, not the password.
3. Enter the matching HTTPS site and WordPress username, then use **测试连接**. Do not paste credentials into notes, chat, URLs or logs.
4. To revoke access, remove this entry under the same WordPress **Application Passwords** section. Deleting an Obsidian secret alone does not revoke server access. If the WordPress section is missing, check that your version supports application passwords, the site uses HTTPS and the site administrator has not disabled them.

The settings page provides this help in a short expandable section; there is no extra setup wizard or server installation.

Optional **本地预览 CSS** accepts one explicit Vault-relative `.css` path (for example `styles/blog.css`); blank keeps the built-in theme. Files are limited to 128 KiB before and after reading. Custom rules follow built-in preview styles and are never added to publication HTML, uploads or receipts. Creation, changes, deletion, rename and clearing the setting refresh or fall back to built-in styling. Invalid files show a message in the preview. Resource references (`@import`, `url()`, `image-set()`), CSS escapes and `<` are deliberately unsupported; bundled offline KaTeX fonts remain available. Hidden files/folders (including `.obsidian`) are unsupported because normal Vault change events do not cover them. Linked descendants are rejected by real-path checks before the desktop adapter reads CSS; no folders are scanned.

## Supported boundary

- Markdown paragraphs, headings, lists, tables, code and bounded KaTeX expressions; Obsidian image embeds and Markdown images. Note properties are excluded from publication. Preview title/wrapper and publication body are separate.
- Local formulas keep the bundled KaTeX styling/fonts. Published formulas use native MathML without site-side JavaScript, CSS or a custom WordPress plugin; modern browsers render them directly. Typography can differ from the preview. A WordPress version or filter that removes formula content leaves a mismatching draft blocked instead of silently publishing it.
- Wikilinks become visibly marked display text, not exported note contents or vault paths. Non-image note embeds, dynamic plugin queries, raw HTML and hidden Obsidian comments block publication. Literal comment delimiters inside code samples remain literal.
- Only referenced images are read. Basename references must match the configured attachment location; path-qualified references must match the resolver's exact target. Unresolved or ambiguous paths block publication. Remote images are not downloaded. The sandboxed preview does not load external resources; formula fonts are included offline.
- Old-site `/images/` URLs or root-relative paths must be deliberately migrated by the author to actual Vault attachments before publication. The plugin does not download old-site images or guess a matching Vault path.
- Confirmed articles are updated using the same recorded remote ID. Remote changes block overwrite. A durable journal stores hashes, IDs and safe URLs, not article bodies or credentials. For a selected published Markdown note renamed or moved through Obsidian, the plugin saves a site-bound local pending association before offering **恢复关联**. Publish on that path is blocked until the author confirms its former Vault-relative path; the plugin then checks the local completed receipt and reads the exact remote post before activating the association. Confirmation never publishes, uploads, creates or edits Markdown. After recovery, review the preview and click **更新文章** separately. After a cold start or an external move while Obsidian was closed, use the **恢复已发布文章关联** command and enter the former path yourself before publishing; content and title cannot prove identity, so the plugin does not search or automatically claim moved notes. The former path must no longer exist. Association records contain path hashes and stable journal IDs, not readable paths or article text. If local storage cannot save the pending association, the current session blocks publishing, but it cannot retain a new guard across restart.
- Known-ID empty or fully prepared drafts can be checked without remote writes. Exact owner/status/title/content/plan readback is saved as a draft baseline; after restart, a separate **发布文章** click rechecks that baseline and continues the same ID without repeating creation or acknowledged image uploads. Changed plans or remote drafts remain blocked. Filtered/mismatching content is not accepted or silently published. Uncertain media uploads are not resolved this way; native REST still has no transactional compare-and-swap guarantee.
- A new draft is created with a temporary `obsidian-create-…` slug as a correlation anchor. If that creation's result is unknown, a later **核对结果** read-only looks the anchor up: exactly one candidate of type `post`, owned by you, still an empty-titled-body draft with that exact slug is adopted under its own ID; zero candidates, more than one candidate, or any mismatch stays blocked as **需人工核对**. The lookup writes nothing remotely and never creates a post, so a lost acknowledgement cannot turn into a second article. The anchor slug is visible in the WordPress admin while the draft exists and is cleared before the final publish; the plugin refuses to report success if a marker remains in the final slug or link. Records written before this anchor existed keep the previous behaviour and stay frozen, and uncertain media stays frozen even when a post ID is known, because a post read cannot prove which upload succeeded; that part is tracked in [issue #15](https://github.com/Wu-Wh0/Wh0-0-Blog/issues/15). Known-ID final publication/post-update uncertainty can still be checked by exact readback. No automatic create retry is provided, and a client-generated identifier does not make native REST writes idempotent. Media can become publicly reachable before article publication; there is no native transaction or atomic compare-and-swap guarantee.
- Rename/move recovery is limited to an exact completed receipt on the same site and owner. Pending create, media or other operations cannot be moved; a retired path cannot silently reuse the old receipt. A remote change or local association error blocks recovery. Native WordPress REST has no atomic compare-and-swap, so a remote edit can still race after readback; an ordinary explicit update repeats its baseline check. Preview templates remain tracked in [issue #17](https://github.com/Wu-Wh0/Wh0-0-Blog/issues/17).

## Development

Install locked dependencies separately on each operating system with `npm ci --ignore-scripts --no-audit --no-fund`, then run `npm test` and `npm run build`. The deterministic install ZIP contains only the three installation files. KaTeX fonts are embedded in the bundle; Obsidian and Node built-ins remain host-provided.

Tests require Node.js with `node:test`, Git for checkout-attribute verification and OpenSSL for loopback TLS fixtures. `OPENSSL_BIN` can select OpenSSL; `WORDPRESS_TEST_SCRATCH` can select transport fixture storage; other disposable fixtures use `TMPDIR` or the platform temporary directory. Do not commit dependencies, certificates, databases, credentials, generated install files or private runtime evidence.

## Draft release workflow

Future release tags use bare numeric semantic versions such as `0.2.0`—no `v` prefix. The workflow requires the tag to match `package.json`, both version fields in `package-lock.json`, and `manifest.json`, and refuses tags whose commit is not reachable from `main`. The existing `0.1.0` release is retained; reusing that tag fails closed whether its release is a draft or already published.

The workflow creates a GitHub Draft only. It never publishes or updates an existing release, and asset uploads do not use clobbering. Before reporting the draft prepared, it validates the ZIP has exactly `main.js`, `manifest.json` and `styles.css`, checks those members against the built files, writes `SHA256SUMS.txt`, uploads all five assets (`main.js`, `manifest.json`, `styles.css`, `wordpress-publisher.zip`, `SHA256SUMS.txt`), then downloads and compares each asset and verifies the checksums. A maintainer must review the draft and manually publish it as a separate approval step.

Dependabot dependency PRs must keep `build.mjs`'s exact `EXPECTED.markdownIt`, `EXPECTED.katex` and `EXPECTED.esbuild` pins synchronized with the approved exact versions in `package.json` and `package-lock.json`; do not weaken the build's pin checks. When changing the plugin version, also synchronize `EXPECTED.packageVersion`, `package.json`, both package-lock version fields, `manifest.json` and `versions.json` before release.

## Modules and evidence

- `wordpress-client.js`: verified HTTPS, native REST, bounded responses and dispatched/indeterminate write errors.
- `article.js`: safe parsing/rendering without filesystem or network access.
- `publisher.js` and `journal-store.js`: frozen intent, durable write-ahead records, cold recovery, exact known-ID readback and conflict checks.
- `host-controller.js` and `main.js`: current editor and image selection, event invalidation, local preview, native settings and explicit action buttons.
- `build.mjs`: confined deterministic packaging; `.github/workflows/native-wordpress.yml`: portable tests and build on Ubuntu and Windows; `.github/workflows/release.yml`: validates a numeric version tag and prepares a verified GitHub Draft only (manual publication remains separate).

Contributions, verification layers and the pull request checklist are in [CONTRIBUTING.md](CONTRIBUTING.md); vulnerability reports go through [SECURITY.md](SECURITY.md) instead of public issues.

Automated evidence covers synthetic TLS, real disk persistence and an assembled controller/renderer/publisher/store with synthetic remote responses. It does not replace native GUI acceptance, real WordPress HTTP integration, hosted checks or author approval.
