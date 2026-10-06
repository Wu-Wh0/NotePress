'use strict';

// Manual Windows-host acceptance probe. It uses a host stub, not Obsidian GUI.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const Module = require('node:module');
const childProcess = require('node:child_process');

const WSL_EXE = 'C:\\Windows\\System32\\wsl.exe';
const DISTRO = 'Ubuntu';
const PYTHON = '/usr/bin/python3';
const LAUNCHER = '/home/Wh0-0/projects/blog/implementation/publication-v1/bridge/live_launcher.py';
const RENDER_NODE = '/home/Wh0-0/projects/blog/spikes/004-wordpress-roundtrip/runtime/node-v24.21.0-linux-x64/bin/node';
const PARSER_ROOT = '/home/Wh0-0/projects/blog/spikes/013-parser-katex/runtime/parser';
const LINUX_TMP_BASE = '/home/Wh0-0/projects/blog-ci-preparation/portable-evidence/linux-tmp';
const WINDOWS_FIXTURE_BASE = 'E:/Wh0-0`Blog/publication-v1/windows-wsl-launch';
const EVIDENCE_BASE = 'E:/Wh0-0`Blog/publication-v1';
const SELECTED = '笔记 空间/嵌套目录/第一篇.md';
const SAVED_TEXT = '# Synthetic disk version; must not render\n';
const UNSAVED_TEXT = '# 当前编辑器中的未保存正文\n\n路径含有中文和空格。\n';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function check(condition, code) {
  if (!condition) fail(code);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function decodeWslWindowsText(buffer) {
  if (!buffer) return '';
  let zeroes = 0;
  for (const byte of buffer) if (byte === 0) zeroes++;
  return (zeroes > buffer.length / 8 ? buffer.toString('utf16le') : buffer.toString('utf8')).replaceAll('\0', '');
}

function windowsHostEnv() {
  const env = {};
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR;
  const windir = process.env.WINDIR || systemRoot;
  if (systemRoot) env.SystemRoot = systemRoot;
  if (windir) env.WINDIR = windir;
  return env;
}

function runWsl(args, timeout = 30000) {
  const result = childProcess.spawnSync(WSL_EXE, ['--distribution', DISTRO, '--exec', ...args], {
    encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1024 * 1024, env: windowsHostEnv(),
  });
  if (result.error || result.status !== 0) fail('wsl_probe_command_failed');
  return result.stdout;
}

function runWslPython(code, args = [], timeout = 30000) {
  const text = runWsl([PYTHON, '-c', code, ...args], timeout).trim();
  try { return JSON.parse(text); } catch { fail('wsl_probe_json_invalid'); }
}

const INSPECT_RUNTIME = String.raw`
import json, pathlib, sys
launcher = sys.argv[1]
tmp = pathlib.Path(sys.argv[2])
pids = []
for item in pathlib.Path('/proc').iterdir():
    if not item.name.isdigit():
        continue
    try:
        argv = item.joinpath('cmdline').read_bytes().split(b'\0')
    except OSError:
        continue
    if len(argv) >= 3 and argv[1] == b'-u' and argv[2].decode('utf-8', 'replace') == launcher:
        pids.append(int(item.name))
workspaces = sorted(p.name for p in tmp.iterdir() if p.name.startswith('publication-local-session-')) if tmp.is_dir() else []
receipts = 0
for name in workspaces:
    receipt_dir = tmp / name / 'receipts'
    if receipt_dir.is_dir() and not receipt_dir.is_symlink():
        receipts += sum(1 for entry in receipt_dir.glob('*.json') if entry.is_file() and not entry.is_symlink())
print(json.dumps({'pids': sorted(pids), 'workspaces': workspaces, 'receipt_count': receipts}))
`;

const VERIFY_MAPPED_VAULT = String.raw`
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
note = root.joinpath(*sys.argv[2].split('/'))
expected = sys.argv[3]
print(json.dumps({'root_absolute': root.is_absolute(), 'root_exists': root.is_dir() and not root.is_symlink(), 'note_exists': note.is_file() and not note.is_symlink(), 'saved_hash_matches': note.is_file() and hashlib.sha256(note.read_bytes()).hexdigest() == expected}))
`;

const CREATE_TMP_PARENT = String.raw`
import json, pathlib, sys
base, target = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
if base.is_symlink() or not base.is_dir() or target.parent != base or target.exists():
    raise SystemExit(4)
target.mkdir()
print(json.dumps({'created': target.is_dir() and not target.is_symlink()}))
`;

const CLEANUP_TMP_PARENT = String.raw`
import json, pathlib, shutil, sys
base, target = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
if target.parent != base or not target.name.startswith('windows WSL live probe '):
    raise SystemExit(5)
if target.exists():
    if target.is_symlink():
        target.unlink()
    else:
        shutil.rmtree(target)
print(json.dumps({'removed': not target.exists()}))
`;

const TERMINATE_OWNED = String.raw`
import json, os, pathlib, signal, sys, time
launcher = sys.argv[1]
pids = [int(value) for value in sys.argv[2:] if value.isdigit()]
def is_target(pid):
    try:
        argv = pathlib.Path('/proc', str(pid), 'cmdline').read_bytes().split(b'\0')
        return len(argv) >= 3 and argv[1] == b'-u' and argv[2].decode('utf-8', 'replace') == launcher
    except OSError:
        return False
for pid in pids:
    if is_target(pid):
        try: os.kill(pid, signal.SIGTERM)
        except ProcessLookupError: pass
for _ in range(30):
    if not any(is_target(pid) for pid in pids):
        break
    time.sleep(0.1)
for pid in pids:
    if is_target(pid):
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
print(json.dumps({'remaining_owned_pids': [pid for pid in pids if is_target(pid)]}))
`;

function inspectRuntime(tmpParent) {
  return runWslPython(INSPECT_RUNTIME, [LAUNCHER, tmpParent]);
}

async function connectState(origin) {
  const url = new URL(origin);
  return new Promise(resolve => {
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
    socket.once('connect', () => done('connected'));
    socket.once('error', error => done(error.code || 'socket_error'));
    socket.setTimeout(1500, () => done('timeout'));
  });
}

async function waitForPortClosed(origin, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await connectState(origin) === 'ECONNREFUSED') return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

async function waitForSynced(plugin, minimumCount, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (plugin.liveLast?.state === 'error') {
      const code = String(plugin.liveLast?.code || 'unknown');
      const record = plugin.localProbeHttpRecords?.at(-1);
      const transport = String(record?.transportError || 'none').toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const route = record?.path === '/v1/live' ? 'live' : record?.path?.startsWith('/v1/assets/') ? 'assets' : 'other';
      let port = 'unknown';
      try { if (plugin.publicationSession?.origin) port = await connectState(plugin.publicationSession.origin); } catch {}
      const portState = String(port).toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const childState = plugin.sessionChild?.exitCode === null ? 'child_open' : 'child_closed';
      fail([code, transport, route, portState, childState].every(value => /^[a-z0-9_]{1,80}$/.test(value))
        ? `live_render_failed_${code}_${transport}_${route}_${portState}_${childState}` : 'live_render_failed');
    }
    const synced = plugin.liveLast?.state === 'synced' && typeof plugin.liveLast?.out?.srcdoc === 'string';
    const count = plugin.localProbeEvents.filter(event => event.state === 'synced').length;
    if (synced && count >= minimumCount) return plugin.liveLast.out;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  fail('live_render_timeout');
}

function snapshotAddedPid(before, after) {
  const added = after.pids.filter(pid => !before.pids.includes(pid));
  check(added.length === 1, 'expected_one_owned_linux_launcher');
  return added[0];
}

function trackPluginHttp(plugin) {
  const original = http.request;
  const records = [];
  plugin.localProbeHttpRecords = records;
  http.request = function (input, options, callback) {
    const settings = options || {};
    let url;
    try { url = new URL(input); } catch { fail('plugin_http_url_invalid'); }
    const record = {
      method: settings.method || 'GET',
      path: url.pathname,
      originHeader: settings.headers?.Origin || '',
      authorized: typeof plugin.publicationSession?.authorization === 'string'
        && settings.headers?.Authorization === plugin.publicationSession.authorization,
      body: '',
      transportError: null,
    };
    const request = original.call(this, input, options, callback);
    const chunks = [];
    const write = request.write;
    let recorded = false;
    const recordOnce = () => { if (!recorded) { recorded = true; records.push(record); } };
    request.write = function (chunk, ...args) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk));
      return write.call(this, chunk, ...args);
    };
    request.once('finish', () => {
      record.body = Buffer.concat(chunks).toString('utf8');
      recordOnce();
    });
    request.once('error', error => {
      const code = String(error?.code || 'unknown');
      record.transportError = /^[A-Za-z0-9_]{1,80}$/.test(code) ? code : 'unknown';
      recordOnce();
    });
    return request;
  };
  return { records, restore: () => { http.request = original; } };
}

function makeBrowserView(events) {
  const issued = [];
  const revoked = [];
  const browserURL = {
    createObjectURL(blob) {
      const value = `blob:host-stub/${issued.length + 1}`;
      issued.push({ value, type: blob.type });
      return value;
    },
    revokeObjectURL(value) { revoked.push(value); },
  };
  class BrowserBlob {
    constructor(parts, options = {}) { this.parts = parts; this.type = options.type || ''; }
  }
  const frame = {
    hidden: true, src: '', srcdoc: '',
    ownerDocument: { defaultView: { URL: browserURL, Blob: BrowserBlob } },
    setAttribute() {},
    removeAttribute(name) { if (name === 'src') this.src = ''; if (name === 'srcdoc') this.srcdoc = ''; },
    addEventListener(_name, callback, options) { if (options?.once) queueMicrotask(callback); },
    style: {},
  };
  const previews = new Set();
  const view = {
    frame,
    update(event) {
      events.push(event);
      if (event.state === 'synced' && typeof event.out?.srcdoc === 'string') {
        frame.hidden = false;
        frame.srcdoc = event.out.srcdoc;
        previews.add(event.out);
      }
    },
    clearSessionPreview() {
      frame.removeAttribute('srcdoc');
      frame.removeAttribute('src');
      frame.hidden = true;
      for (const preview of previews) preview.dispose?.();
      previews.clear();
    },
  };
  return { issued, revoked, frame, view };
}

function hostWslMetadata() {
  const help = childProcess.spawnSync(WSL_EXE, ['--help'], { encoding: null, windowsHide: true, timeout: 15000, env: windowsHostEnv() });
  const helpText = decodeWslWindowsText(help.stdout);
  check(helpText.includes('--distribution') && helpText.includes('--exec'), 'wsl_help_missing_required_flags');
  const version = childProcess.spawnSync(WSL_EXE, ['--version'], { encoding: null, windowsHide: true, timeout: 15000, env: windowsHostEnv() });
  const versionText = decodeWslWindowsText(version.stdout);
  const match = versionText.match(/^WSL(?:\s+[^:：]+)?[:：]\s*([0-9][0-9.]*)\s*$/im);
  check(match, 'wsl_version_unavailable');
  return match[1];
}

(async () => {
  let stage = 'host_preflight';
  let failureCode = null;
  let plugin = null;
  let commands = null;
  let probeHttp = null;
  let fixturePath = null;
  let notePath = null;
  let fixtureCreated = false;
  let fixtureBaseCreated = false;
  let privateTmp = null;
  let privateTmpCreated = false;
  let linuxTmpParentCleaned = false;
  let baselinePids = [];
  let ownedPids = [];
  let wslVersion = null;
  let runtimePython = null;
  let runtimeNode = null;
  let firstPid = null;
  let secondPid = null;
  let firstWorkspace = null;
  let secondWorkspace = null;
  let firstPortClosed = false;
  let secondPortClosed = false;
  let firstHostLoopbackReady = false;
  let secondHostLoopbackReady = false;
  let firstProcessGone = false;
  let secondProcessGone = false;
  let firstWorkspaceRemoved = false;
  let secondWorkspaceRemoved = false;
  let pluginSpawn = null;
  let cleanupOk = true;
  let savedFileUnchanged = false;
  let sourceSha256 = null;
  let renderSummary = null;
  let blockedWorkflowCodes = [];
  let pluginRequestSummary = null;
  let startedOnce = false;
  let restarted = false;
  let unloaded = false;
  let allPreviewUrlsRevoked = false;
  let syntheticWindowsVault = null;
  let syntheticWslVault = null;
  let evidencePath = null;
  let hostNode = process.version;

  try {
    check(process.platform === 'win32', 'must_run_on_windows_host');
    check(/^v22\./.test(process.version), 'expected_existing_windows_node_22');
    check(fs.statSync(WSL_EXE).isFile(), 'configured_wsl_exe_missing');
    wslVersion = hostWslMetadata();

    stage = 'synthetic_vault_setup';
    const fixtureName = `probe-${process.pid}-${Date.now()}`;
    const baseNative = path.win32.resolve(WINDOWS_FIXTURE_BASE);
    const basePrefix = 'e:\\wh0-0`blog\\publication-v1\\windows-wsl-launch';
    check(baseNative.toLowerCase() === basePrefix, 'synthetic_vault_base_mismatch');
    if (!fs.existsSync(baseNative)) { fs.mkdirSync(baseNative, { recursive: true }); fixtureBaseCreated = true; }
    check(fs.lstatSync(baseNative).isDirectory() && !fs.lstatSync(baseNative).isSymbolicLink(), 'synthetic_vault_base_not_directory');
    fixturePath = path.win32.join(baseNative, fixtureName);
    check(!fs.existsSync(fixturePath), 'synthetic_fixture_collision');
    fs.mkdirSync(fixturePath, { recursive: false });
    fixtureCreated = true;
    syntheticWindowsVault = fixturePath.replaceAll('\\', '/');
    const drive = syntheticWindowsVault.match(/^([A-Za-z]):\/(.*)$/);
    check(drive && drive[1].toLowerCase() === 'e', 'synthetic_vault_drive_mismatch');
    syntheticWslVault = `/mnt/${drive[1].toLowerCase()}/${drive[2]}`;
    notePath = path.win32.join(fixturePath, ...SELECTED.split('/'));
    fs.mkdirSync(path.win32.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, SAVED_TEXT, { flag: 'wx' });
    sourceSha256 = sha256(Buffer.from(UNSAVED_TEXT, 'utf8'));

    stage = 'wsl_runtime_preflight';
    const preflightCode = String.raw`
import json, pathlib, subprocess, sys
launcher, node, parser, tmp = map(pathlib.Path, sys.argv[1:])
node_version = subprocess.run([str(node), '--version'], check=True, capture_output=True, text=True, timeout=10).stdout.strip()
print(json.dumps({'launcher_ok': launcher.is_file() and not launcher.is_symlink(), 'node_ok': node.is_file() and not node.is_symlink() and node_version == 'v24.21.0', 'parser_ok': parser.is_dir() and not parser.is_symlink(), 'tmp_ok': tmp.is_dir() and not tmp.is_symlink(), 'python': sys.version.split()[0], 'node': node_version}))
`;
    const runtime = runWslPython(preflightCode, [LAUNCHER, RENDER_NODE, PARSER_ROOT, LINUX_TMP_BASE]);
    check(runtime.launcher_ok && runtime.node_ok && runtime.parser_ok && runtime.tmp_ok, 'configured_wsl_runtime_invalid');
    runtimePython = runtime.python;
    runtimeNode = runtime.node;

    privateTmp = `${LINUX_TMP_BASE}/windows WSL live probe ${process.pid} ${Date.now()}`;
    const temp = runWslPython(CREATE_TMP_PARENT, [LINUX_TMP_BASE, privateTmp]);
    check(temp.created === true, 'private_linux_tmp_create_failed');
    privateTmpCreated = true;
    const mapped = runWslPython(VERIFY_MAPPED_VAULT, [syntheticWslVault, SELECTED, sha256(Buffer.from(SAVED_TEXT, 'utf8'))]);
    check(mapped.root_absolute && mapped.root_exists && mapped.note_exists && mapped.saved_hash_matches, 'explicit_vault_mapping_failed');
    baselinePids = inspectRuntime(privateTmp).pids;

    stage = 'plugin_host_stub_setup';
    const originalModuleLoad = Module._load;
    const originalSpawn = childProcess.spawn;
    const spawnRecords = [];
    Module._load = function (request, parent, isMain) {
      if (request === 'obsidian') return { Plugin: class Plugin {}, Notice: class Notice {}, ItemView: class ItemView {} };
      return originalModuleLoad.call(this, request, parent, isMain);
    };
    childProcess.spawn = function (command, args, options) {
      spawnRecords.push({ command, args: [...args], env: { ...options.env }, shell: options.shell });
      return originalSpawn.call(this, command, args, options);
    };
    let EntryPreview;
    try { EntryPreview = require('../plugin/main'); }
    finally { Module._load = originalModuleLoad; }

    const file = { extension: 'md', path: SELECTED };
    const events = [];
    let diskReads = 0;
    let enumerations = 0;
    let editorText = UNSAVED_TEXT;
    const browser = makeBrowserView(events);
    let writingLeaf = null;
    const app = {
      vault: {
        adapter: { getBasePath: () => syntheticWindowsVault },
        read: async () => { diskReads++; throw new Error('disk_read_forbidden'); },
        getMarkdownFiles() { enumerations++; throw new Error('vault_enumeration_forbidden'); },
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
        on() { return {}; },
        detachLeavesOfType() {},
      },
    };
    plugin = new EntryPreview();
    const config = {
      expectedVault: syntheticWindowsVault,
      bridgeLaunch: {
        command: WSL_EXE,
        args: ['--distribution', DISTRO, '--exec', PYTHON, '-u', LAUNCHER],
        env: { PUBLICATION_NODE: RENDER_NODE, PUBLICATION_PARSER_ROOT: PARSER_ROOT, TMPDIR: privateTmp },
        vaultMap: { windowsVault: syntheticWindowsVault, wslVault: syntheticWslVault },
      },
    };
    Object.assign(plugin, {
      app, config, loadData: async () => config,
      registerView() {}, addRibbonIcon() {}, registerEvent() {},
      addCommand(command) { commands.set(command.id, command); },
      localProbeEvents: events,
    });
    commands = new Map();
    await plugin.onload();
    const startCommand = commands.get('current-note-live-preview');
    const disconnectCommand = commands.get('disconnect-local-live-session');
    check(Boolean(startCommand && disconnectCommand), 'current_note_live_commands_missing');
    probeHttp = trackPluginHttp(plugin);

    stage = 'first_current_note_live_start';
    const startResult = await startCommand.callback();
    check(startResult.ok === true, startResult.code === 'local_session_start_failed' ? 'local_session_start_failed' : 'first_session_start_failed');
    startedOnce = true;
    check(plugin.publicationSessionMode === true && plugin.publicationSession, 'session_mode_not_active');
    const firstOrigin = plugin.publicationSession.origin;
    const firstUrl = new URL(firstOrigin);
    check(firstUrl.protocol === 'http:' && firstUrl.hostname === '127.0.0.1' && Number(firstUrl.port) > 0, 'session_not_ipv4_loopback');
    firstHostLoopbackReady = await connectState(firstOrigin) === 'connected';
    check(firstHostLoopbackReady, 'host_loopback_not_ready_at_start_return');
    const firstPreview = await waitForSynced(plugin, 1);
    check(firstPreview.path === SELECTED && firstPreview.source_sha256 === sourceSha256, 'unsaved_selection_binding_failed');
    check(firstPreview.mode === 'live' && firstPreview.state === 'live' && firstPreview.publication_approval === false, 'live_only_response_invalid');
    check(firstPreview.srcdoc.includes('当前编辑器中的未保存正文'), 'current_editor_text_missing_from_preview');
    check(!firstPreview.srcdoc.includes('Synthetic disk version'), 'saved_disk_text_rendered');
    check(firstPreview.srcdoc.includes("default-src 'none'") && firstPreview.srcdoc.includes('blob:'), 'sandboxed_resource_render_missing');
    const liveRequests = probeHttp.records.filter(record => record.method === 'POST' && record.path === '/v1/live');
    check(liveRequests.length === 1 && liveRequests[0].authorized && liveRequests[0].originHeader === 'app://obsidian.md', 'authenticated_live_request_missing');
    let liveBody;
    try { liveBody = JSON.parse(liveRequests[0].body); } catch { fail('live_request_body_invalid'); }
    check(liveBody.path === SELECTED && liveBody.text === UNSAVED_TEXT && liveBody.source_sha256 === sourceSha256, 'live_request_did_not_use_unsaved_editor');
    check(JSON.stringify(liveBody.approved_assets) === '{}' && JSON.stringify(liveBody.approved_labels) === '{}', 'assets_or_labels_implicitly_approved');
    const resourceRequests = probeHttp.records.filter(record => record.method === 'GET' && record.path.startsWith('/v1/assets/'));
    check(resourceRequests.length > 0 && resourceRequests.every(record => record.authorized && record.originHeader === 'app://obsidian.md'), 'authenticated_bundle_resources_missing');
    check(browser.issued.length > 0 && firstPreview.object_urls.length > 0, 'host_stub_resources_not_rendered');
    check(diskReads === 0 && enumerations === 0, 'vault_disk_read_or_enumeration_occurred');

    stage = 'publication_workflow_blocked';
    const beforeBlocked = probeHttp.records.length;
    const blocked = [await plugin.generate(), await plugin.checkReceipt(), await plugin.recoverFinalPreview()];
    blockedWorkflowCodes = blocked.map(result => result.code);
    check(blockedWorkflowCodes.every(code => code === 'session_workflow_not_connected'), 'publication_workflow_not_blocked');
    check(probeHttp.records.length === beforeBlocked, 'blocked_workflow_made_http_request');
    check(probeHttp.records.every(record => record.path === '/v1/live' || record.path.startsWith('/v1/assets/')), 'unexpected_remote_or_receipt_route');
    pluginRequestSummary = { livePosts: liveRequests.length, authenticatedResources: resourceRequests.length, onlyLiveAndAssets: true };

    stage = 'disconnect_and_linux_cleanup';
    const firstBefore = inspectRuntime(privateTmp);
    firstPid = snapshotAddedPid({ pids: baselinePids }, firstBefore);
    ownedPids.push(firstPid);
    check(firstBefore.workspaces.length === 1, 'first_linux_workspace_missing');
    firstWorkspace = firstBefore.workspaces[0];
    check(firstBefore.receipt_count === 0, 'unexpected_receipt_created');
    const firstChild = plugin.sessionChild;
    const disconnected = await disconnectCommand.callback();
    check(disconnected.ok === true, 'explicit_disconnect_failed');
    check(firstChild && firstChild.exitCode === 0, 'wsl_child_exit_not_clean');
    firstPortClosed = await waitForPortClosed(firstOrigin);
    check(firstPortClosed, 'first_loopback_port_still_open');
    const firstAfter = inspectRuntime(privateTmp);
    firstProcessGone = !firstAfter.pids.includes(firstPid);
    firstWorkspaceRemoved = !firstAfter.workspaces.includes(firstWorkspace);
    check(firstProcessGone && firstWorkspaceRemoved, 'first_linux_process_or_workspace_leaked');
    check(plugin.publicationSession === null && plugin.sessionChild === null && plugin.live === null && browser.frame.srcdoc === '', 'disconnect_did_not_clear_session');

    stage = 'restart_and_unload_cleanup';
    const restartBaseline = inspectRuntime(privateTmp);
    const restartResult = await startCommand.callback();
    check(restartResult.ok === true, restartResult.code === 'local_session_start_failed' ? 'restart_start_failed' : 'restart_failed');
    restarted = true;
    const secondOrigin = plugin.publicationSession.origin;
    secondHostLoopbackReady = await connectState(secondOrigin) === 'connected';
    check(secondHostLoopbackReady, 'host_loopback_not_ready_at_restart_return');
    const secondPreview = await waitForSynced(plugin, 2);
    check(secondPreview.source_sha256 === sourceSha256, 'restarted_session_source_changed');
    const secondBefore = inspectRuntime(privateTmp);
    secondPid = snapshotAddedPid(restartBaseline, secondBefore);
    ownedPids.push(secondPid);
    check(secondBefore.workspaces.length === 1 && secondBefore.receipt_count === 0, 'restarted_workspace_or_receipt_invalid');
    secondWorkspace = secondBefore.workspaces[0];
    const secondChild = plugin.sessionChild;
    await plugin.onunload();
    unloaded = true;
    check(secondChild && secondChild.exitCode === 0, 'unload_child_exit_not_clean');
    secondPortClosed = await waitForPortClosed(secondOrigin);
    check(secondPortClosed, 'second_loopback_port_still_open');
    const secondAfter = inspectRuntime(privateTmp);
    secondProcessGone = !secondAfter.pids.includes(secondPid);
    secondWorkspaceRemoved = !secondAfter.workspaces.includes(secondWorkspace);
    check(secondProcessGone && secondWorkspaceRemoved, 'unload_linux_process_or_workspace_leaked');
    check(plugin.publicationSession === null && plugin.sessionChild === null && plugin.live === null && browser.frame.srcdoc === '', 'unload_did_not_clear_session');
    check(plugin.localSessionUnloaded === true, 'plugin_unload_not_observed');
    check(events.filter(event => event.state === 'synced').length >= 2, 'restart_preview_not_synced');
    check(browser.issued.every(item => browser.revoked.includes(item.value)), 'preview_blob_urls_not_revoked');
    allPreviewUrlsRevoked = true;
    check(fs.readFileSync(notePath, 'utf8') === SAVED_TEXT, 'synthetic_saved_file_changed');
    savedFileUnchanged = true;

    const launch = spawnRecords.find(record => path.win32.basename(record.command).toLowerCase() === 'wsl.exe');
    check(launch && launch.shell === false, 'wsl_child_not_spawned_without_shell');
    const expectedSpawnEnvKeys = ['PUBLICATION_NODE', 'PUBLICATION_PARSER_ROOT', 'TMPDIR'];
    check(JSON.stringify(Object.keys(launch.env).sort()) === JSON.stringify(expectedSpawnEnvKeys), 'wsl_spawn_environment_not_allowlisted');
    check(!Object.hasOwn(launch.env, 'WSLENV'), 'global_wslenv_used');
    check(launch.args.filter(arg => arg === '--exec').length === 1, 'wsl_direct_exec_not_retained');
    check(launch.args.includes('/usr/bin/env'), 'wsl_runtime_environment_not_forwarded');
    check(launch.args.includes(`TMPDIR=${privateTmp}`), 'space_containing_runtime_env_argument_split');
    check(launch.args.includes(`PUBLICATION_NODE=${RENDER_NODE}`) && launch.args.includes(`PUBLICATION_PARSER_ROOT=${PARSER_ROOT}`), 'runtime_environment_values_not_forwarded');
    check(launch.args.includes('/usr/bin/python3') && launch.args.includes('-u') && launch.args.includes(LAUNCHER), 'explicit_wsl_python_argv_invalid');
    check(launch.args.filter(arg => arg === '-c' || arg === '--command').length === 0, 'shell_command_argument_used');
    pluginSpawn = {
      explicitArgv: true,
      directExecRetained: true,
      shellFalse: true,
      runtimeEnvironmentInjectedViaEnvArgv: true,
      allowlistedHostEnvironmentOnly: true,
      spaceValuePreserved: true,
      hostLoopbackReadyAtStartReturn: firstHostLoopbackReady,
      hostLoopbackReadyAtRestartReturn: secondHostLoopbackReady,
    };
    probeHttp.restore();
    probeHttp = null;

  } catch (error) {
    failureCode = error?.code && /^[a-z0-9_]+$/.test(error.code) ? error.code : 'probe_failed';
  } finally {
    if (probeHttp) probeHttp.restore();
    if (plugin && plugin.localSessionUnloaded !== true) {
      try { await plugin.onunload(); } catch { cleanupOk = false; }
    }
    if (privateTmpCreated) {
      try {
        const current = inspectRuntime(privateTmp);
        const fresh = current.pids.filter(pid => ownedPids.includes(pid));
        if (fresh.length) {
          const terminated = runWslPython(TERMINATE_OWNED, [LAUNCHER, ...fresh.map(String)]);
          if (terminated.remaining_owned_pids.length) cleanupOk = false;
        }
        if (inspectRuntime(privateTmp).workspaces.length) fail('owned_workspace_still_active');
        const removed = runWslPython(CLEANUP_TMP_PARENT, [LINUX_TMP_BASE, privateTmp]);
        linuxTmpParentCleaned = removed.removed === true;
        if (!linuxTmpParentCleaned) cleanupOk = false;
      } catch { cleanupOk = false; }
    }
    if (fixtureCreated) {
      try { fs.rmSync(fixturePath, { recursive: true, force: false }); }
      catch { cleanupOk = false; }
    }
    if (fixtureBaseCreated) {
      try {
        const createdBase = path.win32.resolve(WINDOWS_FIXTURE_BASE);
        if (fs.existsSync(createdBase)) {
          const baseStat = fs.lstatSync(createdBase);
          if (baseStat.isDirectory() && !baseStat.isSymbolicLink() && fs.readdirSync(createdBase).length === 0) fs.rmdirSync(createdBase);
        }
      } catch { cleanupOk = false; }
    }
  }

  if (!cleanupOk) failureCode = failureCode ? `${failureCode}_cleanup_failed` : 'owned_fixture_cleanup_failed';
  if (failureCode) {
    process.stderr.write(`FAIL stage=${stage} code=${failureCode}\n`);
    process.exitCode = 1;
    return;
  }

  stage = 'evidence_write';
  const evidence = {
    status: 'PASS',
    scope: 'Windows host Node -> configured Ubuntu WSL Python -> authenticated IPv4 loopback live session and asset bundle',
    host_node: hostNode,
    wsl_version: wslVersion,
    wsl_distribution: DISTRO,
    wsl_python: runtimePython,
    renderer_node: runtimeNode,
    command: 'current-note-live-preview',
    host: 'Obsidian API stub; Blob/URL stub; no native GUI or visual acceptance',
    synthetic_windows_vault: syntheticWindowsVault,
    explicit_wsl_vault_mapping: syntheticWslVault,
    selected_note_path: SELECTED,
    unsaved_editor_sha256: sourceSha256,
    saved_file_unchanged: savedFileUnchanged,
    unsaved_editor_rendered_in_sandbox: true,
    authenticated_live_post_count: pluginRequestSummary.livePosts,
    authenticated_bundle_resource_count: pluginRequestSummary.authenticatedResources,
    publication_approval: false,
    blocked_workflow_codes: blockedWorkflowCodes,
    receipt_count: 0,
    runtime_argv: pluginSpawn,
    disconnect: { linux_pid: firstPid, process_gone: firstProcessGone, workspace_removed: firstWorkspaceRemoved, loopback_port_closed: firstPortClosed, host_loopback_ready_at_start_return: firstHostLoopbackReady },
    restart: { completed: restarted, linux_pid: secondPid, host_loopback_ready_at_start_return: secondHostLoopbackReady },
    unload: { completed: unloaded, process_gone: secondProcessGone, workspace_removed: secondWorkspaceRemoved, loopback_port_closed: secondPortClosed },
    preview_blob_urls_revoked: allPreviewUrlsRevoked,
    synthetic_fixture_cleaned: fixtureCreated && !fs.existsSync(fixturePath),
    linux_tmp_parent_cleaned: linuxTmpParentCleaned,
    disk_reads: 0,
    vault_enumerations: 0,
    saved_source_text: 'not included',
    private_handshake_or_authorization: 'not included',
  };
  const serialized = JSON.stringify(evidence, null, 2) + '\n';
  check(!/Bearer\s+[A-Za-z0-9_-]{20,}/.test(serialized), 'evidence_contains_authorization');
  const evidenceName = `windows-wsl-live-proof-${process.pid}-${crypto.randomUUID()}.json`;
  evidencePath = path.win32.join(EVIDENCE_BASE, evidenceName);
  try { fs.writeFileSync(evidencePath, serialized, { flag: 'wx' }); }
  catch { process.stderr.write('FAIL stage=evidence_write code=sanitized_evidence_write_failed\n'); process.exitCode = 1; return; }
  process.stdout.write(`${JSON.stringify({ status: 'PASS', hostNode, wslVersion, wslPython: runtimePython, rendererNode: runtimeNode, firstHostLoopbackReady, firstPortClosed, firstProcessGone, firstWorkspaceRemoved, restarted, secondHostLoopbackReady, secondPortClosed, secondProcessGone, secondWorkspaceRemoved, authenticatedLivePostCount: pluginRequestSummary.livePosts, authenticatedBundleResourceCount: pluginRequestSummary.authenticatedResources, evidencePath })}\n`);
})();
