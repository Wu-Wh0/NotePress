# Local live-session launcher

This slice starts a local-only writing preview from the plugin's current-note preview command. It uses the real authenticated IPv4 loopback listener and renders only the selected note's current editor text. No vault scan is performed, and images or labels are not approved automatically.

`bridgeLaunch` is a narrow, non-secret plugin-data setting. `command` and `args` are explicit executable arguments passed to `child_process.spawn` with `shell: false`; shell executables and inline command arguments are rejected. `env` accepts only `PUBLICATION_NODE`, `PUBLICATION_PARSER_ROOT`, and `TMPDIR`. Do not put passwords, tokens, or other secrets in this setting.

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

The Python session has no remote transport. Its site pin is the reserved `https://local-only.invalid` value used internally by the existing session core; it is **not** a WordPress site identity. `/v1/prepare`, `/v1/status`, and `/v1/commit` are denied. Plugin freeze, receipt-check, and recovery commands return `session_workflow_not_connected` in session mode. No publish/approval workflow is implemented here.

The focused Linux subprocess test exercises the native Linux launch path. The Windows-host → WSL path is exercised by `tests/windows_wsl_live_probe.cjs` with a real WSL Python listener, authenticated loopback HTTP, and asset-bundle rendering through host API/Blob/URL stubs. That proof alone does not establish native GUI or visual acceptance; the separately exercised isolated native scope is described below.


## Native Obsidian build and acceptance boundary

Raw `plugin/main.js` imports sibling modules and is not a native-install artifact. Obsidian 1.12.7 rejected the raw multi-file copy with `Cannot find module './live'`. Build the finite CommonJS closure with an explicit output directory:

```bash
node plugin/build.cjs /absolute/path/to/synthetic-vault/.obsidian/plugins/blog-entry-preview
```

The dependency-free builder emits deterministic `main.js` and `manifest.json`, prints source and bundle SHA-256 inventory, and refuses to overwrite the source directory. It does not copy runtime config, secrets or content. Add only the reviewed non-sensitive `data.json` launch config in an explicitly isolated test vault; never deploy this test artifact into the primary vault by default.

Writing preview embeds only byte-verified and URL-rewritten KaTeX CSS in the sandboxed `srcdoc`: native Obsidian did not apply the external blob stylesheet even though host-stub resource checks passed. Markup in CSS is rejected; fonts/images remain verified blob resources, scripts and external loading remain denied. The base style explicitly supplies readable dark/light colors, and disconnect clears/hides the preview and reports a non-connected state through a native Obsidian Notice.

The writing pane has only the sandboxed article frame: no persistent status paragraph, repeated pane header or not-yet-connected prepare button. Its tab label is simply `写作预览`; the article H1 is retained. Waiting, rendering, success, blocked and disconnected states reuse one native Notice, with short terminal-state expiry and unload cleanup, rather than stacking a new popup on every keystroke. Freeze commands remain fail-closed.

Synthetic native acceptance covers actual Obsidian plugin loading, registered live/disconnect commands, editor-change automatic updates, real WSL listener, actual KaTeX fonts/pixels and framework unload cleanup. It is not user visual approval, publication readiness, arbitrary third-party theme compatibility or primary-vault deployment. Current finite rendering policy still rejects language-labelled fences (use plain/text fences) and requires display-math `$$` delimiters on their own lines; do not weaken these gates merely to make a fixture pass.
