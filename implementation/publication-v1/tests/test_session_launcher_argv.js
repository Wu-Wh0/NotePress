'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const childProcess = require('node:child_process');

test('Windows WSL environment insertion retains explicit --exec and argv boundaries', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalSpawn = childProcess.spawn;
  const modulePath = require.resolve('../plugin/session_launcher');
  let captured;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    childProcess.spawn = (command, args, options) => {
      captured = { command, args, options };
      throw new Error('synthetic_spawn_stop');
    };
    delete require.cache[modulePath];
    const { spawnLocalLauncher } = require(modulePath);
    assert.throws(() => spawnLocalLauncher({
      command: 'C:\\Windows\\System32\\wsl.exe',
      args: ['--distribution', 'Ubuntu', '--exec', '/usr/bin/python3', '-u', '/synthetic/launcher.py'],
      env: { PUBLICATION_NODE: '/runtime/node', PUBLICATION_PARSER_ROOT: '/runtime/parser', TMPDIR: '/scratch/space value' },
    }, { vault: '/synthetic/vault', selected: '中文/selected.md' }), /local_session_start_failed/);
    assert.equal(captured.options.shell, false);
    assert.deepEqual(captured.args.slice(0, 4), ['--distribution', 'Ubuntu', '--exec', '/usr/bin/env']);
    assert.equal(captured.args.filter(arg => arg === '--exec').length, 1);
    assert.ok(captured.args.includes('TMPDIR=/scratch/space value'));
    assert.deepEqual(captured.args.slice(-3), ['/usr/bin/python3', '-u', '/synthetic/launcher.py']);
    assert.deepEqual(Object.keys(captured.options.env).sort(), ['PUBLICATION_NODE', 'PUBLICATION_PARSER_ROOT', 'TMPDIR']);
  } finally {
    childProcess.spawn = originalSpawn;
    Object.defineProperty(process, 'platform', platform);
    delete require.cache[modulePath];
  }
});

test('isolated publication mode is explicit and unknown modes fail closed', () => {
  const { launchConfiguration } = require('../plugin/session_launcher');
  const base = {
    command: '/usr/bin/python3', args: ['/tmp/isolated-launcher.py'],
    env: { TMPDIR: '/scratch' },
  };
  assert.equal(launchConfiguration({ ...base, mode: 'isolated-publication-test' }).mode, 'isolated-publication-test');
  assert.throws(() => launchConfiguration({ ...base, mode: 'production-publication' }), /bridge_launch_invalid/);
});

test('private handshake must agree with explicit isolated opt-in and synthetic site pin', async () => {
  const { spawnLocalLauncher, stopLocalLauncher } = require('../plugin/session_launcher');
  const cases = [
    { mode: 'live', connected: true, site: 'https://publication-v1.example.test' },
    { mode: 'isolated-publication-test', connected: undefined, site: undefined },
    { mode: 'isolated-publication-test', connected: true, site: 'https://foreign.example.test' },
    { mode: 'isolated-publication-test', connected: false, site: 'https://publication-v1.example.test' },
  ];
  for (const value of cases) {
    const script = `const crypto=require('node:crypto');const ready={type:'ready',origin:'http://127.0.0.1:64001',authorization:'Bearer '+crypto.randomBytes(32).toString('base64url'),...${JSON.stringify(value.connected === undefined ? {} : { workflowConnected: value.connected, sitePin: value.site })}};process.stdin.once('data',()=>process.stdout.write(JSON.stringify(ready)+'\\n'));process.stdin.resume();`;
    const pending = spawnLocalLauncher({ command: process.execPath, args: ['-e', script], mode: value.mode, env: {} }, { vault: '/synthetic', selected: 'source.md' });
    try {
      await assert.rejects(pending.ready, /local_session_start_failed/);
    } finally {
      const closed = await stopLocalLauncher(pending.child, pending.closePromise);
      assert.equal(closed.code, 0);
    }
  }
});
