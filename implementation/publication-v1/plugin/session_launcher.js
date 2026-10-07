'use strict';

const { spawn } = require('node:child_process');
const net = require('node:net');

const MAX_HANDSHAKE_BYTES = 4096;
const STARTUP_TIMEOUT_MS = 10000;
const ISOLATED_TEST_STARTUP_TIMEOUT_MS = 180000;
const ISOLATED_TEST_SITE_PIN = 'https://publication-v1.example.test';
const SHUTDOWN_TIMEOUT_MS = 5000;
const RUNTIME_ENV_KEYS = new Set(['PUBLICATION_NODE', 'PUBLICATION_PARSER_ROOT', 'TMPDIR']);
const SHELL_NAMES = new Set(['sh', 'bash', 'dash', 'zsh', 'fish', 'cmd.exe', 'powershell.exe', 'pwsh.exe']);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function normalizedVault(value) {
  return String(value || '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

function launchConfiguration(value) {
  if (!plainObject(value) || Object.keys(value).some(key => !['command', 'args', 'env', 'vaultMap', 'mode'].includes(key))) {
    throw new Error('bridge_launch_invalid');
  }
  const command = value.command;
  const absolute = typeof command === 'string'
    && (command.startsWith('/') || /^[A-Za-z]:[\\/]/.test(command) || /^\\\\[^\\]+\\[^\\]+/.test(command));
  if (!absolute || command.length > 4096 || command.includes('\0')) throw new Error('bridge_launch_invalid');
  const basename = command.replaceAll('\\', '/').split('/').at(-1).toLowerCase();
  if (SHELL_NAMES.has(basename)) throw new Error('bridge_launch_invalid');
  const args = value.args;
  if (!Array.isArray(args) || args.length > 32 || args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')
    || ['-c', '--command', '/c', '-command'].includes(arg.toLowerCase()))) throw new Error('bridge_launch_invalid');
  const env = value.env === undefined ? {} : value.env;
  if (!plainObject(env) || Object.keys(env).some(key => !RUNTIME_ENV_KEYS.has(key))) throw new Error('bridge_launch_invalid');
  const runtimeEnv = {};
  for (const [key, item] of Object.entries(env)) {
    if (typeof item !== 'string' || item.length > 4096 || item.includes('\0')) throw new Error('bridge_launch_invalid');
    runtimeEnv[key] = item;
  }
  const mode = value.mode === undefined ? 'live' : value.mode;
  if (!['live', 'isolated-publication-test'].includes(mode)) throw new Error('bridge_launch_invalid');
  return { command, args: [...args], env: runtimeEnv, mode };
}

function mappedVaultPath(launch, actualVault, expectedVault) {
  if (launch.vaultMap === undefined) return actualVault;
  const mapping = launch.vaultMap;
  if (!plainObject(mapping) || Object.keys(mapping).sort().join(',') !== 'windowsVault,wslVault'
    || typeof mapping.windowsVault !== 'string' || typeof mapping.wslVault !== 'string'
    || !/^[A-Za-z]:[\\/]/.test(actualVault)
    || normalizedVault(mapping.windowsVault) !== normalizedVault(actualVault)
    || normalizedVault(expectedVault) !== normalizedVault(actualVault)
    || !mapping.wslVault.startsWith('/') || mapping.wslVault.startsWith('//')
    || mapping.wslVault.includes('\0') || mapping.wslVault.split('/').some(part => part === '..')) {
    throw new Error('vault_mapping_invalid');
  }
  return mapping.wslVault;
}

function windowsWslLauncher(config) {
  const basename = config.command.replaceAll('\\', '/').split('/').at(-1).toLowerCase();
  return process.platform === 'win32' && basename === 'wsl.exe';
}

function wslExecArgs(config) {
  if (!windowsWslLauncher(config)) return config.args;
  const execIndexes = config.args.flatMap((arg, index) => arg === '--exec' ? [index] : []);
  if (execIndexes.length !== 1) throw new Error('bridge_launch_invalid');
  const execIndex = execIndexes[0];
  const linuxCommand = config.args[execIndex + 1];
  if (typeof linuxCommand !== 'string' || !linuxCommand.startsWith('/') || linuxCommand.startsWith('//')) {
    throw new Error('bridge_launch_invalid');
  }
  const assignments = Object.entries(config.env)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`);
  return [
    ...config.args.slice(0, execIndex + 1),
    '/usr/bin/env',
    ...assignments,
    ...config.args.slice(execIndex + 1),
  ];
}

function waitForLoopback(origin) {
  const url = new URL(origin);
  let settled = false;
  let timer;
  let socket;
  let cancel;
  const promise = new Promise((resolve, reject) => {
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch {}
      if (error) reject(error);
      else resolve();
    };
    cancel = () => finish(new Error('local_session_start_failed'));
    const attempt = () => {
      if (settled) return;
      const current = net.createConnection({ host: url.hostname, port: Number(url.port) });
      socket = current;
      let attemptSettled = false;
      const retry = () => {
        if (attemptSettled || settled) return;
        attemptSettled = true;
        current.destroy();
        timer = setTimeout(attempt, 50);
      };
      current.once('connect', () => {
        if (attemptSettled || settled) { current.destroy(); return; }
        attemptSettled = true;
        finish();
      });
      current.once('error', retry);
      current.setTimeout(1000, retry);
    };
    attempt();
  });
  return { promise, cancel: () => cancel?.() };
}

function parseHandshake(line, mode) {
  let value;
  try { value = JSON.parse(line.toString('utf8')); } catch { throw new Error('local_session_start_failed'); }
  const keys = mode === 'isolated-publication-test'
    ? 'authorization,origin,sitePin,type,workflowConnected'
    : 'authorization,origin,type';
  if (!plainObject(value) || Object.keys(value).sort().join(',') !== keys
    || value.type !== 'ready' || typeof value.origin !== 'string'
    || typeof value.authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(value.authorization)) {
    throw new Error('local_session_start_failed');
  }
  try {
    const origin = new URL(value.origin);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port
      || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
      || origin.origin !== value.origin) throw new Error();
  } catch {
    throw new Error('local_session_start_failed');
  }
  if (mode === 'isolated-publication-test'
    && (value.workflowConnected !== true || value.sitePin !== ISOLATED_TEST_SITE_PIN)) {
    throw new Error('local_session_start_failed');
  }
  return {
    origin: value.origin,
    authorization: value.authorization,
    ...(mode === 'isolated-publication-test'
      ? { workflowConnected: true, sitePin: ISOLATED_TEST_SITE_PIN }
      : {}),
  };
}

function spawnLocalLauncher(launch, runtimeConfig) {
  const config = launchConfiguration(launch);
  const payload = JSON.stringify(runtimeConfig);
  if (Buffer.byteLength(payload, 'utf8') > 8192) throw new Error('local_session_start_failed');
  let child;
  try {
    child = spawn(config.command, wslExecArgs(config), {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: config.env,
    });
  } catch {
    throw new Error('local_session_start_failed');
  }

  let resolveClose;
  const closePromise = new Promise(resolve => { resolveClose = resolve; });
  child.once('close', (code, signal) => resolveClose({ code, signal }));
  child.stderr.on('data', () => {});

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let settled = false;
  let cancelReadiness = () => {};
  let output = Buffer.alloc(0);
  const fail = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cancelReadiness();
    rejectReady(new Error('local_session_start_failed'));
  };
  const startupTimeoutMs = config.mode === 'isolated-publication-test'
    ? ISOLATED_TEST_STARTUP_TIMEOUT_MS
    : STARTUP_TIMEOUT_MS;
  const timer = setTimeout(fail, startupTimeoutMs);
  child.once('error', fail);
  child.once('close', fail);
  child.stdin.once('error', fail);
  child.stdout.on('data', chunk => {
    if (settled) {
      if (chunk.length) {
        try { child.stdin.end(); } catch {}
        try { child.kill(); } catch {}
      }
      return;
    }
    output = Buffer.concat([output, chunk]);
    if (output.length > MAX_HANDSHAKE_BYTES) { fail(); return; }
    const newline = output.indexOf(10);
    if (newline < 0) return;
    if (newline !== output.length - 1) { fail(); return; }
    try {
      const session = parseHandshake(output.subarray(0, newline), config.mode);
      output.fill(0);
      output = Buffer.alloc(0);
      if (windowsWslLauncher(config)) {
        const readiness = waitForLoopback(session.origin);
        cancelReadiness = readiness.cancel;
        readiness.promise.then(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolveReady(session);
        }, fail);
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveReady(session);
    } catch {
      fail();
    }
  });
  try {
    child.stdin.write(`${payload}\n`, error => { if (error) fail(); });
  } catch {
    fail();
  }
  return { child, closePromise, ready };
}

function waitForClose(closePromise, timeoutMs) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    closePromise.then(value => { clearTimeout(timer); resolve(value); });
  });
}

async function stopLocalLauncher(child, closePromise) {
  if (!child) return { code: 0, signal: null };
  try { if (!child.stdin.destroyed) child.stdin.end(); } catch {}
  let closed = await waitForClose(closePromise, SHUTDOWN_TIMEOUT_MS);
  if (!closed) {
    try { child.kill(); } catch {}
    closed = await waitForClose(closePromise, SHUTDOWN_TIMEOUT_MS);
  }
  if (!closed) throw new Error('local_session_shutdown_failed');
  return closed;
}

module.exports = { launchConfiguration, mappedVaultPath, spawnLocalLauncher, stopLocalLauncher };
