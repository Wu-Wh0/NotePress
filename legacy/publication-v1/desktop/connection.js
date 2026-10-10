'use strict';
const https = require('node:https');

class ConnectionError extends Error {
  constructor(code) { super(code); this.name = 'ConnectionError'; this.code = code; }
}
const fail = code => new ConnectionError(code);
function validateSiteUrl(value) {
  if (typeof value !== 'string' || value.length > 1024 || !/^https:\/\//i.test(value)
    || /[\s\\\x00-\x1f\x7f?#]/u.test(value) || /^https:\/\/[^/]*@/i.test(value)) throw fail('invalid_site');
  let parsed;
  try { parsed = new URL(value); } catch { throw fail('invalid_site'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) throw fail('invalid_site');
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed.href;
}
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function endpoint(siteUrl, route, context) {
  const url = new URL('index.php', siteUrl);
  url.searchParams.set('rest_route', route);
  if (context) url.searchParams.set('context', context);
  return url;
}

// Native desktop HTTPS avoids implicit redirects. No custom CA/TLS override is
// exposed in plugin settings. Dependency injection is only for transport tests.
function createProbe({ request = https.request, timeoutMs = 10000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw fail('timeout');
  return async function probe({ siteUrl, username, secret, signal } = {}) {
    siteUrl = validateSiteUrl(siteUrl);
    if (typeof username !== 'string' || !username || username.length > 200 || /[:\x00-\x1f\x7f]/.test(username)) throw fail('invalid_account');
    if (typeof secret !== 'string' || !secret || secret.length > 4096 || /[\x00-\x1f\x7f]/.test(secret)) throw fail('missing_secret');
    if (signal?.aborted) throw fail('cancelled');
    const deadline = Date.now() + timeoutMs;
    const authorization = 'Basic ' + Buffer.from(`${username}:${secret}`, 'utf8').toString('base64');
    async function readJson(url, maxBytes, missingApi = false) {
      if (signal?.aborted) throw fail('cancelled');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw fail('timeout');
      return new Promise((resolve, reject) => {
        let req, res, timer, done = false;
        const finish = (error, result) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          if (error) { res?.destroy(); req?.destroy(); reject(error); }
          else resolve(result);
        };
        const cancel = () => finish(fail('cancelled'));
        signal?.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(() => finish(fail('timeout')), remaining);
        try {
          req = request(url, {
            method: 'GET', agent: false, rejectUnauthorized: true,
            headers: { Authorization: authorization, Accept: 'application/json', 'Accept-Encoding': 'identity' },
          }, response => {
            res = response;
            res.on('error', () => finish(fail('network_error')));
            res.on('aborted', () => finish(fail('network_error')));
            res.on('close', () => { if (!res.complete) finish(fail('network_error')); });
            const status = res.statusCode;
            if (status >= 300 && status < 400) return finish(fail('redirect_blocked'));
            if (status === 401 || status === 403) return finish(fail('auth_failed'));
            if (status !== 200) return finish(fail(missingApi && status === 404 ? 'api_missing' : 'invalid_response'));
            const type = res.headers['content-type'];
            const encoding = res.headers['content-encoding'];
            if (typeof type !== 'string' || !/^application\/json(?:\s*;|$)/i.test(type) || (encoding && encoding !== 'identity')) return finish(fail('invalid_response'));
            const length = res.headers['content-length'];
            if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) return finish(fail('response_too_large'));
            const chunks = []; let bytes = 0;
            res.on('data', chunk => {
              if (done) return;
              bytes += chunk.length;
              if (bytes > maxBytes) return finish(fail('response_too_large'));
              chunks.push(chunk);
            });
            res.on('end', () => {
              if (done) return;
              try {
                const raw = Buffer.concat(chunks, bytes);
                const text = raw.toString('utf8');
                if (!Buffer.from(text, 'utf8').equals(raw)) throw fail('invalid_response');
                const value = JSON.parse(text);
                if (!object(value)) throw fail('invalid_response');
                finish(null, value);
              } catch { finish(fail('invalid_response')); }
            });
          });
          req.on('error', () => finish(fail('network_error')));
          if (done || signal?.aborted) { cancel(); req.destroy(); return; }
          req.end();
        } catch { finish(fail('network_error')); }
      });
    }
    const user = await readJson(endpoint(siteUrl, '/wp/v2/users/me', 'edit'), 65536);
    if (!Number.isSafeInteger(user.id) || user.id < 1 || !object(user.capabilities)) throw fail('invalid_response');
    if (user.capabilities.publish_publication_v1 !== true || user.capabilities.approve_publication_v1 !== true) throw fail('account_permissions');
    const api = await readJson(endpoint(siteUrl, '/publication-v1/v1'), 262144, true);
    if (api.namespace !== 'publication-v1/v1' || !object(api.routes)
      || !['packages', 'operations', 'approve', 'commit'].every(route => Object.hasOwn(api.routes, '/publication-v1/v1/' + route))) throw fail('api_missing');
    if (signal?.aborted) throw fail('cancelled');
    // This is NOT a compiler/policy pin or server-readiness verdict; a later
    // prepare operation must validate the exact package and server binding.
    return { siteUrl, userId: user.id, scope: 'account-and-namespace' };
  };
}
const probeWordPress = createProbe();
module.exports = { ConnectionError, validateSiteUrl, createProbe, probeWordPress };
