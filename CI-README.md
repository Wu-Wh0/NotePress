# Publication-v1 CI

Only the explicitly selected publication-v1 source and synthetic tests are tracked. The historical WSL workspace, spikes, user content, credentials, databases, downloaded runtimes, caches, and run evidence stay out of the checkout.

## Fast CI

Pull requests and ordinary workflow-dispatch runs keep the existing fast gate: server-boundary unittests, 13 Node plugin tests, and mandatory PHP syntax checks. It is read-only and does not require production secrets.

## Full synthetic producer/WordPress gate

The full gate is separately selected from **Actions → Publication fast checks → Run workflow → `full-wordpress=true`**. It does not run on pull requests unless someone explicitly dispatches it. The job uses pinned Actions, Python 3.14.8, Node 24.21.0, `contents: read`, and checkout with persisted credentials disabled. It has no deploy, merge, or production access.

`ci/ci-full-wordpress.sh` runs the complete `unittest` suite (including the connected listener/session test), the 13 Node tests, and PHP CLI lint when available. The fast gate keeps PHP syntax lint mandatory on Ubuntu; a local absence of PHP CLI does not skip PHP-WASM integration coverage. `ci/ci-bootstrap.sh` uses `npm ci` with the checked-in locks into a fresh runtime directory outside the checkout. Parser dependencies are `markdown-it` 14.1.0 and `katex` 0.16.22; `producer/dependency-bytes.json` pins the validated runtime files, while excluding npm's generated `.package-lock.json` bookkeeping file. The producer still rejects mismatched bytes, versions, locks, symlinks, and any Node version other than 24.21.0.

The full gate pins PHP-WASM / WordPress Playground 3.1.56 and its SQLite integration ZIP in `ci/wordpress-runtime/package-lock.json`. It obtains WordPress core only from the exact official 7.1.2 archive URL in `ci/wordpress-core.lock.json`, checks the pinned SHA-256 before extraction, and then verifies the extracted version. Runtime and core preparation fail closed; tests contain no network or cache fallback.

The runtime resolver supports explicit, validated local paths:

- `PUBLICATION_NODE`: regular Node executable; exact version 24.21.0 is enforced.
- `PUBLICATION_TOOLCHAIN_ROOT`: producer package manifest, lock, and dependency-byte manifest.
- `PUBLICATION_PARSER_ROOT`: npm prefix containing `node_modules`.
- `PUBLICATION_PHP_WASM_MODULES`: PHP-WASM `node_modules` directory.
- `PUBLICATION_WP_CORE`: WordPress core root; must identify version 7.1.2.
- `PUBLICATION_RUNTIME_ROOT`: isolated dependency/core runtime destination.

The runner's `TMPDIR` is honored; otherwise the full script uses `RUNNER_TEMP` (or the platform temp directory locally). Runtime output is not written into the source tree. A local full run is `bash ci/ci-full-wordpress.sh` with Node 24.21.0, the npm CLI bundled with the selected Node installation, Python 3.14+, and PHP CLI available; the bootstrap installs the pinned runtime packages and downloads the official core archive.

The compiler manifest shape and `COMPILER_FILES` hash contract are unchanged. As expected when replacing historical toolchain metadata with project-owned locks, `package_builder.py`, the dependency-manifest digest, and package-lock digest change; consequently package IDs bind to the new pinned inputs. Repeated-build determinism and the real producer-to-WordPress boundary are exercised by the full synthetic suite.

These gates prove only the listed synthetic source, PHP-WASM/SQLite, and local session regressions. They do not prove production behavior, deployment safety, browser visuals, native Obsidian behavior, or human approval.
