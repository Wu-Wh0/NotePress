"""Focused subprocess test for the plugin-owned local live-session lifecycle."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
from runtime_paths import node_binary, parser_root

NODE = node_binary()
PARSER = parser_root()
PLUGIN = ROOT / "plugin" / "main.js"
LAUNCHER = ROOT / "bridge" / "live_launcher.py"
SELECTED = "notes/selected.md"
SAVED = "# Saved disk version\n"
UNSAVED = "# Current unsaved version\n"


NODE_DRIVER = r'''const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return {
    Plugin: class Plugin {}, Notice: class Notice {}, ItemView: class ItemView {},
  };
  return originalLoad.call(this, request, parent, isMain);
};
const originalRequest = http.request;
let trackPluginRequests = true;
const pluginRequests = [];
let plugin;
http.request = function (input, options, callback) {
  const url = new URL(input);
  const settings = options || {};
  const record = {
    method: settings.method || 'GET',
    path: url.pathname,
    origin: settings.headers?.Origin,
    authorized: settings.headers?.Authorization === plugin?.publicationSession?.authorization,
    body: '',
  };
  const request = originalRequest.call(http, input, options, callback);
  const chunks = [];
  const write = request.write;
  request.write = function (chunk, ...args) {
    if (trackPluginRequests && chunk !== undefined) chunks.push(Buffer.from(chunk));
    return write.call(this, chunk, ...args);
  };
  request.once('finish', () => {
    if (!trackPluginRequests) return;
    record.body = Buffer.concat(chunks).toString('utf8');
    pluginRequests.push(record);
  });
  return request;
};

function browserWindow() {
  const issued = [], revoked = [];
  const url = {
    createObjectURL() { const value = `blob:local/${issued.length + 1}`; issued.push(value); return value; },
    revokeObjectURL(value) { revoked.push(value); },
  };
  class BrowserBlob { constructor(parts, options) { this.parts = parts; this.type = options?.type || ''; } }
  const frame = {
    hidden: true, src: '', srcdoc: '',
    ownerDocument: { defaultView: { URL: url, Blob: BrowserBlob } },
    removeAttribute(name) { if (name === 'src') this.src = ''; if (name === 'srcdoc') this.srcdoc = ''; },
    setAttribute() {}, addEventListener() {},
  };
  const previews = new Set();
  const view = {
    frame, status: { textContent: '' }, events: [],
    update(event) {
      this.events.push(event);
      if (event.state === 'synced' && typeof event.out?.srcdoc === 'string') {
        frame.hidden = false; frame.srcdoc = event.out.srcdoc; previews.add(event.out);
      }
    },
    clearSessionPreview() {
      frame.removeAttribute('srcdoc'); frame.removeAttribute('src'); frame.hidden = true;
      for (const preview of previews) preview.dispose?.();
      previews.clear();
    },
  };
  return { issued, revoked, view };
}

function waitPortClosed(origin) {
  const url = new URL(origin);
  return new Promise(resolve => {
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => resolve(error.code === 'ECONNREFUSED'));
  });
}

function probe(origin, authorization, method, route, body) {
  trackPluginRequests = false;
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Origin: 'app://obsidian.md', Authorization: authorization };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const request = originalRequest(new URL(route, origin), { method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject);
    if (payload) request.write(payload);
    request.end();
  }).finally(() => { trackPluginRequests = true; });
}

(async () => {
  const [pluginPath, launcherPath, python, vaultPath, selected, unsaved, parserRoot, nodePath, scratch] = process.argv.slice(1);
  const EntryPreview = require(pluginPath);
  const file = { extension: 'md', path: selected };
  let editorText = unsaved;
  const browser = browserWindow();
  let writingLeaf;
  const commands = new Map();
  const app = {
    vault: {
      adapter: { getBasePath: () => vaultPath },
      read: async () => { throw Error('disk_read_forbidden'); },
      getMarkdownFiles() { throw Error('vault_enumeration_forbidden'); },
      on() { return {}; },
    },
    workspace: {
      getActiveFile: () => file,
      getLeavesOfType(type) {
        if (type === 'markdown') return [{ view: { file, getMode: () => 'source', editor: { getValue: () => editorText } } }];
        if (type === 'blog-entry-writing-preview') return writingLeaf ? [writingLeaf] : [];
        return [];
      },
      getLeaf() {
        writingLeaf = { view: browser.view, setViewState: async () => {} };
        return writingLeaf;
      },
      on() { return {}; }, detachLeavesOfType() {},
    },
  };
  plugin = new EntryPreview();
  const config = {
    expectedVault: vaultPath,
    bridgeLaunch: {
      command: python,
      args: ['-u', launcherPath],
      env: { PUBLICATION_NODE: nodePath, PUBLICATION_PARSER_ROOT: path.join(scratch, 'missing-parser'), TMPDIR: scratch },
    },
  };
  Object.assign(plugin, {
    app, config, loadData: async () => config,
    registerView() {}, addRibbonIcon() {}, registerEvent() {},
    addCommand(command) { commands.set(command.id, command); },
  });
  await plugin.onload();
  const startCommand = commands.get('current-note-live-preview');
  const disconnectCommand = commands.get('disconnect-local-live-session');
  assert.ok(startCommand && disconnectCommand);

  const failedStart = await startCommand.callback();
  const failureClean = failedStart.ok === false
    && failedStart.code === 'local_session_start_failed'
    && plugin.sessionChild === null
    && plugin.publicationSessionMode === true
    && plugin.publicationSession === null;
  config.bridgeLaunch.env.PUBLICATION_PARSER_ROOT = parserRoot;

  // A disconnect during the first awaited startup step must invalidate it.
  const interruptedStart = startCommand.callback();
  await disconnectCommand.callback();
  const interruptedResult = await interruptedStart;
  if (interruptedResult.ok) await disconnectCommand.callback();
  assert.equal(interruptedResult.ok, false, 'disconnect must cancel an in-flight startup');
  assert.equal(plugin.sessionChild, null);
  assert.equal(plugin.publicationSession, null);

  const unloadedStart = startCommand.callback();
  await plugin.onunload();
  const unloadedResult = await unloadedStart;
  assert.equal(unloadedResult.ok, false, 'unload must cancel an in-flight startup');
  assert.equal(plugin.sessionChild, null);
  await plugin.onload();

  const replacedStart = startCommand.callback();
  const replacementStart = startCommand.callback();
  const [replaced, replacement] = await Promise.all([replacedStart, replacementStart]);
  assert.equal(replaced.ok, false, 'new startup must invalidate older startup');
  assert.equal(replacement.ok, true);
  assert.ok(plugin.publicationSession);
  await disconnectCommand.callback();

  // Cancel after the real subprocess exists but before consuming its handshake.
  const handshakingStart = startCommand.callback();
  const deadline = Date.now() + 3000;
  while (!plugin.sessionChild && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  const pendingChild = plugin.sessionChild;
  assert.ok(pendingChild, 'startup should reach the child handoff');
  await disconnectCommand.callback();
  const handshakingResult = await handshakingStart;
  assert.equal(handshakingResult.ok, false, 'late handshake must not resurrect disconnected session');
  assert.notEqual(pendingChild.exitCode, null);
  assert.equal(plugin.publicationSession, null);
  assert.equal(plugin.sessionChild, null);

  const started = await startCommand.callback();
  assert.equal(started.ok, true, 'configured child launcher should complete private handshake');
  assert.ok(plugin.publicationSession);
  const firstChild = plugin.sessionChild;
  const firstOrigin = plugin.publicationSession.origin;
  const firstAuthorization = plugin.publicationSession.authorization;
  const firstSessionDirs = fs.readdirSync(scratch).filter(name => name.startsWith('publication-local-session-'));
  assert.equal(firstSessionDirs.length, 1);
  const receiptDir = path.join(scratch, firstSessionDirs[0], 'receipts');
  const receiptFiles = fs.existsSync(receiptDir) ? fs.readdirSync(receiptDir).filter(name => name.endsWith('.json')) : ['missing-receipt-dir'];

  await plugin.live.run();
  assert.equal(plugin.liveLast.state, 'synced');
  const preview = plugin.liveLast.out;
  assert.ok(preview.srcdoc.includes('Current unsaved version'));
  assert.ok(!preview.srcdoc.includes('Saved disk version'));
  const liveRequest = pluginRequests.find(item => item.method === 'POST' && item.path === '/v1/live');
  const liveBody = JSON.parse(liveRequest.body);
  const requestsBeforeWorkflow = pluginRequests.length;
  const blockedWorkflow = [await plugin.generate(), await plugin.checkReceipt(), await plugin.recoverFinalPreview()];
  const blockedNoRequest = pluginRequests.length === requestsBeforeWorkflow;
  const prepare = await probe(firstOrigin, firstAuthorization, 'POST', '/v1/prepare', { title: 'blocked', approved_assets: {} });
  const status = await probe(firstOrigin, firstAuthorization, 'GET', `/v1/status/${'0'.repeat(32)}`);
  const commit = await probe(firstOrigin, firstAuthorization, 'POST', `/v1/commit/${'0'.repeat(32)}`, { digest: '0'.repeat(64) });
  const firstExit = await disconnectCommand.callback();
  const disconnectExitCode = firstChild.exitCode;
  const portClosedAfterDisconnect = await waitPortClosed(firstOrigin);
  const clearedAfterDisconnect = plugin.publicationSession === null && plugin.sessionChild === null
    && plugin.live === null && browser.view.frame.srcdoc === '';

  const restarted = await startCommand.callback();
  assert.equal(restarted.ok, true);
  const secondChild = plugin.sessionChild;
  const secondClose = plugin.sessionChildClose;
  const secondOrigin = plugin.publicationSession.origin;
  await plugin.live.run();
  secondChild.stdin.end();
  await secondClose;
  const portClosedAfterChildExit = await waitPortClosed(secondOrigin);
  const clearedAfterChildExit = plugin.publicationSession === null && plugin.sessionChild === null
    && plugin.live === null && browser.view.frame.srcdoc === '';

  const restartedForUnload = await startCommand.callback();
  assert.equal(restartedForUnload.ok, true);
  const thirdChild = plugin.sessionChild;
  const thirdOrigin = plugin.publicationSession.origin;
  await plugin.onunload();
  const unloadExitCode = thirdChild.exitCode;
  const portClosedAfterUnload = await waitPortClosed(thirdOrigin);

  process.stdout.write(JSON.stringify({
    failureClean,
    failedStartCode: failedStart.code,
    started: started.ok,
    selected: pluginPath && liveBody.path,
    sourceSha256: liveBody.source_sha256,
    unsavedTextPosted: liveBody.text === unsaved,
    previewContainsUnsaved: preview.srcdoc.includes('Current unsaved version'),
    previewExcludesSaved: !preview.srcdoc.includes('Saved disk version'),
    resourcesFetched: pluginRequests.some(item => item.method === 'GET' && item.path.startsWith('/v1/assets/')),
    requestsAuthorized: pluginRequests.every(item => item.authorized && item.origin === 'app://obsidian.md'),
    noRequestsForBlockedWorkflow: blockedNoRequest,
    pluginRequestPaths: pluginRequests.map(item => item.path),
    blockedWorkflowCodes: blockedWorkflow.map(result => result.code),
    prepareDenied: prepare.status >= 400,
    statusDenied: status.status >= 400,
    commitDenied: commit.status >= 400,
    noReceipts: receiptFiles.length === 0,
    disconnectOk: firstExit.ok,
    disconnectExitCode,
    portClosedAfterDisconnect,
    clearedAfterDisconnect,
    childExitCode: secondChild.exitCode,
    portClosedAfterChildExit,
    clearedAfterChildExit,
    unloadExitCode,
    portClosedAfterUnload,
    allPreviewUrlsRevoked: browser.issued.every(value => browser.revoked.includes(value)),
    runtimeModeRetainedAfterUnload: plugin.publicationSessionMode === true,
  }));
})().catch(error => { process.stderr.write(`${error.name}: ${error.message}`); process.exitCode = 3; });
'''


class PluginLocalSessionLaunchTests(unittest.TestCase):
    def test_plugin_command_spawns_authenticated_live_launcher_and_cleans_up(self):
        scratch = Path(os.environ["TMPDIR"])
        before_sessions = set(scratch.glob("publication-local-session-*"))
        before_live = set(scratch.glob("publication-live-*"))
        with tempfile.TemporaryDirectory(prefix="plugin-session-launch-", dir=scratch) as temporary:
            root = Path(temporary)
            vault = root / "vault"
            note = vault / SELECTED
            note.parent.mkdir(parents=True)
            note.write_text(SAVED, encoding="utf-8")
            process_env = os.environ.copy()
            process_env["PUBLICATION_NODE"] = str(NODE)
            process_env["PUBLICATION_PARSER_ROOT"] = str(PARSER)
            command = [
                str(NODE), "-e", NODE_DRIVER, str(PLUGIN), str(LAUNCHER), sys.executable,
                str(vault), SELECTED, UNSAVED, str(PARSER), str(NODE), str(scratch),
            ]
            process = subprocess.run(
                command, capture_output=True, text=True, timeout=120, check=False, env=process_env,
            )
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertEqual(process.stderr, "")
            self.assertNotIn("Bearer ", process.stdout + process.stderr)
            result = json.loads(process.stdout)
            self.assertTrue(result["failureClean"], result)
            self.assertEqual(result["failedStartCode"], "local_session_start_failed")
            self.assertTrue(result["started"], result)
            self.assertEqual(result["selected"], SELECTED)
            self.assertEqual(result["sourceSha256"], hashlib.sha256(UNSAVED.encode()).hexdigest())
            self.assertTrue(result["unsavedTextPosted"])
            self.assertTrue(result["previewContainsUnsaved"])
            self.assertTrue(result["previewExcludesSaved"])
            self.assertTrue(result["resourcesFetched"])
            self.assertTrue(result["requestsAuthorized"])
            self.assertEqual(result["pluginRequestPaths"][0], "/v1/live")
            self.assertTrue(any(path.startswith("/v1/assets/") for path in result["pluginRequestPaths"]))
            self.assertFalse(any(path in ("/generate", "/live", "/receipt", "/recover-final-preview", "/v1/prepare", "/v1/commit") or path.startswith("/v1/status/") for path in result["pluginRequestPaths"]))
            self.assertEqual(result["blockedWorkflowCodes"], ["session_workflow_not_connected"] * 3)
            self.assertTrue(result["noRequestsForBlockedWorkflow"])
            self.assertTrue(result["prepareDenied"])
            self.assertTrue(result["statusDenied"])
            self.assertTrue(result["commitDenied"])
            self.assertTrue(result["noReceipts"])
            self.assertTrue(result["disconnectOk"])
            self.assertEqual(result["disconnectExitCode"], 0)
            self.assertTrue(result["portClosedAfterDisconnect"])
            self.assertTrue(result["clearedAfterDisconnect"])
            self.assertEqual(result["childExitCode"], 0)
            self.assertTrue(result["portClosedAfterChildExit"])
            self.assertTrue(result["clearedAfterChildExit"])
            self.assertEqual(result["unloadExitCode"], 0)
            self.assertTrue(result["portClosedAfterUnload"])
            self.assertTrue(result["allPreviewUrlsRevoked"])
            self.assertTrue(result["runtimeModeRetainedAfterUnload"])
            self.assertEqual(note.read_text(encoding="utf-8"), SAVED)
        self.assertEqual(set(scratch.glob("publication-local-session-*")), before_sessions)
        self.assertEqual(set(scratch.glob("publication-live-*")), before_live)


if __name__ == "__main__":
    unittest.main()
