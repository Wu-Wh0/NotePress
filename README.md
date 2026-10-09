# Obsidian WordPress publisher

A desktop Obsidian plugin for local article previews and explicit publication through WordPress's native HTTPS REST API. No custom WordPress plugin, browser approval step, external Node runtime or WSL is required by the installed plugin.

This is a **buildable first-version candidate**, not a production release. Native Obsidian acceptance, hosted CI and compatibility with a deployed site's theme are separate gates; local automated checks do not establish them.

## Install a built candidate

1. Build with `npm run build`, or obtain the resulting `dist/wordpress-publisher.zip`.
2. Extract `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/wordpress-publisher/`.
3. Enable the plugin in Obsidian desktop (manifest minimum: 1.11.4). Configure the WordPress HTTPS site and author username, and select an application password through Obsidian's secret storage. Plugin settings retain only the secret reference.
4. Open the article and use **博客预览**. Editing and previewing never upload content. **发布文章** authorizes this article and its referenced local images; after confirmed publication, the button becomes **更新文章**. **核对结果** reads an uncertain result without retrying a write.

Do not use a primary vault or production site for candidate acceptance.

Optional **本地预览 CSS** accepts one explicit Vault-relative `.css` path (for example `styles/blog.css`); blank keeps the built-in theme. Files are limited to 128 KiB before and after reading. Custom rules follow built-in preview styles and are never added to publication HTML, uploads or receipts. Creation, changes, deletion, rename and clearing the setting refresh or fall back to built-in styling. Invalid files show a message in the preview. Resource references (`@import`, `url()`, `image-set()`), CSS escapes and `<` are deliberately unsupported; bundled offline KaTeX fonts remain available. Hidden files/folders (including `.obsidian`) are unsupported because normal Vault change events do not cover them. Linked descendants are rejected by real-path checks before the desktop adapter reads CSS; no folders are scanned.

## Supported boundary

- Markdown paragraphs, headings, lists, tables, code and bounded KaTeX expressions; Obsidian image embeds and Markdown images. Note properties are excluded from publication. Preview title/wrapper and publication body are separate.
- Local formulas keep the bundled KaTeX styling/fonts. Published formulas use native MathML without site-side JavaScript, CSS or a custom WordPress plugin; modern browsers render them directly. Typography can differ from the preview. A WordPress version or filter that removes formula content leaves a mismatching draft blocked instead of silently publishing it.
- Wikilinks become visibly marked display text, not exported note contents or vault paths. Non-image note embeds, dynamic plugin queries, raw HTML and hidden Obsidian comments block publication. Literal comment delimiters inside code samples remain literal.
- Only referenced images are read. Basename references must match the configured attachment location; path-qualified references must match the resolver's exact target. Unresolved or ambiguous paths block publication. Remote images are not downloaded. The sandboxed preview does not load external resources; formula fonts are included offline.
- Confirmed articles are updated using the same recorded remote ID. Remote changes block overwrite. A durable journal stores hashes, IDs and safe URLs, not article bodies or credentials. Note identity currently follows its vault-relative path: rename/move reconciliation is not implemented.
- Known-ID empty or fully prepared drafts can be checked without remote writes. Exact owner/status/title/content/plan readback is saved as a draft baseline; after restart, a separate **发布文章** click rechecks that baseline and continues the same ID without repeating creation or acknowledged image uploads. Changed plans or remote drafts remain blocked. Filtered/mismatching content is not accepted or silently published. This does not resolve unknown create/media outcomes; native REST still has no transactional compare-and-swap guarantee.
- Unknown create/media outcomes stay pending, including after restart. The UI shows **需人工核对**, pauses publication and disables automatic checking. Uncertain media is an exception even when a post ID is known: a post read cannot prove which media upload succeeded, so the plugin does not continue that operation. Check WordPress manually; do not delete the local journal or repeat creation to bypass the block. Plugin-side adoption/resumption after manual checking is not implemented. Known-ID final publication/post-update uncertainty can still be checked by exact readback. No automatic create retry or automatic adoption is provided. A client-generated identifier does not make native REST writes idempotent. Media can become publicly reachable before article publication; there is no native transaction or atomic compare-and-swap guarantee.

## Development

Install locked dependencies separately on each operating system with `npm ci --ignore-scripts --no-audit --no-fund`, then run `npm test` and `npm run build`. The deterministic install ZIP contains only the three installation files. KaTeX fonts are embedded in the bundle; Obsidian and Node built-ins remain host-provided.

Tests require Node.js with `node:test`, Git for checkout-attribute verification and OpenSSL for loopback TLS fixtures. `OPENSSL_BIN` can select OpenSSL; `WORDPRESS_TEST_SCRATCH` can select transport fixture storage; other disposable fixtures use `TMPDIR` or the platform temporary directory. Do not commit dependencies, certificates, databases, credentials, generated install files or private runtime evidence.

## Modules and evidence

- `wordpress-client.js`: verified HTTPS, native REST, bounded responses and dispatched/indeterminate write errors.
- `article.js`: safe parsing/rendering without filesystem or network access.
- `publisher.js` and `journal-store.js`: frozen intent, durable write-ahead records, cold recovery, exact known-ID readback and conflict checks.
- `host-controller.js` and `main.js`: current editor and image selection, event invalidation, local preview, native settings and explicit action buttons.
- `build.mjs`: confined deterministic packaging; `.github/workflows/native-wordpress.yml`: portable tests and build on Ubuntu and Windows.

Automated evidence covers synthetic TLS, real disk persistence and an assembled controller/renderer/publisher/store with synthetic remote responses. It does not replace native GUI acceptance, real WordPress HTTP integration, hosted checks or author approval.
