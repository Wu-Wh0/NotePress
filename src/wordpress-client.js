'use strict';

const crypto = require('node:crypto');
const https = require('node:https');
const { TextDecoder } = require('node:util');

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

class WordPressClientError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'WordPressClientError';
    this.code = options.code || 'WORDPRESS_CLIENT_ERROR';
    this.dispatched = options.dispatched === true;
    this.indeterminate = options.indeterminate === true;
    for (const key of ['status', 'capability', 'ownerID']) {
      if (options[key] !== undefined) this[key] = options[key];
    }
  }
}

function fail(message, options) {
  return new WordPressClientError(message, options);
}

function parseSiteUrl(siteUrl) {
  if (typeof siteUrl !== 'string' || !siteUrl || siteUrl.includes('?') || siteUrl.includes('#') || /[\u0000-\u0020\u007f\\\\]/u.test(siteUrl)) {
    throw fail('siteUrl must be a strict HTTPS URL', { code: 'INVALID_SITE_URL' });
  }
  if (/\s/u.test(siteUrl) || /^https:\/\/[^/]*@/iu.test(siteUrl)) {
    throw fail('siteUrl must not contain whitespace or userinfo', { code: 'INVALID_SITE_URL' });
  }
  let parsed;
  try { parsed = new URL(siteUrl); } catch {
    throw fail('siteUrl must be a strict HTTPS URL', { code: 'INVALID_SITE_URL' });
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw fail('siteUrl must be HTTPS without userinfo, query, or fragment', { code: 'INVALID_SITE_URL' });
  }
  let path;
  try { path = decodeURIComponent(parsed.pathname); } catch {
    throw fail('siteUrl path is invalid', { code: 'INVALID_SITE_URL' });
  }
  if (/[\u0000-\u001f\u007f\\]/u.test(path)) throw fail('siteUrl path is invalid', { code: 'INVALID_SITE_URL' });
  return { origin: parsed.origin, basePath: parsed.pathname.replace(/\/+$/u, '') };
}

function createRequestJson({ origin, basePath, username, secret, signal, timeoutMs, maxResponseBytes, trustedCa }) {
  const authorization = `Basic ${Buffer.from(`${username}:${secret}`, 'utf8').toString('base64')}`;
  return ({ route, query = {}, method = 'GET', jsonBody, rawBody, rawContentType, filename }) => {
    const isWrite = method !== 'GET' && method !== 'HEAD';
    if (signal?.aborted) return Promise.reject(fail('request aborted before dispatch', { code: 'ABORTED' }));
    const url = new URL(`${basePath}/index.php`, origin);
    url.searchParams.set('rest_route', route);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    let body;
    const headers = { Authorization: authorization, Accept: 'application/json', 'Accept-Encoding': 'identity' };
    if (jsonBody !== undefined) {
      body = Buffer.from(JSON.stringify(jsonBody), 'utf8');
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = String(body.length);
    } else if (rawBody !== undefined) {
      body = rawBody;
      headers['Content-Type'] = rawContentType;
      headers['Content-Length'] = String(body.length);
      headers['Content-Disposition'] = `attachment; filename="${filename}"`;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let dispatched = false;
      let transportReady = false;
      let responseBytes = 0;
      let timer;
      const chunks = [];
      let request;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        const wasDispatched = dispatched && transportReady;
        rejectOnce(fail(wasDispatched ? 'request aborted after dispatch' : 'request aborted before dispatch', {
          code: 'ABORTED', dispatched: wasDispatched, indeterminate: isWrite && wasDispatched,
        }));
        request?.destroy();
      };
      const requestOptions = { method, headers, rejectUnauthorized: true };
      if (trustedCa !== undefined) requestOptions.ca = trustedCa;
      try {
        request = https.request(url, requestOptions, (response) => {
          const status = response.statusCode || 0;
          const lengthHeader = response.headers['content-length'];
          const encoding = response.headers['content-encoding'];
          if (status >= 300 && status < 400) {
            rejectOnce(fail('redirect responses are not followed', { code: 'REDIRECT_REJECTED', dispatched, indeterminate: isWrite, status }));
            response.destroy();
            request.destroy();
            return;
          }
          if (encoding && String(encoding).toLowerCase() !== 'identity') {
            rejectOnce(fail('unsupported response content encoding', { code: 'INVALID_RESPONSE', dispatched, indeterminate: isWrite, status }));
            response.destroy(); request.destroy(); return;
          }
          const contentType = response.headers['content-type'];
          if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|\s*$)/iu.test(contentType)) {
            rejectOnce(fail('response is not JSON', { code: 'INVALID_RESPONSE', dispatched, indeterminate: isWrite, status }));
            response.destroy(); request.destroy(); return;
          }
          let declaredLength;
          if (lengthHeader !== undefined) {
            if (!/^\d+$/u.test(String(lengthHeader))) {
              rejectOnce(fail('invalid response length', { code: 'INVALID_RESPONSE', dispatched, indeterminate: isWrite, status }));
              response.destroy(); request.destroy(); return;
            }
            declaredLength = Number(lengthHeader);
            if (!Number.isSafeInteger(declaredLength) || declaredLength > maxResponseBytes) {
              rejectOnce(fail('response exceeds configured size limit', { code: 'RESPONSE_TOO_LARGE', dispatched, indeterminate: isWrite, status }));
              response.destroy(); request.destroy(); return;
            }
          }
          response.on('data', (chunk) => {
            responseBytes += chunk.length;
            if (responseBytes > maxResponseBytes) {
              rejectOnce(fail('response exceeds configured size limit', { code: 'RESPONSE_TOO_LARGE', dispatched, indeterminate: isWrite, status }));
              response.destroy(); request.destroy(); return;
            }
            chunks.push(chunk);
          });
          response.on('aborted', () => rejectOnce(fail('response ended before completion', { code: 'TRUNCATED_RESPONSE', dispatched, indeterminate: isWrite, status })));
          response.on('error', () => rejectOnce(fail('response transport failed', { code: 'TRANSPORT_ERROR', dispatched, indeterminate: isWrite, status })));
          response.on('end', () => {
            if (settled) return;
            if (declaredLength !== undefined && responseBytes !== declaredLength) {
              rejectOnce(fail('response length did not match Content-Length', { code: 'TRUNCATED_RESPONSE', dispatched, indeterminate: isWrite, status })); return;
            }
            if (status < 200 || status >= 300) {
              // A REST controller or hook may reject after partial writes; an
              // HTTP error alone is not a rollback receipt, including 4xx.
              rejectOnce(fail('WordPress REST request failed', { code: 'HTTP_ERROR', dispatched, indeterminate: isWrite, status })); return;
            }
            try {
              const bytes = Buffer.concat(chunks);
              const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
              const value = JSON.parse(text);
              settled = true; cleanup(); resolve(value);
            } catch {
              rejectOnce(fail('response JSON is invalid', { code: 'INVALID_RESPONSE', dispatched, indeterminate: isWrite, status }));
            }
          });
        });
      } catch {
        rejectOnce(fail('request could not be created', { code: 'TRANSPORT_ERROR' })); return;
      }
      request.on('socket', (socket) => {
        if (!socket.encrypted) {
          if (socket.connecting) socket.once('connect', () => { transportReady = true; });
          else transportReady = true;
        } else if (socket.secureConnecting) {
          socket.once('secureConnect', () => { transportReady = true; });
        } else if (socket.authorized) {
          transportReady = true;
        }
      });
      request.on('error', (error) => {
        if (settled) return;
        const tlsError = ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(error?.code);
        const wasDispatched = dispatched && transportReady;
        rejectOnce(fail(tlsError ? 'TLS certificate verification failed' : 'request transport failed', {
          code: tlsError ? 'TLS_ERROR' : 'TRANSPORT_ERROR', dispatched: wasDispatched, indeterminate: isWrite && wasDispatched,
        }));
      });
      timer = setTimeout(() => {
        const wasDispatched = dispatched && transportReady;
        rejectOnce(fail('request deadline exceeded', { code: 'TIMEOUT', dispatched: wasDispatched, indeterminate: isWrite && wasDispatched }));
        request.destroy();
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      dispatched = true;
      request.end(body);
    });
  };
}

function createWordPressClient(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw fail('client options are required', { code: 'INVALID_ARGUMENT' });
  const { siteUrl, username, secret, signal, timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES, trustedCa } = options;
  const { origin, basePath } = parseSiteUrl(siteUrl);
  if (typeof username !== 'string' || !username || username.includes(':') || /[\u0000-\u001f\u007f]/u.test(username)
      || typeof secret !== 'string' || !secret || /[\u0000-\u001f\u007f]/u.test(secret)) {
    throw fail('username and secret must be non-empty strings without control characters', { code: 'INVALID_ARGUMENT' });
  }
  if (signal !== undefined && (typeof signal?.aborted !== 'boolean' || typeof signal?.addEventListener !== 'function')) throw fail('signal must be an AbortSignal', { code: 'INVALID_ARGUMENT' });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw fail('limits must be positive safe integers', { code: 'INVALID_ARGUMENT' });
  if (trustedCa !== undefined && !(Buffer.isBuffer(trustedCa) || typeof trustedCa === 'string')) throw fail('trustedCa must be a certificate string or Buffer', { code: 'INVALID_ARGUMENT' });
  const requestJson = createRequestJson({ origin, basePath, username, secret, signal, timeoutMs, maxResponseBytes, trustedCa });
  return {
    async probe() {
      const [index, user] = await Promise.all([
        requestJson({ route: '/' }),
        requestJson({ route: '/wp/v2/users/me', query: { context: 'edit' } }),
      ]);
      const routes = index?.routes && typeof index.routes === 'object' ? index.routes : {};
      for (const route of ['/wp/v2/posts', '/wp/v2/media']) {
        if (!Object.prototype.hasOwnProperty.call(routes, route)) throw fail(`WordPress REST route is unavailable: ${route}`, { code: 'MISSING_ROUTE' });
      }
      const ownerID = Number.isSafeInteger(user?.id) && user.id > 0 ? user.id : undefined;
      if (!ownerID || !user.capabilities || typeof user.capabilities !== 'object') throw fail('users/me response lacks owner identity or capabilities', { code: 'INVALID_RESPONSE' });
      const capabilities = {
        publish_posts: user.capabilities.publish_posts === true,
        upload_files: user.capabilities.upload_files === true,
      };
      for (const capability of Object.keys(capabilities)) {
        if (!capabilities[capability]) throw fail(`required WordPress capability is missing: ${capability}`, { code: 'MISSING_CAPABILITY', capability, ownerID });
      }
      return { ownerID, capabilities };
    },
    async getPost(id) {
      if (!Number.isSafeInteger(id) || id < 1) throw fail('post id must be a positive integer', { code: 'INVALID_ARGUMENT' });
      const post = await requestJson({ route: `/wp/v2/posts/${id}`, query: { context: 'edit' } });
      if (!Number.isSafeInteger(post?.id) || post.id !== id) throw fail('WordPress post response is invalid', { code: 'INVALID_RESPONSE' });
      return post;
    },
    async findPosts(criteria = {}) {
      if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) throw fail('post search must be an object', { code: 'INVALID_ARGUMENT' });
      const allowed = new Set(['search', 'slug', 'status', 'page', 'perPage']);
      if (Object.keys(criteria).some((key) => !allowed.has(key))) throw fail('post search fields are invalid', { code: 'INVALID_ARGUMENT' });
      if (criteria.search !== undefined && typeof criteria.search !== 'string') throw fail('search must be a string', { code: 'INVALID_ARGUMENT' });
      if (criteria.slug !== undefined && typeof criteria.slug !== 'string') throw fail('slug must be a string', { code: 'INVALID_ARGUMENT' });
      if (criteria.status !== undefined && !['draft', 'publish', 'any'].includes(criteria.status)) throw fail('search status is invalid', { code: 'INVALID_ARGUMENT' });
      const page = criteria.page === undefined ? 1 : criteria.page;
      const perPage = criteria.perPage === undefined ? 100 : criteria.perPage;
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100) throw fail('page and perPage are out of range', { code: 'INVALID_ARGUMENT' });
      const query = { context: 'edit', page, per_page: perPage };
      for (const key of ['search', 'slug', 'status']) if (criteria[key] !== undefined) query[key] = criteria[key];
      const posts = await requestJson({ route: '/wp/v2/posts', query });
      if (!Array.isArray(posts)) throw fail('WordPress post list response is invalid', { code: 'INVALID_RESPONSE' });
      return posts;
    },
    async createPost(post) {
      if (!post || typeof post !== 'object' || Array.isArray(post)) throw fail('post must be an object', { code: 'INVALID_ARGUMENT' });
      if (Object.keys(post).some((key) => !['title', 'content', 'status'].includes(key))) throw fail('post fields are invalid', { code: 'INVALID_ARGUMENT' });
      if (typeof post.title !== 'string' || typeof post.content !== 'string') throw fail('post title and content must be strings', { code: 'INVALID_ARGUMENT' });
      const status = post.status === undefined ? 'draft' : post.status;
      if (status !== 'draft' && status !== 'publish') throw fail('post status must be draft or publish', { code: 'INVALID_ARGUMENT' });
      const created = await requestJson({ route: '/wp/v2/posts', method: 'POST', jsonBody: { title: post.title, content: post.content, status } });
      if (!Number.isSafeInteger(created?.id) || created.id < 1) throw fail('WordPress write acknowledgement is invalid', { code: 'INVALID_ACKNOWLEDGEMENT', dispatched: true, indeterminate: true });
      return created;
    },
    async updatePost(id, fields) {
      if (!Number.isSafeInteger(id) || id < 1) throw fail('post id must be a positive integer', { code: 'INVALID_ARGUMENT' });
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw fail('post fields must be an object', { code: 'INVALID_ARGUMENT' });
      const allowed = new Set(['title', 'content', 'status']);
      const keys = Object.keys(fields);
      if (!keys.length || keys.some((key) => !allowed.has(key))) throw fail('post update fields are invalid', { code: 'INVALID_ARGUMENT' });
      const body = {};
      if (Object.hasOwn(fields, 'title')) {
        if (typeof fields.title !== 'string') throw fail('post title must be a string', { code: 'INVALID_ARGUMENT' });
        body.title = fields.title;
      }
      if (Object.hasOwn(fields, 'content')) {
        if (typeof fields.content !== 'string') throw fail('post content must be a string', { code: 'INVALID_ARGUMENT' });
        body.content = fields.content;
      }
      if (Object.hasOwn(fields, 'status')) {
        if (fields.status !== 'draft' && fields.status !== 'publish') throw fail('post status must be draft or publish', { code: 'INVALID_ARGUMENT' });
        body.status = fields.status;
      }
      const updated = await requestJson({ route: `/wp/v2/posts/${id}`, method: 'POST', jsonBody: body });
      if (!Number.isSafeInteger(updated?.id) || updated.id !== id) throw fail('WordPress write acknowledgement is invalid', { code: 'INVALID_ACKNOWLEDGEMENT', dispatched: true, indeterminate: true });
      return updated;
    },
    async uploadMedia(buffer, mime, filename) {
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw fail('media must be a non-empty Buffer', { code: 'INVALID_ARGUMENT' });
      if (typeof mime !== 'string' || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(mime)) throw fail('media MIME type is invalid', { code: 'INVALID_ARGUMENT' });
      const match = typeof filename === 'string' ? /^([a-f0-9]{64})(?:\.([A-Za-z0-9]{1,10}))?$/u.exec(filename) : null;
      if (!match || match[1] !== crypto.createHash('sha256').update(buffer).digest('hex')) throw fail('filename must be the ASCII SHA-256 content hash', { code: 'INVALID_ARGUMENT' });
      const media = await requestJson({ route: '/wp/v2/media', method: 'POST', rawBody: buffer, rawContentType: mime, filename });
      if (!Number.isSafeInteger(media?.id) || media.id < 1) throw fail('WordPress write acknowledgement is invalid', { code: 'INVALID_ACKNOWLEDGEMENT', dispatched: true, indeterminate: true });
      return media;
    },
  };
}

module.exports = { createWordPressClient, WordPressClientError };
