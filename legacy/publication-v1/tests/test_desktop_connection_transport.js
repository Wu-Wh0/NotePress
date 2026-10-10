'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { spawnSync } = require('node:child_process');
const { probeWordPress, createProbe, validateSiteUrl } = require('../desktop/connection');

// Synthetic loopback TLS fixture, not a WordPress or human-review acceptance.
let temp, key, cert;
test.before(() => {
  temp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'blog-connect-tls-'));
  const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', path.join(temp, 'key.pem'), '-out', path.join(temp, 'cert.pem')], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, 'test-only TLS fixture generation requires OpenSSL');
  key = fs.readFileSync(path.join(temp, 'key.pem')); cert = fs.readFileSync(path.join(temp, 'cert.pem'));
});
test.after(() => { if (temp) fs.rmSync(temp, { recursive: true, force: true }); });
async function fixture(handler, callback) {
  const server = https.createServer({ key, cert }, handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const siteUrl = `https://127.0.0.1:${server.address().port}/blog/`;
  try { await callback(siteUrl); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
function trustedProbe(options = {}) {
  // Trust only our synthetic fixture through a test dependency, never a product setting.
  return createProbe({ request: (url, opts, cb) => https.request(url, { ...opts, ca: cert }, cb), ...options });
}
const input = siteUrl => ({ siteUrl, username: 'SYNTHETIC_AUTHOR', secret: 'TEST_ONLY_NOT_A_REAL_APPLICATION_PASSWORD' });
function json(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
function positive(req, res) {
  const route = new URL(req.url, 'https://localhost').searchParams.get('rest_route');
  if (route === '/wp/v2/users/me') return json(res, { id: 123, capabilities: { publish_publication_v1: true, approve_publication_v1: true } });
  return json(res, { namespace: 'publication-v1/v1', routes: { '/publication-v1/v1/packages': {}, '/publication-v1/v1/operations': {}, '/publication-v1/v1/approve': {}, '/publication-v1/v1/commit': {} } });
}
test('site boundary permits HTTPS subpaths but rejects embedded auth, query, fragments and control chars', () => {
  assert.equal(validateSiteUrl('https://example.com/blog'), 'https://example.com/blog/');
  for (const url of ['http://example.com', 'https://u:p@example.com/', 'https://example.com/?token=x', 'https://example.com/#a', 'https:example.com', 'https://@example.com/', 'https://example.com/?', 'https://example.com/#', 'https://example.com/\n', 'https://example.com/\\outside', 'file:///a', ' https://example.com/']) {
    assert.throws(() => validateSiteUrl(url), e => e.code === 'invalid_site');
  }
});
test('real TLS default refuses an untrusted certificate without sending an HTTP request', async () => {
  let seen = 0;
  await fixture((req, res) => { seen++; positive(req, res); }, async siteUrl => {
    await assert.rejects(probeWordPress(input(siteUrl)), e => e.code === 'network_error');
    assert.equal(seen, 0);
  });
});
test('synthetic trusted TLS verifies account and namespace using only bounded GETs and header auth', async () => {
  const seen = [];
  await fixture((req, res) => { seen.push({ method: req.method, url: req.url, auth: req.headers.authorization }); positive(req, res); }, async siteUrl => {
    const result = await trustedProbe()(input(siteUrl));
    assert.deepEqual(result, { siteUrl, userId: 123, scope: 'account-and-namespace' });
    assert.equal(seen.length, 2);
    for (const req of seen) {
      assert.equal(req.method, 'GET');
      assert.equal(new URL(req.url, siteUrl).pathname, '/blog/index.php');
      assert.equal(req.auth, 'Basic ' + Buffer.from('SYNTHETIC_AUTHOR:TEST_ONLY_NOT_A_REAL_APPLICATION_PASSWORD').toString('base64'));
      assert.ok(!req.url.includes('SYNTHETIC_AUTHOR') && !req.url.includes('TEST_ONLY'));
      assert.ok(!result.secret && !result.auth);
    }
  });
});
test('redirects are rejected, never followed or credential-forwarded', async () => {
  let seen = 0;
  await fixture((req, res) => { seen++; res.writeHead(302, { Location: 'https://example.com/do-not-follow' }); res.end(); }, async siteUrl => {
    await assert.rejects(trustedProbe()(input(siteUrl)), e => e.code === 'redirect_blocked');
    assert.equal(seen, 1);
  });
});
test('rejects account permissions, authentication, missing API and malformed responses without reflecting body', async () => {
  for (const [status, body, code] of [[401, { message: 'DO_NOT_REFLECT' }, 'auth_failed'], [200, { id: 123, capabilities: { publish_publication_v1: true } }, 'account_permissions'], [200, { id: '123', capabilities: {} }, 'invalid_response'], [200, { id: 123, capabilities: { publish_publication_v1: true, approve_publication_v1: true } }, 'api_missing']]) {
    let count = 0;
    await fixture((req, res) => { count++; json(res, count === 2 ? { namespace: 'unrelated/v1' } : body, status); }, async siteUrl => {
      await assert.rejects(trustedProbe()(input(siteUrl)), e => e.code === code && !e.message.includes('DO_NOT_REFLECT'));
    });
  }
});
test('oversized, truncated, compressed and invalid-JSON responses fail closed', async () => {
  for (const kind of ['large', 'truncated', 'compressed', 'json']) {
    await fixture((req, res) => {
      if (kind === 'truncated') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '10000' }); res.write('{'); res.destroy(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', ...(kind === 'compressed' ? { 'Content-Encoding': 'gzip' } : {}) });
      res.end(kind === 'large' ? 'x'.repeat(300000) : 'INVALID_JSON');
    }, async siteUrl => {
      await assert.rejects(trustedProbe()(input(siteUrl)), e => e.code === (kind === 'large' ? 'response_too_large' : kind === 'truncated' ? 'network_error' : 'invalid_response'));
    });
  }
});
test('total deadline and cancellation abort the request', async () => {
  await fixture((req, res) => { /* Deliberately no response to synthetic probe. */ }, async siteUrl => {
    await assert.rejects(trustedProbe({ timeoutMs: 80 })(input(siteUrl)), e => e.code === 'timeout');
    const controller = new AbortController();
    const pending = trustedProbe()({ ...input(siteUrl), signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, e => e.code === 'cancelled');
    controller.abort();
    await assert.rejects(trustedProbe()({ ...input(siteUrl), signal: controller.signal }), e => e.code === 'cancelled');
  });
});
