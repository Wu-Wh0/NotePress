# Native WordPress publisher modules

Desktop-oriented Obsidian publication through WordPress's native REST API, without a custom WordPress plugin. This directory currently contains the transport, Markdown/image-reference renderer and publication/journal orchestration modules. It is **not yet an installable Obsidian plugin**.

## Development

Use a supported Node.js runtime with `node:test` and an OpenSSL executable for the loopback TLS fixtures. Install the locked dependencies with `npm ci`, then run `npm test` from this directory. If OpenSSL is not on PATH, set `OPENSSL_BIN` to its executable. `WORDPRESS_TEST_SCRATCH` optionally selects the fixture directory; otherwise the tests use `TMPDIR` or the platform temporary directory.

Dependencies are installed separately on each operating system. Commit source, tests and the lockfile, not `node_modules`, generated certificates, local databases, credentials or runtime evidence.

## Module boundaries

- `src/wordpress-client.js`: certificate-verified HTTPS, native REST methods, bounded responses and explicit dispatched/indeterminate write errors; no automatic write retry.
- `src/article.js`: current-article references and safe rendering without filesystem or network access. Note frontmatter is not published. `html` is a preview including its title; `bodyHtml` is the publication body. Check `blocked` before consuming either.
- `src/publisher.js`: explicit publication, injected client/store, same-note serialization, write-ahead journal, exact known-ID readback and update conflict checks. The host must provide a genuinely durable store and an `isCurrent` callback bound to the selected note, title, image bytes and site configuration.

Tests exercise synthetic TLS and an in-memory client/store. They do not establish actual WordPress deployment, durable crash recovery, native Obsidian UI or pixel-identical theme rendering. Unknown create/media outcomes remain pending; a client-generated identifier does not make native REST creates idempotent.
