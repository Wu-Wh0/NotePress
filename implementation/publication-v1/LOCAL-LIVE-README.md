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

The focused Linux subprocess test exercises the native Linux launch path. The Windows-host → WSL path is exercised by `tests/windows_wsl_live_probe.cjs` with a real WSL Python listener, authenticated loopback HTTP, and asset-bundle rendering through host API/Blob/URL stubs. Native Obsidian GUI and visual acceptance remain unverified.
