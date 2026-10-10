import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const input = JSON.parse(Buffer.from(process.argv[2] === '-' ? fs.readFileSync(0, 'utf8') : process.argv[2], 'base64').toString('utf8'));
if (!/^[0-9a-f]{32}$/.test(input.runId)) throw new Error('invalid isolated run id');
if (!/^[0-9a-f]{64}$/.test(input.compilerSha256)) throw new Error('invalid compiler digest');
const [{ PHP, PHPRequestHandler, loadPHPRuntime }, php83, { bootWordPress }] = await Promise.all([
  import(pathToFileURL(path.join(input.modules, '@php-wasm/universal/index.js')).href),
  import(pathToFileURL(path.join(input.modules, '@php-wasm/node-8-3/index.js')).href),
  import(pathToFileURL(path.join(input.modules, '@wp-playground/wordpress/index.js')).href),
]);
const php = new PHP(await loadPHPRuntime(await php83.getPHPLoaderModule()));
const sitePath = `/wordpress/${input.runId}`;
const storePath = `/private/store/${input.runId}`;
const siteUrl = 'https://publication-v1.example.test';
let handler;

function mkdirp(vfsPath) {
  let current = '';
  for (const part of vfsPath.split('/').filter(Boolean)) {
    current += '/' + part;
    if (!php.isDir(current)) php.mkdir(current);
  }
}
function copyTree(nativePath, vfsPath) {
  const stat = fs.lstatSync(nativePath);
  if (stat.isSymbolicLink()) throw new Error('cached core contains a symlink; refusing to follow it');
  if (stat.isDirectory()) {
    mkdirp(vfsPath);
    for (const name of fs.readdirSync(nativePath)) copyTree(path.join(nativePath, name), `${vfsPath}/${name}`);
    return;
  }
  if (!stat.isFile()) throw new Error('cached core contains a non-regular entry');
  mkdirp(path.posix.dirname(vfsPath));
  php.writeFile(vfsPath, new Uint8Array(fs.readFileSync(nativePath)));
}
function copyCore(nativeRoot) {
  mkdirp(sitePath);
  for (const name of fs.readdirSync(nativeRoot)) {
    if (name === 'wp-content' || name === 'wp-config.php' || name === 'wp-config-sample.php') continue;
    const source = path.join(nativeRoot, name);
    const stat = fs.lstatSync(source);
    if ((name === 'wp-admin' || name === 'wp-includes') && stat.isDirectory()) {
      copyTree(source, `${sitePath}/${name}`);
    } else if (stat.isFile() && name.endsWith('.php')) {
      copyTree(source, `${sitePath}/${name}`);
    }
  }
}
function phpJsonResult(response, label) {
  if (response.exitCode !== 0 || response.errors) {
    throw new Error(`${label} failed (exit=${response.exitCode}): ${response.errors || response.text}`);
  }
  try { return JSON.parse(response.text); }
  catch { throw new Error(`${label} returned non-JSON output: ${response.text}`); }
}

try {
  copyCore(input.wpCore);
  mkdirp(`${sitePath}/wp-content/plugins/publication-v1`);
  mkdirp('/internal/shared/mu-plugins');
  mkdirp('/internal/shared/preload');
  mkdirp(storePath);
  for (const item of input.packages) copyTree(item.path, `${storePath}/${item.id}`);
  copyTree(input.serverPath, `${sitePath}/wp-content/plugins/publication-v1`);

  const config = `<?php\ndefine('DB_NAME', '${input.dbName}');\ndefine('DB_USER', 'synthetic');\ndefine('DB_PASSWORD', 'synthetic');\ndefine('DB_HOST', 'localhost');\ndefine('BLOG_V1_STORE', '${storePath}');\ndefine('BLOG_V1_COMPILER_SHA256', '${input.compilerSha256}');\n$table_prefix = 'wp_';\nif (!defined('ABSPATH')) define('ABSPATH', __DIR__ . '/');\nrequire_once ABSPATH . 'wp-settings.php';\n`;
  php.writeFile(`${sitePath}/wp-config.php`, config);
  handler = new PHPRequestHandler({ php, documentRoot: sitePath, absoluteUrl: siteUrl, cookieStore: false });
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
      'wordpress_version' => get_bloginfo('version'),
      'complete_core_loaded' => function_exists('wp_kses_post') && function_exists('rest_do_request') && class_exists('WP_REST_Posts_Controller'),
      'database_driver' => is_object($wpdb->dbh) ? get_class($wpdb->dbh) : gettype($wpdb->dbh),
      'database_engine' => defined('DB_ENGINE') ? DB_ENGINE : null,
      'sqlite_extension' => extension_loaded('pdo_sqlite') && class_exists('SQLite3'),
      'database_query' => (int) $wpdb->get_var('SELECT 1'),
      'plugin_active' => !is_wp_error($activation) && is_plugin_active('publication-v1/publication-v1.php'),
      'the_content_wpautop_registered' => has_filter('the_content', 'wpautop') !== false
    ), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
  `;
  const smoke = phpJsonResult(await php.run({ code: smokeCode }), 'WordPress bootstrap smoke assertion');
  if (!smoke.complete_core_loaded || smoke.database_engine !== 'sqlite' || smoke.database_query !== 1 || !smoke.plugin_active) {
    throw new Error(`WordPress bootstrap smoke assertion failed: ${JSON.stringify(smoke)}`);
  }
  console.log('PHP_WASM_SMOKE=' + JSON.stringify(smoke));

  const scenarioCodes = Array.isArray(input.phpCodes) ? input.phpCodes : [input.phpCode];
  const results = [];
  for (const encodedCode of scenarioCodes) {
    const result = phpJsonResult(
      await php.run({ code: Buffer.from(encodedCode, 'base64').toString('utf8') }),
      'publication-v1 scenario'
    );
    results.push(result);
    if (result.stop === true) break;
  }
  console.log('PHP_WASM_RESULT=' + JSON.stringify(results.length === 1 ? results[0] : results));
} catch (error) {
  console.error(`${error?.name || 'Error'}: ${error?.message || String(error)}`);
  process.exitCode = 2;
} finally {
  if (handler) {
    try { await handler[Symbol.asyncDispose](); } catch {}
  }
  php.exit();
}
