'use strict';
// Synthetic owner-policy fixture using the real JS codec, not the Linux-only Python reader.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createFixedInputPackage } = require('../desktop/core');
const { createPublicationPackage } = require('../desktop/publication');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from(input.png, 'base64');
const approvedAssets = { '图.png': { mime: 'image/png', sha256: sha(png) } };
// Explicit synthetic compiler pin for this isolated policy test, not a shipped bundle identity.
const bundlePin = sha(fs.readFileSync(path.join(__dirname, '../desktop/core.js')));
const fixed = createFixedInputPackage({ path: input.selected, source: input.source,
  title: input.title, labels: {}, approvedAssets, assets: { '图.png': png },
  resources: { 'assets/katex.min.css': Buffer.from('body{color:black}') },
  compilerSha256: bundlePin });
const result = createPublicationPackage(fixed.packageBytes,
  { expectedBundleSha256: bundlePin, approvedAssets });
const wire = JSON.parse(result.packageBytes.toString('utf8'));
const manifest = JSON.parse(wire.manifest);
const packagePath = path.join(input.output, result.packageId);
if (fs.existsSync(packagePath)) throw Error('fixture_already_exists');
fs.mkdirSync(path.join(packagePath, 'bundle'), { recursive: true });
fs.writeFileSync(path.join(packagePath, 'manifest.json'), result.manifestBytes);
for (const [relative, encoded] of Object.entries(wire.files)) {
  const destination = path.join(packagePath, 'bundle', relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, Buffer.from(encoded, 'base64'));
}
console.log(JSON.stringify({ package_id: result.packageId, compiler_sha256: result.compilerSha256,
  image_sha256: sha(png), selected: input.selected, title: input.title, manifest,
  scope: 'SIMULATED owner-policy test, real JS rendering, synthetic compiler pin' }));
