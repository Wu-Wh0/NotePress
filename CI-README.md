# Private publication pipeline

Only explicitly selected publication-v1 product and synthetic test sources are tracked. The surrounding WSL workspace, historical experiments, user content, credentials, databases and evidence are not uploaded.

GitHub Actions fast gates: server source-boundary unittest tests, Node plugin tests, and mandatory PHP CLI syntax checks. No Python third-party test runner or production secrets required.

Full producer / WordPress / SQLite / session integration CI is NOT portable yet: historical parser locks, pinned Node paths, PHP-WASM cache and WordPress core setup need a separate reviewed portability change. Fast checks do not prove real WordPress integration, native Obsidian, browser visuals or human approval.

Workflow is manually dispatchable and runs for pull requests. No deployment. Official actions are pinned to full commit SHAs, contents permission is read-only and checkout credentials are not persisted.
