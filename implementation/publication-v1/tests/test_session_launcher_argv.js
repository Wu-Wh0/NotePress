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
