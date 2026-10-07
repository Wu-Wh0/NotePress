import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import http from 'node:http';

const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
if (!/^[0-9a-f]{32}$/.test(input.runId) || !/^[0-9a-f]{64}$/.test(input.compilerSha256)) throw new Error('invalid fresh runtime pins');
const [{ PHP, PHPRequestHandler, loadPHPRuntime }, php83, { bootWordPress }] = await Promise.all([
  import(pathToFileURL(path.join(input.modules, '@php-wasm/universal/index.js')).href),
  import(pathToFileURL(path.join(input.modules, '@php-wasm/node-8-3/index.js')).href),
  import(pathToFileURL(path.join(input.modules, '@wp-playground/wordpress/index.js')).href),
]);
const php = new PHP(await loadPHPRuntime(await php83.getPHPLoaderModule()));
const sitePath = `/wordpress/${input.runId}`;
const storePath = `/private/store/${input.runId}`;
const siteUrl = 'https://publication-v1.example.test';
const publisherToken = randomBytes(32).toString('hex');
const controlToken = randomBytes(32).toString('hex');
let handler;
let server;
let stopping = false;

function mkdirp(vfsPath) {
  let current = '';
  for (const part of vfsPath.split('/').filter(Boolean)) {
    current += '/' + part;
    if (!php.isDir(current)) php.mkdir(current);
  }
}
function copyTree(nativePath, vfsPath) {
  const stat = fs.lstatSync(nativePath);
  if (stat.isSymbolicLink()) throw new Error('cached input contains a symlink');
  if (stat.isDirectory()) {
    mkdirp(vfsPath);
    for (const name of fs.readdirSync(nativePath)) copyTree(path.join(nativePath, name), `${vfsPath}/${name}`);
    return;
  }
  if (!stat.isFile()) throw new Error('cached input contains a non-regular entry');
  mkdirp(path.posix.dirname(vfsPath));
  php.writeFile(vfsPath, new Uint8Array(fs.readFileSync(nativePath)));
}
function copyCore(nativeRoot) {
  mkdirp(sitePath);
  for (const name of fs.readdirSync(nativeRoot)) {
    if (name === 'wp-content' || name === 'wp-config.php' || name === 'wp-config-sample.php') continue;
    const source = path.join(nativeRoot, name);
    const stat = fs.lstatSync(source);
    if ((name === 'wp-admin' || name === 'wp-includes') && stat.isDirectory()) copyTree(source, `${sitePath}/${name}`);
    else if (stat.isFile() && name.endsWith('.php')) copyTree(source, `${sitePath}/${name}`);
  }
}
function jsonOutput(response, label) {
  if (response.exitCode !== 0 || response.errors) throw new Error(`${label} failed`);
  try { return JSON.parse(response.text); } catch { throw new Error(`${label} was not JSON`); }
}
function phpJson(code, label) {
  return php.run({ code }).then(response => jsonOutput(response, label));
}
async function wpRequest(method, route, body, actor = 'publisher') {
  const session = actor === 'reviewer' ? identities.reviewer : actor === 'otherPublisher' ? identities.otherPublisher : actor === 'publisher' ? identities.publisher : null;
  const headers = { accept: 'application/json' };
  if (session) {
    headers.cookie = session.cookie;
    headers['x-wp-nonce'] = session.nonce;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await handler.request({
    url: siteUrl + route,
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.httpStatusCode,
    headers: response.headers,
    bytes: Buffer.from(response.bytes),
    text: Buffer.from(response.bytes).toString('utf8'),
  };
}

let identities;
try {
  copyCore(input.wpCore);
  mkdirp(`${sitePath}/wp-content/plugins/publication-v1`);
  mkdirp('/internal/shared/mu-plugins');
  mkdirp(storePath);
  copyTree(input.serverPath, `${sitePath}/wp-content/plugins/publication-v1`);
  const config = `<?php\ndefine('DB_NAME', 'synthetic_${input.runId}');\ndefine('DB_USER', 'synthetic');\ndefine('DB_PASSWORD', 'synthetic');\ndefine('DB_HOST', 'localhost');\ndefine('BLOG_V1_STORE', '${storePath}');\ndefine('BLOG_V1_COMPILER_SHA256', '${input.compilerSha256}');\n$table_prefix = 'wp_';\nif (!defined('ABSPATH')) define('ABSPATH', __DIR__ . '/');\nrequire_once ABSPATH . 'wp-settings.php';\n`;
  php.writeFile(`${sitePath}/wp-config.php`, config);
  handler = new PHPRequestHandler({
    php,
    documentRoot: sitePath,
    absoluteUrl: siteUrl,
    cookieStore: false,
    rewriteRules: [{ match: new RegExp('^/wp-json/(.*)$'), replacement: '/index.php?rest_route=/$1' }],
  });
  const sqliteZip = new Uint8Array(fs.readFileSync(input.sqliteZip));
  await bootWordPress(handler, {
    siteUrl,
    phpVersion: '8.3',
    wordpressInstallMode: 'install-from-existing-files',
    sqliteIntegrationPluginZip: new File([sqliteZip], 'sqlite-database-integration.zip'),
  });
  const smokeCode = `<?php
    require_once '${sitePath}/wp-load.php';
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
    $admin = get_user_by('login', 'admin');
    if ($admin) wp_set_password(wp_generate_password(48, true, true), $admin->ID);
    $activation = activate_plugin('publication-v1/publication-v1.php');
    global $wpdb;
    echo json_encode(array(
      'complete_core_loaded' => function_exists('wp_kses_post') && function_exists('rest_do_request') && class_exists('WP_REST_Posts_Controller'),
      'database_engine' => defined('DB_ENGINE') ? DB_ENGINE : null,
      'database_query' => (int) $wpdb->get_var('SELECT 1'),
      'plugin_active' => !is_wp_error($activation) && is_plugin_active('publication-v1/publication-v1.php')
    ));
  `;
  const smoke = await phpJson(smokeCode, 'fresh WordPress bootstrap');
  if (!smoke.complete_core_loaded || smoke.database_engine !== 'sqlite' || smoke.database_query !== 1 || !smoke.plugin_active) throw new Error('fresh WordPress bootstrap assertions failed');

  identities = await phpJson(`<?php
    require_once '${sitePath}/wp-load.php';
    function pv1_session_create_actor($login, $capability) {
      $user_id = wp_insert_user(array('user_login' => $login, 'user_email' => $login . '@example.test', 'user_pass' => wp_generate_password(48, true, true), 'role' => 'subscriber'));
      if (is_wp_error($user_id)) throw new RuntimeException('synthetic actor creation failed');
      (new WP_User($user_id))->add_cap($capability);
      $expires = time() + HOUR_IN_SECONDS;
      $token = WP_Session_Tokens::get_instance($user_id)->create($expires);
      $cookie = wp_generate_auth_cookie($user_id, $expires, 'logged_in', $token);
      $_COOKIE[LOGGED_IN_COOKIE] = $cookie;
      wp_set_current_user($user_id);
      return array('id' => (int) $user_id, 'cookie' => LOGGED_IN_COOKIE . '=' . $cookie, 'nonce' => wp_create_nonce('wp_rest'));
    }
    $publisher = pv1_session_create_actor('synthetic-publisher-${input.runId}', 'publish_publication_v1');
    $reviewer = pv1_session_create_actor('synthetic-reviewer-${input.runId}', 'approve_publication_v1');
    $other_publisher = pv1_session_create_actor('synthetic-other-publisher-${input.runId}', 'publish_publication_v1');
    echo json_encode(array('publisher' => $publisher, 'reviewer' => $reviewer, 'otherPublisher' => $other_publisher));
  `, 'synthetic actor setup');
  if (!identities.publisher?.id || !identities.reviewer?.id || !identities.otherPublisher?.id
      || identities.publisher.id === identities.reviewer.id || identities.publisher.id === identities.otherPublisher.id
      || identities.reviewer.id === identities.otherPublisher.id) throw new Error('synthetic actors are not distinct');

  server = http.createServer(async (req, res) => {
    try {
      const local = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::ffff:127.0.0.1';
      if (!local) { res.writeHead(403); res.end(); return; }
      const lengthHeader = req.headers['content-length'];
      const length = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : 0;
      if (!Number.isSafeInteger(length) || length > 25165824 || req.headers['transfer-encoding']) { res.writeHead(413); res.end(); return; }
      const chunks = [];
      let total = 0;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > 25165824) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const control = req.headers['x-test-harness'] === controlToken;
      const publisher = req.headers['x-test-publisher'] === publisherToken;
      const route = req.url || '/';
      if (route === '/__test__/simulated-reviewer-approval' && req.method === 'POST' && control) {
        const value = JSON.parse(body.toString('utf8'));
        const result = await wpRequest('POST', '/wp-json/publication-v1/v1/approve', { id: value.id, digest: value.digest, decision: 'approve' }, 'reviewer');
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ SIMULATED: true, status: result.status, response: result.text }));
        return;
      }
      if (route === '/__test__/unapproved-commit-probe' && req.method === 'POST' && control) {
        const value = JSON.parse(body.toString('utf8'));
        const result = await wpRequest('POST', '/wp-json/publication-v1/v1/commit', { id: value.id, digest: value.digest }, 'publisher');
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ status: result.status, response: result.text }));
        return;
      }
      if (route === '/__test__/identity' && req.method === 'POST' && control) {
        const value = JSON.parse(body.toString('utf8'));
        const packageResult = await wpRequest('GET', `/wp-json/publication-v1/v1/packages/${value.package_id}`, undefined, 'publisher');
        const operationResult = await wpRequest('GET', `/wp-json/publication-v1/v1/operations/${value.operation_id}`, undefined, 'publisher');
        const packageData = packageResult.status === 200 ? JSON.parse(packageResult.text) : {};
        const operationData = operationResult.status === 200 ? JSON.parse(operationResult.text) : {};
        const result = {
          private_package_valid: packageResult.status === 200,
          package_query_status: packageResult.status,
          operation_query_status: operationResult.status,
          package_owner_exact: packageData.package_id === value.package_id && packageData.manifest_sha256 === value.package_id,
          package_manifest_sha256: packageData.manifest_sha256 || null,
          operation_state: operationData.state || null,
          publisher_id: identities.publisher.id,
          reviewer_id: identities.reviewer.id,
        };
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify(result));
        return;
      }
      if (route === '/__test__/snapshot-readback-probes' && req.method === 'POST' && control) {
        const value = JSON.parse(body.toString('utf8'));
        const snapshotRoute = `/wp-json/publication-v1/v1/operations/${value.id}/snapshot`;
        const publisherResult = await wpRequest('GET', snapshotRoute, undefined, 'publisher');
        const reviewerResult = await wpRequest('GET', snapshotRoute, undefined, 'reviewer');
        const otherPublisherResult = await wpRequest('GET', snapshotRoute, undefined, 'otherPublisher');
        const anonymousResult = await wpRequest('GET', snapshotRoute, undefined, 'anonymous');
        const phpProof = await phpJson(`<?php
          $_SERVER['DOCUMENT_ROOT'] = '${sitePath}';
          require_once '${sitePath}/wp-load.php';
          $found = pubv1_record_for_owner('${value.id}', ${identities.publisher.id});
          $record = is_array($found) ? $found[1] : false;
          $snapshot = is_array($record) ? ($record['snapshot'] ?? null) : null;
          $rendered = is_array($snapshot) ? ($snapshot['rendered'] ?? null) : null;
          $content = is_array($snapshot) ? ($snapshot['content'] ?? null) : null;
          $canonical = is_array($snapshot) ? pubv1_canonical_json($snapshot) : false;
          $unsupported_filter_output_rejected = false;
          $decoding_scope = array();
          if (is_string($content) && strpos($content, '<img ') !== false) {
            preg_match('~<img[^>]*>~', $content, $png_tag);
            $decoding_scope['pretty'] = pubv1_omit_snapshot_png_decoding_attr('async', $png_tag[0], 'the_content') === false;
            $ordinary = apply_filters('the_content', '<p><img src="https://example.test/ordinary.png" alt="ordinary"></p>');
            $decoding_scope['ordinary_unchanged'] = strpos($ordinary, 'decoding="async"') !== false;
            $foreign_tag = str_replace('https://publication-v1.example.test', 'https://foreign.example.test', $png_tag[0]);
            $decoding_scope['foreign_unchanged'] = pubv1_omit_snapshot_png_decoding_attr('async', $foreign_tag, 'the_content') === 'async';
            $query_url = static function ($url, $path) {
              return home_url('/?rest_route=' . rawurlencode('/' . ltrim($path, '/')));
            };
            add_filter('rest_url', $query_url, 10, 2);
            try {
              $png_path = null;
              foreach ($snapshot['inventory'] as $path => $asset) {
                if (pubv1_asset_mime($path) === 'image/png') { $png_path = $path; break; }
              }
              $query_tag = '<img src="' . htmlspecialchars(pubv1_resource_url('${value.id}', $png_path), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '">';
              $decoding_scope['query'] = pubv1_omit_snapshot_png_decoding_attr('async', $query_tag, 'the_content') === false;
              $missing_tag = '<img src="' . htmlspecialchars(pubv1_resource_url('${value.id}', 'assets/images/' . str_repeat('0', 64) . '.png'), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '">';
              $decoding_scope['missing_inventory_unchanged'] = pubv1_omit_snapshot_png_decoding_attr('async', $missing_tag, 'the_content') === 'async';
            } finally {
              remove_filter('rest_url', $query_url, 10);
            }
            $force_async = static function ($value, $image, $context) { return 'async'; };
            add_filter('wp_img_tag_add_decoding_attr', $force_async, 20, 3);
            try {
              $unsupported_filter_output_rejected = !pubv1_current($record);
            } finally {
              remove_filter('wp_img_tag_add_decoding_attr', $force_async, 20);
            }
          }
          echo json_encode(array(
            'rendered' => $rendered,
            'rendered_kses_unchanged' => is_string($rendered) && wp_kses_post($rendered) === $rendered,
            'rendered_matches_real_the_content' => is_string($rendered) && is_string($content) && apply_filters('the_content', $content) === $rendered,
            'decoding_scope' => $decoding_scope,
            'unsupported_filter_output_rejected' => $unsupported_filter_output_rejected,
            'snapshot_sha256' => is_string($canonical) ? hash('sha256', $canonical) : null
          ), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        `, 'frozen snapshot rendered proof');
        const cacheValue = publisherResult.headers?.['cache-control'] || publisherResult.headers?.['Cache-Control'] || [];
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({
          publisher_status: publisherResult.status,
          reviewer_status: reviewerResult.status,
          other_publisher_status: otherPublisherResult.status,
          anonymous_status: anonymousResult.status,
          snapshot_cache_control: Array.isArray(cacheValue) ? cacheValue.join(', ') : String(cacheValue),
          snapshot_json: publisherResult.status === 200 ? JSON.parse(publisherResult.text).snapshot_json : null,
          ...phpProof,
        }));
        return;
      }
      if (route === '/__test__/public-readback' && req.method === 'POST' && control) {
        const value = JSON.parse(body.toString('utf8'));
        const pre = await phpJson(`<?php
          $_SERVER['DOCUMENT_ROOT'] = '${sitePath}';
          require_once '${sitePath}/wp-load.php'; global $wpdb;
          $found = pubv1_record_for_owner('${value.operation_id}', ${identities.publisher.id});
          $record = is_array($found) ? $found[1] : false;
          $post_id = is_array($record) ? (int) ($record['post_id'] ?? 0) : 0;
          $post = $post_id ? get_post($post_id) : false;
          $count = (int) $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE meta_key = %s AND meta_value = %s", '_publication_v1_operation', '${value.operation_id}'));
          echo json_encode(array('state' => is_array($record) ? ($record['state'] ?? null) : null, 'post_id' => $post_id, 'db_exact' => $post instanceof WP_Post && $post->post_type === 'post' && $post->post_status === 'publish' && (int) $post->post_author === ${identities.publisher.id} && $post->post_title === '${value.title_php}' && $post->post_content === ($record['snapshot']['content'] ?? null), 'snapshot_rendered' => is_array($record) ? ($record['snapshot']['rendered'] ?? null) : null, 'one_post' => $count === 1, 'reviewer_distinct' => is_array($record) && (int) ($record['reviewer_id'] ?? 0) === ${identities.reviewer.id} && ${identities.publisher.id} !== ${identities.reviewer.id}));
        `, 'database publication readback');
        const core = await wpRequest('GET', `/wp-json/wp/v2/posts/${pre.post_id}`, undefined, 'anonymous');
        const assetPath = `/wp-json/publication-v1/v1/resources/${value.operation_id}/assets/images/${value.image_sha256}.png`;
        const resource = await wpRequest('GET', assetPath, undefined, 'anonymous');
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ ...pre, core_status: core.status, core: core.text, resource_status: resource.status, resource_bytes: resource.bytes.toString('base64'), resource_type: (resource.headers['content-type'] || [])[0] || null }));
        return;
      }
      if (!publisher) { res.writeHead(401, { connection: 'close' }); res.end(); return; }
      const headers = { accept: req.headers.accept || 'application/json', 'x-test-publisher': undefined };
      if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
      headers.cookie = identities.publisher.cookie;
      headers['x-wp-nonce'] = identities.publisher.nonce;
      const response = await handler.request({
        url: siteUrl + route,
        method: req.method,
        headers,
        ...(body.length ? { body: new Uint8Array(body) } : {}),
      });
      const outHeaders = {};
      for (const [name, values] of Object.entries(response.headers || {})) {
        if (/^(content-type|cache-control|x-content-type-options)$/i.test(name)) outHeaders[name] = Array.isArray(values) ? values.join(', ') : String(values);
      }
      outHeaders.connection = 'close';
      res.writeHead(response.httpStatusCode, outHeaders);
      res.end(Buffer.from(response.bytes));
    } catch (_error) {
      if (!res.headersSent) res.writeHead(500, { connection: 'close' });
      res.end('{"code":"isolated_wp_worker_failure"}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(JSON.stringify({ type: 'READY', port, publisherToken, controlToken }));
} catch (error) {
  console.error(`${error?.name || 'Error'}: ${error?.message || String(error)}`);
  try { if (server?.listening) await new Promise(resolve => server.close(resolve)); } catch {}
  try { if (handler) await handler[Symbol.asyncDispose](); } catch {}
  try { php.exit(); } catch {}
  process.exitCode = 2;
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  try { if (server?.listening) await new Promise(resolve => server.close(resolve)); } catch {}
  try { if (handler) await handler[Symbol.asyncDispose](); } catch {}
  try { php.exit(); } catch {}
}
process.once('SIGTERM', () => { shutdown().then(() => process.exit(0)); });
process.once('SIGINT', () => { shutdown().then(() => process.exit(0)); });
