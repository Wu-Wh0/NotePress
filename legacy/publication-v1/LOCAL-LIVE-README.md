# Local live-session launcher

This slice starts a local-only writing preview from the plugin's current-note preview command. It uses the real authenticated IPv4 loopback listener and renders only the selected note's current editor text. No vault scan is performed, and images or labels are not approved automatically.

`bridgeLaunch` is a narrow, non-secret plugin-data setting. `command` and `args` are explicit executable arguments passed to `child_process.spawn` with `shell: false`; shell executables and inline command arguments are rejected. `env` accepts only `PUBLICATION_NODE`, `PUBLICATION_PARSER_ROOT`, and `TMPDIR`. Optional `mode` is `live` (the default) or the explicit synthetic-only `isolated-publication-test` seam described below. Do not put passwords, tokens, or other secrets in this setting.

The configuration below is the native Python-on-Linux example used by the subprocess test. On Windows, use an absolute `wsl.exe` path and an explicit `--distribution ... --exec ...` argument list. For that Windows-host WSL path, the plugin inserts `/usr/bin/env` after `--exec` and passes only the configured `PUBLICATION_NODE`, `PUBLICATION_PARSER_ROOT`, and `TMPDIR` values as separate argv tokens. This is deliberate: Windows process environment variables are not automatically available inside WSL without `WSLENV`; this launcher does not modify `WSLENV`, inherit the full host environment, or use a shell command string. Configure those three values as absolute Linux paths.

```json
{
  "expectedVault": "<exact current Obsidian vault path>",
  "bridgeLaunch": {
    "command": "<absolute Python or configured WSL executable>",
    "args": ["-u", "<absolute path to bridge/live_launcher.py>"],
    "env": {
      "PUBLICATION_NODE": "<absolute pinned Node v24.21.0 path>",
      "PUBLICATION_PARSER_ROOT": "<existing validated parser runtime>",
      "TMPDIR": "<private local temporary directory>"
    }
  }
}
```

For a Windows-host WSL setup, keep the `bridgeLaunch` fields explicit and the mapped vault root exact:

```json
{
  "expectedVault": "E:/Notes",
  "bridgeLaunch": {
    "command": "C:/Windows/System32/wsl.exe",
    "args": [
      "--distribution", "Ubuntu", "--exec", "/usr/bin/python3", "-u",
      "/home/Wh0-0/projects/blog/implementation/publication-v1/bridge/live_launcher.py"
    ],
    "env": {
      "PUBLICATION_NODE": "/home/Wh0-0/projects/blog/spikes/004-wordpress-roundtrip/runtime/node-v24.21.0-linux-x64/bin/node",
      "PUBLICATION_PARSER_ROOT": "/home/Wh0-0/projects/blog/spikes/013-parser-katex/runtime/parser",
      "TMPDIR": "/home/Wh0-0/projects/blog-ci-preparation/portable-evidence/linux-tmp"
    },
    "vaultMap": {
      "windowsVault": "E:/Notes",
      "wslVault": "/mnt/e/Notes"
    }
  }
}
```

Replace both vault roots with the exact synthetic or user-approved vault mapping and verify the WSL path exists. The plugin does not infer drive mounts. `TMPDIR` must be an existing absolute WSL directory outside the vault.

The bounded Windows-host acceptance probe is run with the existing host Node executable:

```sh
E:/Hermes/node/node.exe '//wsl.localhost/Ubuntu/home/Wh0-0/projects/blog/implementation/publication-v1/tests/windows_wsl_live_probe.cjs'
```

This probe uses the isolated ``E:/Wh0-0`Blog/publication-v1/windows-wsl-launch`` synthetic-vault namespace, an explicit `/mnt/e/...` mapping, a Chinese nested note path, and a space-containing WSL temp parent. It invokes the registered `current-note-live-preview` command, verifies the real authenticated loopback request and resource bundle, then checks disconnect/restart/unload port and process cleanup. It leaves only sanitized evidence JSON in the designated ``E:/Wh0-0`Blog/publication-v1`` workspace; the synthetic vault and WSL temp subtree are removed. The Obsidian API and browser `Blob`/`URL` are stubs, so this is not native Obsidian GUI or visual acceptance.

When a Windows vault is served through WSL, configure an explicit `vaultMap` on `bridgeLaunch` with exactly `windowsVault` (the expected Windows vault root) and `wslVault` (its WSL path). No path mapping is inferred. The plugin verifies `expectedVault` against the active Obsidian vault before launch and sends only the mapped vault root and selected relative note path to the child over stdin. The current note text stays in the plugin and is sent only to the authenticated live-render request.

The child returns one bounded private stdout handshake containing its ephemeral loopback origin and runtime bearer. The plugin reads it in memory only; it is never placed in a URL, cookie, persisted configuration, file, or log. On Windows-host WSL launches, the parent validates the `127.0.0.1` origin and waits for a successful host-side TCP connection before returning the session, so live rendering does not begin before WSL loopback forwarding is ready. The parent keeps stdin open after startup; EOF requests shutdown. Disconnect, plugin unload, and child exit clear the runtime session and preview; the launcher closes the listener and removes its temporary workspace.

The normal Python live launcher has no remote transport. Its site pin is the reserved `https://local-only.invalid` value used internally by the existing session core; it is **not** a WordPress site identity. Its `/v1/prepare`, `/v1/status`, and `/v1/commit` routes remain denied. The plugin freeze, receipt-check, and recovery commands also remain `session_workflow_not_connected` for sessions from this launcher. A separate explicitly injected publication-session test seam now consumes authenticated prepare/status/frozen-snapshot/resource routes, but this launcher does not create or advertise that marker and no human approval, commit, production credential, or publication action is wired into the live-only launcher.

The focused Linux subprocess test exercises the native Linux launch path. The Windows-host → WSL path is exercised by `tests/windows_wsl_live_probe.cjs` with a real WSL Python listener, authenticated loopback HTTP, and asset-bundle rendering through host API/Blob/URL stubs. That proof alone does not establish native GUI or visual acceptance; the separately exercised isolated native scope is described below.

## Explicit synthetic publication launcher (not a production adapter)

`tests/test_plugin_isolated_publication_launch.py` constructs a fresh synthetic Vault, compiler pin and non-secret runtime arguments, then starts `tests/fixtures/isolated-publication-launcher.py` through the plugin's real subprocess path. The opt-in `bridgeLaunch.mode` must be exactly `isolated-publication-test`. The private handshake must have exactly the normal `type`, `origin`, `authorization` fields plus `workflowConnected: true` and the fixed `sitePin: https://publication-v1.example.test`. Missing markers, another site, false connectivity, or extra workflow fields in ordinary live mode are rejected. Only this explicit mode has a bounded 180-second startup allowance; ordinary live startup remains 10 seconds. Existing cancellation, disconnect and unload logic remains shared.

The fixture owns one fresh, persistent WordPress/PHP-WASM/SQLite worker and authenticated bridge. It obtains ephemeral publisher/control credentials through private worker stdout only, never settings, arguments, environment or evidence. Synthetic source and private package storage must lie under the configured owned `TMPDIR`; selected paths use the existing live-launcher validation. Evidence paths must also be under owned scratch, must not be symlinks or point into the Vault, and invalid preflight arguments never get to choose a failure-output write destination. EOF shuts down the listener and worker and removes private packages/receipts. This is a disposable test fixture, not durable restart recovery or normal user/production credentials.

With the existing pinned runtime environment (`PUBLICATION_NODE`, `PUBLICATION_PARSER_ROOT`, `PUBLICATION_PHP_WASM_MODULES`, `PUBLICATION_WP_CORE`, `TMPDIR`) set explicitly, run:

```sh
python3 -B tests/test_plugin_isolated_publication_launch.py -v
```

The test uses Obsidian/Blob/URL host stubs but real plugin commands, child processes, HTTP and WordPress. It checks prepare, WordPress-frozen sandbox `srcdoc`, pending status, recovery of the same operation ID, authenticated resource reads, and absence of approve/commit requests. No-publication is checked against actual before/after WordPress post and publication-operation metadata counts, not an assumed zero. Worker and launcher exit codes plus closed bridge/WP ports are required. A process-group deadline cleans up only this test's children; the acceptance file is reset to `NOT_ACCEPTED` before each attempt. Final sanitized evidence is printed as `ISOLATED_PUBLICATION_LAUNCH_EVIDENCE`; optional `PUBLICATION_ISOLATED_EVIDENCE_DIR` controls the external report location, otherwise it uses owned temp storage rather than a machine-specific drive.

The parent focused run passed with WSL-native runtime/core/temp paths. The Windows-mounted runtime/temp combination timed out during frozen asset-bundle readback and is not accepted; the exact cause of that combination is not yet isolated. Windows-host WSL publication launch, native Obsidian presentation, close-during-fetch resource disposal, human reviewer handoff and explicit publisher commit/readback are separate remaining gates. Do not reinterpret the previous live-only Windows/native acceptance as acceptance of this publication mode.


## Session-only title and local PNG inputs

The command `设置当前写作预览标题与 PNG` opens a native modal for the connected selected note. The title is independent metadata: it does not rename the note or rewrite its source H1. A PNG path is relative to that note's directory (Chinese and nested paths are supported; spaces, traversal, hidden path components and other unsafe paths are rejected).

`检查 PNG 元数据` calls authenticated `POST /v1/asset-candidate` and returns only validated metadata. Checking is not approval: a separate `明确批准此 PNG` click binds that path to its SHA-256. Up to eight PNG approvals are held in this session only; each can be removed. PNG byte changes revoke approval and block stale previews. Changing notes, disconnecting or unloading clears these inputs. Title/approval changes hide the old preview and invalidate in-flight results. Settings are not written, and no body-reference image is automatically approved.

This local image confirmation is not article publication approval. Automated fixture clicks must be marked SIMULATED. It does not connect freeze, reviewer or WordPress publishing; native and human acceptance remain separate from portable tests.

Known non-blocking efficiency limitation: Coordinator cache reuse requires an expiry value that the authenticated live-session response does not provide. Actual sessions re-render; cache-specific tests use synthetic expiry-bearing outputs. This does not weaken input or asset binding and is not changed in this slice.

## Native Obsidian build and acceptance boundary

Raw `plugin/main.js` imports sibling modules and is not a native-install artifact. Obsidian 1.12.7 rejected the raw multi-file copy with `Cannot find module './live'`. Build the finite CommonJS closure with an explicit output directory:

```bash
node plugin/build.cjs /absolute/path/to/synthetic-vault/.obsidian/plugins/blog-entry-preview
```

The dependency-free builder emits deterministic `main.js` and `manifest.json`, prints source and bundle SHA-256 inventory, and refuses to overwrite the source directory. It does not copy runtime config, secrets or content. Add only the reviewed non-sensitive `data.json` launch config in an explicitly isolated test vault; never deploy this test artifact into the primary vault by default.

Writing preview embeds only byte-verified and URL-rewritten KaTeX CSS in the sandboxed `srcdoc`: native Obsidian did not apply the external blob stylesheet even though host-stub resource checks passed. Markup in CSS is rejected; fonts/images remain verified blob resources, scripts and external loading remain denied. The base style explicitly supplies readable dark/light colors, and disconnect clears/hides the preview and reports a non-connected state through a native Obsidian Notice.

The writing pane has only the sandboxed article frame: no persistent status paragraph, repeated pane header or not-yet-connected prepare button. Its tab label is simply `写作预览`; the article H1 is retained. Waiting, rendering, success, blocked and disconnected states reuse one native Notice, with short terminal-state expiry and unload cleanup, rather than stacking a new popup on every keystroke. Freeze/status/recovery commands remain fail-closed for ordinary live-only sessions; only an explicit injected publication session enables the isolated frozen-preview client path described in `FROZEN-SNAPSHOT-README.md`.

Synthetic native acceptance covers actual Obsidian plugin loading, registered live/disconnect commands, editor-change automatic updates, real WSL listener, actual KaTeX fonts/pixels and framework unload cleanup. It is not user visual approval, publication readiness, arbitrary third-party theme compatibility or primary-vault deployment. Current finite rendering policy still rejects language-labelled fences (use plain/text fences) and requires display-math `$$` delimiters on their own lines; do not weaken these gates merely to make a fixture pass.
