## What and why

<!-- What changes, and why this is the right slice. Keep it to a few lines. -->

## Scope boundary

- [ ] The change stays inside the product boundary documented in `README.md` (single author, desktop Obsidian, native WordPress REST only).
- [ ] No custom WordPress plugin, browser approval step, external runtime or always-on bridge is introduced as an author requirement.
- [ ] `legacy/publication-v1/` is untouched unless the change is explicitly about that historical tree.

## Verification

State which layers were actually run, and which were not. Do not merge a result from another layer into this one.

- [ ] Reproduced a real defect before fixing it (bug fixes only)
- [ ] `npm test`
- [ ] `npm run build`
- [ ] Layer not covered locally (name it): synthetic TLS / real WordPress HTTP / native Obsidian GUI / author click / hosted site / production theme

Paste the actual command output or evidence path. New behavior without a matching test is not complete.

## Risk and rollback

- [ ] Publication intent, journal contents, credential handling and readback rules are unchanged, or the change is described here.
- [ ] Failure, indeterminate write and blocked-publication paths stay blocked; nothing new retries, adopts or silently publishes.
- [ ] Rollback or revert is straightforward if this turns out wrong in acceptance.

## Privacy and secrets

- [ ] No credential, application password, cookie, nonce, vault path, database, real article or private runtime evidence is included.
- [ ] No `Authorization` header or password appears in a URL, log, receipt, fixture or test snapshot.