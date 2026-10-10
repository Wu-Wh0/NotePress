# NotePress

English | [简体中文](README.zh-CN.md)

Write in Obsidian, preview locally, and publish to your WordPress blog without leaving your vault.

NotePress is a desktop Obsidian plugin that uses WordPress's native HTTPS REST API. Your explicit publish click authorizes the selected article and its referenced local images. Editing and previewing never upload content. You do not need a custom WordPress plugin, an external runtime, or a second browser approval step.

> Use [published releases](https://github.com/Wu-Wh0/Wh0-0-Blog/releases) for installable packages. NotePress 0.2.0 uses the new `notepress` ID. If you have version 0.1.0 (`wordpress-publisher`), read the migration section before installing it.

[Installation](#installation) · [First publish](#first-publish) · [Upgrading from 0.1.0](#upgrading-from-010) · [Supported content](#supported-content) · [Development](#development)

## What it does

- A local blog-style preview, with formulas, tables, code, and referenced images.
- Explicit publishing and same-post updates, with remote readback before reporting success.
- Conflict detection and conservative recovery when a write result is uncertain.
- Explicit association recovery after a published note is renamed or moved.
- Simplified Chinese and English interface options, plus optional local preview CSS.

NotePress is not a two-way sync tool. Your Obsidian note remains the source of the article, and the preview does not reproduce every WordPress theme pixel for pixel.

## Requirements

- Obsidian **desktop 1.11.4 or later**; mobile is not supported.
- A WordPress site reachable over HTTPS, with REST API and application passwords enabled.
- A WordPress author account with permissions to publish posts and upload files.

The plugin is not currently listed in the Obsidian community marketplace.

## Installation

### With BRAT

To install a published NotePress version:

1. Install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat) from the Obsidian community marketplace.
2. In BRAT settings, add the repository `Wu-Wh0/Wh0-0-Blog` and select the published NotePress version.
3. Enable NotePress in **Settings → Community plugins**.

The repository is public, so normal downloads do not require a GitHub token. Start with manual update checks; review release notes before upgrading. If you already use version 0.1.0, migrate first rather than installing a second copy alongside it.

### Manual installation

1. Download `notepress.zip` from the NotePress [release](https://github.com/Wu-Wh0/Wh0-0-Blog/releases), or download `main.js`, `manifest.json`, and `styles.css` separately.
2. Put those three files directly in `<vault>/.obsidian/plugins/notepress/`. Do not leave an extra nested directory after extracting the ZIP. If you use a custom Obsidian configuration directory, replace `.obsidian` with that directory.
3. Restart Obsidian and enable NotePress in **Settings → Community plugins**.

## First publish

1. Open NotePress settings. Choose **简体中文** or **English**; the default is Chinese.
2. Enter your WordPress HTTPS root URL and author username.
3. Select an application password through Obsidian's secure storage, then click **Test connection**.
4. Open a Markdown article and run **Open blog preview**. Resolve any warnings shown in the preview.
5. Click **Publish article**. After the result is verified, use **View article** to open the post on your blog.

Later edits stay local until you click **Update article**. NotePress uses the recorded post ID rather than creating another article. Changing the interface language does not translate your article or change connection settings.

### WordPress application password

An application password lets this plugin act as your WordPress author through the API: upload referenced images, publish and update articles. It is **not your website login password**, and you can revoke it separately. It uses the account's existing permissions, not a plugin-specific restricted permission set.

1. In your site's WordPress dashboard, open **Users → Profile → Application Passwords** and create an entry for Obsidian. WordPress shows the generated password only once.
2. In the plugin's **Application password** selector, add that password to Obsidian's secret storage, save it and select it. The secret name is only a local label: choose any name you recognize. Adding a local secret does not generate a WordPress application password. Plugin settings save only the reference, not the password.
3. Enter the matching HTTPS site and WordPress username, then use **Test connection**. Do not paste credentials into notes, chat, URLs or logs.
4. To revoke access, remove this entry under the same WordPress **Application Passwords** section. Deleting an Obsidian secret alone does not revoke server access. If the WordPress section is missing, check that your version supports application passwords, the site uses HTTPS and the site administrator has not disabled them.

The settings page also provides this help in a short expandable section.

## Upgrading from 0.1.0

Version 0.1.0 is named 博客发布 and uses the ID `wordpress-publisher`. NotePress 0.2.0 uses `notepress`. This ID change needs a one-time local migration; BRAT installation alone does not move the old plugin's data.

**Preserve the entire old plugin directory, including `data.json` and `journal/`.** They contain connection references and publication associations. Losing the journal can make an existing article look unpublished.

Before migration, finish or resolve any pending publication and close Obsidian. Keep a recovery copy of the old plugin directory and `community-plugins.json` outside the active plugin directory. Rename `plugins/wordpress-publisher/` to `plugins/notepress/`, replace only the three installation files with the new release, and replace the enabled ID `wordpress-publisher` with `notepress` in `community-plugins.json`. Preserve all other enabled plugin IDs and existing data files.

If both directories already exist, stop and resolve the conflict; do not merge their journals or enable both copies. After restarting, check the connection settings and the association of a previously published article before clicking Publish or Update. You can then register the repository in BRAT for future updates.

## Supported content

| Content | Behavior |
| --- | --- |
| Markdown paragraphs, headings, lists, tables, code | Supported |
| Inline and block formulas | Local KaTeX preview; native MathML in published content |
| Obsidian image embeds and Markdown images | Uploads only referenced, resolved local images |
| Wikilinks | Converts to visibly marked display text; does not export linked notes or vault paths |
| Note properties | Excluded from publication content |
| Non-image note embeds, dynamic plugin queries, raw HTML, hidden Obsidian comments | Blocks publication; literal comment delimiters in code stay literal |
| Remote or ambiguous images | Does not download or guess; asks you to fix the reference |

For old-site image URLs or root-relative `/images/` paths, deliberately move the image into your vault and update the reference. NotePress does not migrate or download these images automatically.

### Local preview CSS

Set **Local preview CSS** to a Vault-relative path such as `styles/blog.css`, or leave it blank for the built-in style. CSS affects only the preview and is never uploaded. Changes refresh locally; invalid or missing files fall back to the built-in style with a warning.

Files must be non-hidden, non-linked CSS files inside the vault and at most 128 KiB. External resource references (`@import`, `url()`, `image-set()`), CSS escapes, and `<` are unsupported. Bundled offline formula fonts remain available.

## Recovery and publishing limits

### Renamed or moved notes

Use **Restore published article association** and confirm the former Vault-relative path. The former path must no longer exist. Recovery requires a completed local receipt on the same site and for the same author; NotePress checks the exact remote post before restoring the local association.

Recovery itself never publishes, uploads, edits your Markdown, or creates another post. Review the preview, then click **Update article** separately. After an external move or a cold start, restore the association before publishing: NotePress cannot prove identity from an article's title or content and does not search your vault to guess it.

### Uncertain results or remote changes

If a write result is uncertain, use **Check result** when available. Do not delete the publishing journal or repeatedly click Publish to force a retry. A remote article change blocks overwrite rather than silently replacing it.

Known-ID drafts and final post writes can be verified by exact readback. New-article creation uses a temporary correlation slug to support read-only checking; a client-generated ID is not a WordPress idempotency guarantee. Older unanchored create records and uncertain image uploads remain blocked for manual checking.

WordPress native REST has no atomic transaction or compare-and-swap guarantee. A remote edit can race after a baseline read, and uploaded media can become publicly reachable before the article is published. Substantive filtering or mismatching content blocks completion rather than being reported as success.

<details>
<summary>Technical recovery boundaries</summary>

- Only a unique, strictly verified create-anchor candidate can be adopted; lookup never writes remotely or retries creation. Observed ambiguity or an interrupted durable lookup stays blocked. The temporary anchor is cleared before final publication and must not remain in the final slug or link.
- Known-ID draft continuation requires exact owner, status, title, content, and plan readback. A separate publish click rechecks the baseline and continues that ID without repeating creation or acknowledged uploads.
- Pending operations cannot be moved to another note association. Retired paths cannot reuse the old receipt. Association records store path hashes and stable IDs, not readable paths or note contents.
- If local storage cannot save a rename guard, the current session blocks publishing but cannot promise that a new guard survives restart.
- The durable journal contains hashes, IDs, and safe URLs, not article bodies or credentials. Preview title, wrapper, and CSS are separate from published content.

</details>

## Development

Install locked dependencies separately on each operating system with `npm ci --ignore-scripts --no-audit --no-fund`, then run `npm test` and `npm run build`. The deterministic install ZIP contains only the three installation files. KaTeX fonts are embedded in the bundle; Obsidian and Node built-ins remain host-provided.

Tests require Node.js with `node:test`, Git for checkout-attribute verification and OpenSSL for loopback TLS fixtures. `OPENSSL_BIN` can select OpenSSL; `WORDPRESS_TEST_SCRATCH` can select transport fixture storage; other disposable fixtures use `TMPDIR` or the platform temporary directory. Do not commit dependencies, certificates, databases, credentials, generated install files or private runtime evidence.

## Draft release workflow

Future release tags use bare numeric semantic versions such as `0.2.0`—no `v` prefix. The workflow requires the tag to match `package.json`, both version fields in `package-lock.json`, and `manifest.json`, and refuses tags whose commit is not reachable from `main`. The existing `0.1.0` release is retained; reusing that tag fails closed whether its release is a draft or already published.

The workflow prepares a GitHub Draft only and refuses to overwrite an existing release. It verifies the three installation files, `notepress.zip`, and `SHA256SUMS.txt` by download and byte comparison. A maintainer reviews and publishes the Draft separately. See [CONTRIBUTING.md](CONTRIBUTING.md) for the release checklist.

Dependabot dependency PRs must keep `build.mjs`'s exact `EXPECTED.markdownIt`, `EXPECTED.katex` and `EXPECTED.esbuild` pins synchronized with the approved exact versions in `package.json` and `package-lock.json`; do not weaken the build's pin checks. When changing the plugin version, also synchronize `EXPECTED.packageVersion`, `package.json`, both package-lock version fields, `manifest.json` and `versions.json` before release.

## Modules and evidence

- `wordpress-client.js`: verified HTTPS, native REST, bounded responses and dispatched/indeterminate write errors.
- `article.js`: safe parsing/rendering without filesystem or network access.
- `publisher.js` and `journal-store.js`: frozen intent, durable write-ahead records, cold recovery, exact known-ID readback and conflict checks.
- `host-controller.js` and `main.js`: current editor and image selection, event invalidation, local preview, native settings and explicit action buttons.
- `build.mjs`: confined deterministic packaging; `.github/workflows/native-wordpress.yml`: portable tests and build on Ubuntu and Windows; `.github/workflows/release.yml`: validates a numeric version tag and prepares a verified GitHub Draft only (manual publication remains separate).

Contributions, verification layers and the pull request checklist are in [CONTRIBUTING.md](CONTRIBUTING.md); vulnerability reports go through [SECURITY.md](SECURITY.md) instead of public issues.

Automated evidence covers synthetic TLS, real disk persistence and an assembled controller/renderer/publisher/store with synthetic remote responses. It does not replace native GUI acceptance, real WordPress HTTP integration, hosted checks or author approval.
