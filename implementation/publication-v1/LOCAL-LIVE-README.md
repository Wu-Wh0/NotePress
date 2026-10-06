# Local live-session launcher

This slice starts a local-only writing preview from the plugin's current-note preview command. It uses the real authenticated IPv4 loopback listener and renders only the selected note's current editor text. No vault scan is performed, and images or labels are not approved automatically.

`bridgeLaunch` is a narrow, non-secret plugin-data setting. `command` and `args` are explicit executable arguments passed to `child_process.spawn` with `shell: false`; shell executables and inline command arguments are rejected. `env` accepts only `PUBLICATION_NODE`, `PUBLICATION_PARSER_ROOT`, and `TMPDIR`. Do not put passwords, tokens, or other secrets in this setting.

The configuration below is a native Python-on-Linux example, matching the subprocess test. A Windows-to-WSL launch needs an explicit `wsl.exe --distribution ... --exec <python> <launcher>` argument list and runtime environment propagation; that host path has **not** been exercised by this test and is not claimed ready. No shell command string is supported.

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

When a Windows vault is served through WSL, configure an explicit `vaultMap` on `bridgeLaunch` with exactly `windowsVault` (the expected Windows vault root) and `wslVault` (its WSL path). No path mapping is inferred. The plugin verifies `expectedVault` against the active Obsidian vault before launch and sends only the mapped vault root and selected relative note path to the child over stdin. The current note text stays in the plugin and is sent only to the authenticated live-render request.

The child returns one bounded private stdout handshake containing its ephemeral loopback origin and runtime bearer. The plugin reads it in memory only; it is never placed in a URL, cookie, persisted configuration, file, or log. The parent keeps stdin open after startup; EOF requests shutdown. Disconnect, plugin unload, and child exit clear the runtime session and preview; the launcher closes the listener and removes its temporary workspace.

The Python session has no remote transport. Its site pin is the reserved `https://local-only.invalid` value used internally by the existing session core; it is **not** a WordPress site identity. `/v1/prepare`, `/v1/status`, and `/v1/commit` are denied. Plugin freeze, receipt-check, and recovery commands return `session_workflow_not_connected` in session mode. No publish/approval workflow is implemented here.

The focused subprocess test exercises a stubbed Obsidian host under Node and the actual Python launcher/listener on Linux. Native Obsidian/Windows/WSL GUI acceptance remains unverified.
