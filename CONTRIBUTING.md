# Contributing

This repository is a single-author Obsidian desktop plugin. Contributions are reviewed by the repository owner; forks and external pull requests are not part of the current workflow.

## Ground rules

- The product boundary in `README.md` is authoritative: single author, desktop Obsidian, native WordPress HTTPS REST only. Do not introduce a custom WordPress plugin, a browser approval step, a compiler pin, or a CLI/SSH/always-on bridge as an author requirement.
- The current product is the Obsidian plugin documented in `README.md`; keep product, build and release changes within that scope.
- Never commit credentials, application passwords, cookies, nonces, vault absolute paths, databases, generated install files or private runtime evidence. Plugin settings store a secret reference only.
- Do not repeat an indeterminate publication to test it. Unknown create or media outcomes stay blocked until a human checks the exact remote state.

## Working locally

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
```

Install dependencies separately on each operating system. Tests need Git, OpenSSL and a Node.js version with `node:test`. `OPENSSL_BIN` and `WORDPRESS_TEST_SCRATCH` can select the OpenSSL binary and transport fixture storage.

`npm run build` is intentionally strict: `package.json`, `package-lock.json`, `manifest.json`, `versions.json` and the pinned dependency versions must agree, and `build.mjs` carries the expected version constants. A version bump touches all of them.

Dependabot opens monthly pull requests for npm and GitHub Actions, but a dependency bump is not a version bump: update the matching constants in the `EXPECTED` block of `build.mjs` in the same pull request, otherwise the build fails by design.

## Pull requests

1. Branch from `main`; keep one slice per branch.
2. Reproduce a real defect before fixing it, then add a test that fails without the fix.
3. Fill in `.github/PULL_REQUEST_TEMPLATE.md`. Name the verification layer you actually ran and the layers you did not.
4. Open a draft pull request for anything still awaiting native Obsidian, real WordPress HTTP, hosted or author acceptance.
5. `package (ubuntu-24.04)` and `package (windows-2022)` must pass; `main` requires them and accepts no force push.

## Verification layers

Local checks, synthetic TLS, real WordPress HTTP, the native Obsidian host, an author click, a hosted site and the production theme are separate layers. Report them separately; never present one as evidence for another.

## Commits and releases

Conventional-ish prefixes are used in history (`feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:`). Release tags use bare numeric semantic versions such as `0.2.0` (no `v` prefix). Keep `build.mjs`, `package.json`, both `package-lock.json` version fields, `manifest.json` and `versions.json` synchronized. The workflow prepares a new GitHub Draft only; it never publishes or updates an existing release. It uploads and verifies five assets: `main.js`, `manifest.json`, `styles.css`, `wordpress-publisher.zip` and `SHA256SUMS.txt`. A maintainer must review and manually publish the Draft as a separate approval step.