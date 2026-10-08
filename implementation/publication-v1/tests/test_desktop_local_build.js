const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const dist = path.resolve(__dirname, '../../../../publication-v1/direct-plugin/dist');

test('build rejects an existing linked output ancestor before changing protected bytes', () => {
  const temp = fs.mkdtempSync(path.join(process.env.TMPDIR || 'E:/Hermes/cache/scratch', 'desktop-build-ancestor-'));
  try {
    const desktop = path.join(root, 'desktop');
    const fixture = path.join(temp, 'workspace/direct-plugin/implementation/publication-v1/desktop');
    fs.mkdirSync(fixture, { recursive: true });
    for (const name of fs.readdirSync(desktop)) {
      if (fs.statSync(path.join(desktop, name)).isFile()) fs.copyFileSync(path.join(desktop, name), path.join(fixture, name));
    }
    fs.symlinkSync(path.join(desktop, 'node_modules'), path.join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const protectedRoot = path.join(temp, 'protected');
    const protectedDist = path.join(protectedRoot, 'direct-plugin/dist');
    fs.mkdirSync(protectedDist, { recursive: true });
    const sentinel = path.join(protectedDist, 'main.js');
    const original = Buffer.from('SYNTHETIC_PROTECTED_SOURCE_DO_NOT_OVERWRITE\n');
    fs.writeFileSync(sentinel, original);
    fs.symlinkSync(protectedRoot, path.join(temp, 'workspace/publication-v1'), process.platform === 'win32' ? 'junction' : 'dir');
    const built = spawnSync(process.execPath, [path.join(fixture, 'build.cjs')], { cwd: fixture, encoding: 'utf8', timeout: 45000 });
    assert.ok(fs.readFileSync(sentinel).equals(original), 'linked output ancestor must not overwrite protected source bytes');
    assert.notEqual(built.status, 0, 'linked output ancestor must fail closed');
    assert.match(built.stderr, /unsafe_output_directory/);
    assert.deepEqual(fs.readdirSync(protectedDist), ['main.js']);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('build emits a self-contained installable desktop plugin with no bridge or publishing transport', () => {
  const built = spawnSync(process.execPath, [path.join(root, 'desktop', 'build.cjs')], { cwd: root, encoding: 'utf8', timeout: 45000 });
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
  const other = spawnSync(process.execPath, [path.join(root, 'desktop', 'build.cjs')], { cwd: path.join(root, 'desktop'), encoding: 'utf8', timeout: 45000 });
  assert.equal(other.status, 0, `${other.stdout}\n${other.stderr}`);
  assert.equal(JSON.parse(other.stdout).bundle_sha256, JSON.parse(built.stdout).bundle_sha256, 'caller cwd must not change the compiler bundle identity');
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, 'blog-publisher-local');
  assert.equal(manifest.minAppVersion, '1.12.7');
  assert.equal(manifest.isDesktopOnly, true);
  assert.ok(fs.statSync(path.join(dist, 'main.js')).size > 1000);
  assert.ok(fs.statSync(path.join(dist, 'assets', 'katex.min.css')).size > 1000);
  const fonts = fs.readdirSync(path.join(dist, 'assets', 'fonts'));
  assert.ok(fonts.length > 0);
  const bundle = fs.readFileSync(path.join(dist, 'main.js'), 'utf8');
  assert.match(bundle, /require\(["']obsidian["']\)/);
  assert.doesNotMatch(bundle, /node:(?:http|https|child_process)|http\.request|https\.request|child_process\.(?:spawn|exec)|(?:window|globalThis)\.fetch\s*\(/);
});
