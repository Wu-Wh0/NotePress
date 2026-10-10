'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { URL } = require('node:url');
const { createWordPressClient } = require('../src/wordpress-client');

let fixtureDir;
let certPem;

before(() => {
  const scratch = process.env.WORDPRESS_TEST_SCRATCH || process.env.TMPDIR || require('node:os').tmpdir();
  fs.mkdirSync(scratch, { recursive: true });
  fixtureDir = fs.mkdtempSync(path.join(scratch, 'wordpress-client-'));
  const keyPath = path.join(fixtureDir, 'key.pem');
  const certPath = path.join(fixtureDir, 'cert.pem');
  const openssl = process.env.OPENSSL_BIN || 'openssl';
  const result = spawnSync(openssl, [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
    '-out', certPath, '-days', '2', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `synthetic TLS certificate generation failed: ${result.stderr}`);
  certPem = fs.readFileSync(certPath);
});

after(() => {
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
});

async function startServer(handler) {
  const key = fs.readFileSync(path.join(fixtureDir, 'key.pem'));
  const cert = fs.readFileSync(path.join(fixtureDir, 'cert.pem'));
  const server = https.createServer({ key, cert }, handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    siteUrl: `https://127.0.0.1:${address.port}/subsite`,
    clientOptions: { username: 'synthetic-author', secret: 'synthetic-secret', trustedCa: certPem },
  };
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function routeOf(req) {
  return new URL(req.url, 'https://fixture.invalid').searchParams.get('rest_route');
}

function sendJson(res, status, body, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, ...headers });
  res.end(bytes);
}

function baseClientOptions(siteUrl, clientOptions) {
  return { siteUrl, ...clientOptions };
}

test('probe authenticates only in the header and verifies native REST routes/capabilities', async (t) => {
  const seen = [];
  const fixture = await startServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization, route: routeOf(req) });
    if (seen.at(-1).route === '/') {
      return sendJson(res, 200, { routes: { '/wp/v2/posts': {}, '/wp/v2/media': {} } });
    }
    if (seen.at(-1).route === '/wp/v2/users/me') {
      return sendJson(res, 200, {
        id: 23,
        capabilities: { publish_posts: true, upload_files: true },
      });
    }
    sendJson(res, 404, { code: 'rest_no_route' });
  });
  t.after(() => closeServer(fixture.server));

  const client = createWordPressClient(baseClientOptions(fixture.siteUrl, fixture.clientOptions));
  const result = await client.probe();

  assert.equal(result.ownerID, 23);
  assert.deepEqual(result.capabilities, { publish_posts: true, upload_files: true });
  assert.equal(seen.length, 2);
  assert.ok(seen.every((item) => item.url.startsWith('/subsite/index.php?rest_route=')));
  assert.ok(seen.every((item) => item.authorization === `Basic ${Buffer.from('synthetic-author:synthetic-secret').toString('base64')}`));
  assert.ok(seen.every((item) => !item.url.includes('synthetic-secret')));
});

test('createPost defaults to a native draft and sends UTF-8 JSON once', async (t) => {
  const requests = [];
  const fixture = await startServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method, route: routeOf(req), body: Buffer.concat(chunks).toString('utf8'), contentType: req.headers['content-type'] });
      sendJson(res, 201, { id: 41, status: 'draft', title: { raw: '你好' }, content: { raw: '正文' } });
    });
  });
  t.after(() => closeServer(fixture.server));

  const client = createWordPressClient(baseClientOptions(fixture.siteUrl, fixture.clientOptions));
  const post = await client.createPost({ title: '你好', content: '正文' });

  assert.equal(post.id, 41);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].route, '/wp/v2/posts');
  assert.equal(requests[0].contentType, 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(requests[0].body), { title: '你好', content: '正文', status: 'draft' });
});

test('create and update serialize only an explicit validated slug', async (t) => {
  const requests = [];
  const fixture = await startServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ route: routeOf(req), body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      sendJson(res, 200, { id: 41 });
    });
  });
  t.after(() => closeServer(fixture.server));
  const client = createWordPressClient(baseClientOptions(fixture.siteUrl, fixture.clientOptions));
  await client.createPost({ title: 'Title', content: '', status: 'draft', slug: `obsidian-create-${'a'.repeat(32)}` });
  await client.updatePost(41, { title: 'Title', content: 'Body', status: 'draft', slug: '' });
  assert.deepEqual(requests, [
    { route: '/wp/v2/posts', body: { title: 'Title', content: '', status: 'draft', slug: `obsidian-create-${'a'.repeat(32)}` } },
    { route: '/wp/v2/posts/41', body: { title: 'Title', content: 'Body', status: 'draft', slug: '' } },
  ]);
  for (const slug of [42, '', 'a'.repeat(201), 'bad\nslug']) {
    await assert.rejects(client.createPost({ title: 'Title', content: '', slug }));
  }
  assert.equal(requests.length, 2);
});

test('uploadMedia sends the exact binary Buffer with a validated content-hash filename', async (t) => {
  const crypto = require('node:crypto');
  const binary = Buffer.from([0, 255, 1, 128, 10, 13]);
  const filename = `${crypto.createHash('sha256').update(binary).digest('hex')}.png`;
  let received;
  const fixture = await startServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received = { method: req.method, route: routeOf(req), headers: req.headers, body: Buffer.concat(chunks) };
      sendJson(res, 201, { id: 55, source_url: 'https://media.example.invalid/image.png' });
    });
  });
  t.after(() => closeServer(fixture.server));

  const client = createWordPressClient(baseClientOptions(fixture.siteUrl, fixture.clientOptions));
  const media = await client.uploadMedia(binary, 'image/png', filename);

  assert.equal(media.id, 55);
  assert.equal(received.method, 'POST');
  assert.equal(received.route, '/wp/v2/media');
  assert.equal(received.headers['content-type'], 'image/png');
  assert.equal(received.headers['content-disposition'], `attachment; filename="${filename}"`);
  assert.deepEqual(received.body, binary);
});

test('updatePost publishes a known positive ID without creating another post', async (t) => {
  const requests = [];
  const fixture = await startServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method, route: routeOf(req), body: Buffer.concat(chunks).toString('utf8') });
      sendJson(res, 200, { id: 41, status: 'publish', link: 'https://fixture.invalid/post/41' });
    });
  });
  t.after(() => closeServer(fixture.server));

  const client = createWordPressClient(baseClientOptions(fixture.siteUrl, fixture.clientOptions));
  const updated = await client.updatePost(41, { status: 'publish' });

  assert.equal(updated.id, 41);
  assert.equal(updated.status, 'publish');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].route, '/wp/v2/posts/41');
  assert.deepEqual(JSON.parse(requests[0].body), { status: 'publish' });
});

test('getPost reads a known native post ID', async (t) => {
  let request;
  const fixture = await startServer((req, res) => {
    request = { method: req.method, route: routeOf(req) };
    sendJson(res, 200, { id: 41, status: 'publish', title: { rendered: 'Hello' } });
  });
  t.after(() => closeServer(fixture.server));

  const client = createWordPressClient(baseClientOptions(fixture.siteUrl, fixture.clientOptions));
  const post = await client.getPost(41);

  assert.equal(post.id, 41);
  assert.equal(request.method, 'GET');
  assert.equal(request.route, '/wp/v2/posts/41');
});

test('findPosts queries native posts with edit context', async (t) => {
  let received;
  const fixture = await startServer((req, res) => {
    const url = new URL(req.url, 'https://fixture.invalid');
    received = { method: req.method, route: url.searchParams.get('rest_route'), search: url.searchParams.get('search'), context: url.searchParams.get('context') };
    sendJson(res, 200, [{ id: 41, status: 'draft' }]);
  });
  t.after(() => closeServer(fixture.server));

  const client = createWordPressClient(baseClientOptions(fixture.siteUrl, fixture.clientOptions));
  const posts = await client.findPosts({ search: 'Draft title' });

  assert.deepEqual(posts, [{ id: 41, status: 'draft' }]);
  assert.equal(received.method, 'GET');
  assert.equal(received.route, '/wp/v2/posts');
  assert.equal(received.search, 'Draft title');
  assert.equal(received.context, 'edit');
});

test('untrusted TLS certificate rejects a write before HTTP dispatch', async (t) => {
  let handlerCalls = 0;
  const fixture = await startServer((_req, res) => {
    handlerCalls += 1;
    sendJson(res, 201, { id: 88 });
  });
  t.after(() => closeServer(fixture.server));

  const client = createWordPressClient({
    siteUrl: fixture.siteUrl,
    username: 'synthetic-author',
    secret: 'synthetic-secret',
    timeoutMs: 2000,
  });
  await assert.rejects(client.createPost({ title: 'x', content: 'y' }), (error) => {
    assert.equal(error.code, 'TLS_ERROR');
    assert.equal(error.dispatched, false);
    assert.equal(error.indeterminate, false);
    return true;
  });
  assert.equal(handlerCalls, 0);
});

test('siteUrl rejects even empty query and fragment delimiters', () => {
  const base = {
    username: 'synthetic-author',
    secret: 'synthetic-secret',
  };
  assert.throws(() => createWordPressClient({ ...base, siteUrl: 'https://example.invalid/blog?' }), { code: 'INVALID_SITE_URL' });
  assert.throws(() => createWordPressClient({ ...base, siteUrl: 'https://example.invalid/blog#' }), { code: 'INVALID_SITE_URL' });
});

test('write redirect is rejected as indeterminate and never followed', async (t) => {
  let calls = 0;
  const fixture = await startServer((_req, res) => {
    calls += 1;
    sendJson(res, 307, { code: 'redirect' }, { Location: '/subsite/other' });
  });
  t.after(() => closeServer(fixture.server));

  const client = createWordPressClient(baseClientOptions(fixture.siteUrl, fixture.clientOptions));
  await assert.rejects(client.createPost({ title: 'x', content: 'y' }), (error) => {
    assert.equal(error.code, 'REDIRECT_REJECTED');
    assert.equal(error.dispatched, true);
    assert.equal(error.indeterminate, true);
    return true;
  });
  assert.equal(calls, 1);
});

test('malformed JSON is rejected without exposing response text', async (t) => {
  const fixture = await startServer((_req, res) => {
    const body = Buffer.from('{"secret":"synthetic-secret",', 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
    res.end(body);
  });
  t.after(() => closeServer(fixture.server));

  const client = createWordPressClient(baseClientOptions(fixture.siteUrl, fixture.clientOptions));
  await assert.rejects(client.getPost(41), (error) => {
    assert.equal(error.code, 'INVALID_RESPONSE');
    assert.equal(error.dispatched, true);
    assert.equal(error.indeterminate, false);
    assert.equal(error.message.includes('synthetic-secret'), false);
    return true;
  });
});

test('oversized response body is rejected at the configured byte bound', async (t) => {
  const fixture = await startServer((_req, res) => sendJson(res, 200, { id: 41, payload: 'x'.repeat(256) }));
  t.after(() => closeServer(fixture.server));

  const client = createWordPressClient({ ...baseClientOptions(fixture.siteUrl, fixture.clientOptions), maxResponseBytes: 64 });
  await assert.rejects(client.getPost(41), (error) => {
    assert.equal(error.code, 'RESPONSE_TOO_LARGE');
    assert.equal(error.dispatched, true);
    return true;
  });
});

test('an already-aborted write is rejected before dispatch', async (t) => {
  let calls = 0;
  const fixture = await startServer((_req, res) => {
    calls += 1;
    sendJson(res, 201, { id: 99 });
  });
  t.after(() => closeServer(fixture.server));
  const controller = new AbortController();
  controller.abort();

  const client = createWordPressClient({ ...baseClientOptions(fixture.siteUrl, fixture.clientOptions), signal: controller.signal });
  await assert.rejects(client.createPost({ title: 'x', content: 'y' }), (error) => {
    assert.equal(error.code, 'ABORTED');
    assert.equal(error.dispatched, false);
    assert.equal(error.indeterminate, false);
    return true;
  });
  assert.equal(calls, 0);
});

test('write disconnect after dispatch is indeterminate and is not retried', async (t) => {
  let calls = 0;
  const fixture = await startServer((req) => {
    calls += 1;
    req.resume();
    req.on('end', () => req.socket.destroy());
  });
  t.after(() => closeServer(fixture.server));

  const client = createWordPressClient({ ...baseClientOptions(fixture.siteUrl, fixture.clientOptions), timeoutMs: 2000 });
  await assert.rejects(client.createPost({ title: 'x', content: 'y' }), (error) => {
    assert.equal(error.code, 'TRANSPORT_ERROR');
    assert.equal(error.dispatched, true);
    assert.equal(error.indeterminate, true);
    return true;
  });
  assert.equal(calls, 1);
});

test('createPost rejects unknown fields before dispatch', async (t) => {
  let calls = 0;
  const fixture = await startServer((_req, res) => {
    calls += 1;
    sendJson(res, 201, { id: 91, status: 'draft' });
  });
  t.after(() => closeServer(fixture.server));

  const client = createWordPressClient(baseClientOptions(fixture.siteUrl, fixture.clientOptions));
  await assert.rejects(client.createPost({ title: 'x', content: 'y', unexpected: true }), (error) => {
    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.equal(error.dispatched, false);
    return true;
  });
  assert.equal(calls, 0);
});

test('truncated response is rejected rather than parsed as complete JSON', async (t) => {
  const fixture = await startServer((_req, res) => {
    const body = Buffer.from('{"id":41}', 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': String(body.length + 20),
      Connection: 'close',
    });
    res.end(body);
  });
  t.after(() => closeServer(fixture.server));

  const client = createWordPressClient({ ...baseClientOptions(fixture.siteUrl, fixture.clientOptions), timeoutMs: 3000 });
  await assert.rejects(client.getPost(41), (error) => {
    assert.equal(error.code, 'TRUNCATED_RESPONSE');
    assert.equal(error.dispatched, true);
    return true;
  });
});

test('empty userinfo delimiter is rejected before creating the client', () => {
  assert.throws(() => createWordPressClient({ siteUrl: 'https://@example.invalid', username: 'author', secret: 'synthetic-secret' }), { code: 'INVALID_SITE_URL' });
});

test('a colon in a Basic authentication username is rejected', () => {
  assert.throws(() => createWordPressClient({ siteUrl: 'https://example.invalid', username: 'author:other', secret: 'synthetic-secret' }), { code: 'INVALID_ARGUMENT' });
});

test('site URL rejects Unicode whitespace rather than silently encoding it', () => {
  assert.throws(() => createWordPressClient({ siteUrl: 'https://example.invalid/\u00a0', username: 'author', secret: 'synthetic-secret' }), { code: 'INVALID_SITE_URL' });
});

test('a dispatched write with HTTP 400 does not imply rollback or permit automatic retry', async (t) => {
  let writes = 0;
  const fixture = await startServer((req, res) => {
    req.resume();
    req.on('end', () => { writes += 1; sendJson(res, 400, { code: 'rest_after_write_failure' }); });
  });
  t.after(() => closeServer(fixture.server));
  const client = createWordPressClient(baseClientOptions(fixture.siteUrl, fixture.clientOptions));
  await assert.rejects(client.createPost({ title: 'x', content: 'y' }), error => {
    assert.equal(error.code, 'HTTP_ERROR');
    assert.equal(error.dispatched, true);
    assert.equal(error.indeterminate, true);
    return true;
  });
  assert.equal(writes, 1);
});
