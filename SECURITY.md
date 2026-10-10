# Security policy

## Reporting

Report a vulnerability privately through **Security → Report a vulnerability** on this repository. Do not open a public issue for it.

Include the affected version, the steps to reproduce, and the impact. Replace any credential, application password, cookie, nonce, vault path or real site URL with a placeholder.

You can expect an acknowledgement within a few days and an assessment once the report is understood. Fixes land through a reviewed pull request; the affected version is noted in the release notes.

## Scope

This plugin holds only a secret *reference* in its settings, but it acts with a real WordPress account's permissions. Reports about these are in scope:

- credential, application password or `Authorization` header exposure in a URL, log, receipt, journal or fixture;
- publication-safety violations: silently publishing filtered or mismatching content, treating an indeterminate write as success, retrying or re-creating after an unknown outcome, overwriting a remote change without reading the baseline first;
- reading vault content the author did not select, including non-image note embeds and unrelated attachments;
- preview or rendering paths that execute scripts, load remote resources or write to the network without an explicit publish click;
- installing files outside `<vault>/.obsidian/plugins/wordpress-publisher/` or following a symlinked path.

Out of scope: the security of WordPress itself, the author's site configuration, a compromised author account, and the author's own vault permissions.

## Known limits, not vulnerabilities

Native REST has no transactional or compare-and-swap guarantee, so there is no idempotency for creates. Media can become publicly reachable before the article is published. Note identity follows the vault-relative path, so rename or move reconciliation is not implemented. These are documented in `README.md` and tracked in issues; they are not fixed silently.