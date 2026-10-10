"""Bounded publication-v1 lifecycle across fresh PHP requests and SQLite."""
from __future__ import annotations

import base64
import json
from pathlib import Path
import tempfile
import unittest

from test_wordpress_runtime import RUNTIME_HOME, build_article, png_fixture, run_isolated_wordpress


PHP_STAGE_PREFIX = r'''<?php
$_SERVER['DOCUMENT_ROOT'] = dirname('__WP_LOAD__');
require_once '__WP_LOAD__';
do_action('rest_api_init', rest_get_server());
$input = json_decode(base64_decode('__INPUT_B64__'), true);
$GLOBALS['pubv1_kses_calls'] = 0;
$GLOBALS['pubv1_content_calls'] = 0;
add_filter('wp_kses_allowed_html', function ($tags, $context) {
    if ($context === 'post') { $GLOBALS['pubv1_kses_calls']++; }
    return $tags;
}, 10, 2);
add_filter('the_content', function ($content) {
    $GLOBALS['pubv1_content_calls']++;
    return $content;
}, PHP_INT_MAX, 1);
function pv1_test_response($response) {
    if ($response instanceof WP_REST_Response) {
        return array('status' => $response->get_status(), 'data' => $response->get_data());
    }
    if (is_wp_error($response)) {
        $data = $response->get_error_data();
        return array(
            'status' => is_array($data) ? (int) ($data['status'] ?? 0) : 0,
            'data' => array('code' => $response->get_error_code()),
        );
    }
    return array('status' => 0, 'data' => array());
}
function pv1_test_request($method, $route, $body = array(), $nonce = null) {
    $request = new WP_REST_Request($method, $route);
    $request->set_header('content-type', 'application/json');
    if (is_string($nonce)) { $request->set_header('X-WP-Nonce', $nonce); }
    if ($method !== 'GET') { $request->set_body(wp_json_encode($body)); }
    return pv1_test_response(rest_do_request($request));
}
function pv1_test_login($user_id) {
    $_COOKIE = array();
    $expires = time() + HOUR_IN_SECONDS;
    $token = WP_Session_Tokens::get_instance($user_id)->create($expires);
    $_COOKIE[LOGGED_IN_COOKIE] = wp_generate_auth_cookie($user_id, $expires, 'logged_in', $token);
    wp_set_current_user($user_id);
    return wp_create_nonce('wp_rest');
}
function pv1_test_user($login) {
    $existing = get_user_by('login', $login);
    if ($existing) { return (int) $existing->ID; }
    $user_id = wp_insert_user(array(
        'user_login' => $login,
        'user_email' => $login . '@example.test',
        'user_pass' => wp_generate_password(48, true, true),
        'role' => 'subscriber',
    ));
    if (is_wp_error($user_id)) { throw new RuntimeException('synthetic user setup failed'); }
    return (int) $user_id;
}
function pv1_test_remove_tree($path) {
    if (is_link($path) || (file_exists($path) && !is_dir($path))) return @unlink($path);
    if (!is_dir($path)) return true;
    foreach (scandir($path) as $name) {
        if ($name === '.' || $name === '..') continue;
        if (!pv1_test_remove_tree($path . DIRECTORY_SEPARATOR . $name)) return false;
    }
    return @rmdir($path);
}
'''

PREPARE_BODY = r'''
$publisher_id = pv1_test_user($input['publisher_login']);
$reviewer_id = pv1_test_user($input['reviewer_login']);
$publisher = new WP_User($publisher_id);
$publisher->add_cap('publish_publication_v1');
// The publisher is also the owner-confirmation actor; reviewer is a cross-owner negative.
$publisher->add_cap('approve_publication_v1');
(new WP_User($reviewer_id))->add_cap('approve_publication_v1');
$nonce = pv1_test_login($publisher_id);
$package_path = rtrim(BLOG_V1_STORE, '/') . '/' . $input['package_id'];
$manifest_raw = @file_get_contents($package_path . '/manifest.json');
$manifest = is_string($manifest_raw) ? json_decode($manifest_raw, true) : false;
$files = array();
$fixture_valid = is_array($manifest) && is_array($manifest['inventory'] ?? null);
if ($fixture_valid) {
    foreach ($manifest['inventory'] as $relative => $record) {
        $bytes = @file_get_contents($package_path . '/bundle/' . $relative);
        if (!is_string($bytes)) { $fixture_valid = false; break; }
        $files[$relative] = base64_encode($bytes);
    }
}
$fixture_removed = $fixture_valid && pv1_test_remove_tree($package_path);
$upload = $fixture_removed
    ? pv1_test_request('POST', '/publication-v1/v1/packages', array('manifest' => $manifest_raw, 'files' => $files), $nonce)
    : array('status' => 0, 'data' => array());
$package_query = pv1_test_request('GET', '/publication-v1/v1/packages/' . $input['package_id'], array(), $nonce);
$loaded = pubv1_load_package($input['package_id']);
$package_bytes_exact = is_array($loaded);
if ($package_bytes_exact) {
    foreach ($files as $path => $encoded) {
        $expected_bytes = base64_decode($encoded, true);
        if (!is_string($expected_bytes) || !isset($loaded['_inventory_bytes'][$path])
            || !hash_equals($expected_bytes, $loaded['_inventory_bytes'][$path])) {
            $package_bytes_exact = false;
            break;
        }
    }
}
$owner = pubv1_package_owner_record($input['package_id']);
$package_owner_exact = is_array($owner)
    && ($owner['package_id'] ?? '') === $input['package_id']
    && (int) ($owner['publisher_id'] ?? 0) === (int) $publisher_id
    && (int) ($owner['site_id'] ?? 0) === (int) get_current_blog_id();
$preview = is_array($loaded) ? pubv1_preview_body($loaded['_inventory_bytes']['preview.html'], $input['title']) : false;
$content = is_string($preview) ? pubv1_content_for_operation($input['operation_id'], $preview, $loaded['inventory']) : false;
$sanitized = is_string($content) ? wp_kses_post($content) : false;
$katex_visual_html_preserved = is_string($content)
    && strpos($content, 'class="katex-html"') !== false
    && strpos($content, 'class="mfrac"') !== false
    && strpos($content, 'style="height:') !== false
    && strpos($content, 'vertical-align:') !== false;
$katex_mathml_preserved = is_string($content)
    && strpos($content, '<mfrac><mi>a</mi><mi>b</mi></mfrac><mo>+</mo><msup><mi>x</mi><mn>2</mn></msup>') !== false;
$preflight_ok = is_string($content)
    && $sanitized === $content
    && $katex_visual_html_preserved
    && $katex_mathml_preserved
    && $fixture_removed
    && $upload['status'] === 201
    && $package_query['status'] === 200
    && ($package_query['data']['package_id'] ?? null) === $input['package_id']
    && $package_bytes_exact
    && $package_owner_exact
    && is_array(pubv1_freeze($input['operation_id'], $input['package_id'], $input['title'], $publisher_id, time() + 300));
$preflight = array(
    'pre_staged_fixture_removed_before_upload' => $fixture_removed,
    'private_package_upload_status' => $upload['status'],
    'private_package_query_status' => $package_query['status'],
    'private_package_query_identity_exact' => ($package_query['data']['package_id'] ?? null) === $input['package_id'],
    'private_package_bytes_exact' => $package_bytes_exact,
    'private_package_owner_exact' => $package_owner_exact,
    'package_valid' => is_array($loaded),
    'producer_cms_content_valid' => is_string($content),
    'real_kses_unchanged' => is_string($content) && $sanitized === $content,
    'katex_visual_html_preserved' => $katex_visual_html_preserved,
    'katex_mathml_preserved' => $katex_mathml_preserved,
    'content_sha256' => is_string($content) ? hash('sha256', $content) : null,
    'sanitized_sha256' => is_string($sanitized) ? hash('sha256', $sanitized) : null,
);
if (!$preflight_ok) {
    echo json_encode(array(
        'stage' => 'prepare', 'preflight' => $preflight,
        'pre_staged_fixture_removed_before_upload' => $fixture_removed,
        'private_package_upload_status' => $upload['status'],
        'private_package_query_status' => $package_query['status'],
        'private_package_query_identity_exact' => ($package_query['data']['package_id'] ?? null) === $input['package_id'],
        'private_package_bytes_exact' => $package_bytes_exact,
        'private_package_owner_exact' => $package_owner_exact,
        'lifecycle_attempted' => false, 'stop' => true
    ));
    return;
}
$core_bypass = pv1_test_request('POST', '/wp/v2/posts', array(
    'title' => 'synthetic forbidden core REST create',
    'content' => 'synthetic bypass attempt',
    'status' => 'publish',
));
$create = pv1_test_request('POST', '/publication-v1/v1/operations', array(
    'id' => $input['operation_id'],
    'title' => $input['title'],
    'expires_at' => time() + 300,
    'manifest_sha256' => $input['package_id'],
));
$digest = $create['data']['digest'] ?? '';
$option_key = pubv1_option_key($input['operation_id']);
$pending = maybe_unserialize(pubv1_read_raw_option($option_key));
$unapproved = pv1_test_request('POST', '/publication-v1/v1/commit', array(
    'id' => $input['operation_id'], 'digest' => $digest,
));
$reviewer_nonce = pv1_test_login($reviewer_id);
$cross_owner_approval = pv1_test_request('POST', '/publication-v1/v1/approve', array(
    'id' => $input['operation_id'], 'digest' => $digest, 'decision' => 'approve',
), $reviewer_nonce);
$owner_nonce = pv1_test_login($publisher_id);
$missing_nonce_approval = pv1_test_request('POST', '/publication-v1/v1/approve', array(
    'id' => $input['operation_id'], 'digest' => $digest, 'decision' => 'approve',
));
$_COOKIE = array();
wp_set_current_user($publisher_id);
$missing_cookie_approval = pv1_test_request('POST', '/publication-v1/v1/approve', array(
    'id' => $input['operation_id'], 'digest' => $digest, 'decision' => 'approve',
), $owner_nonce);
$nonce = pv1_test_login($publisher_id);
$_COOKIE = array();
wp_set_current_user(0);
$asset_path = 'assets/images/' . $input['image_sha256'] . '.png';
$resource_route = '/publication-v1/v1/resources/' . $input['operation_id'] . '/' . $asset_path;
$anonymous_resource = pv1_test_request('GET', $resource_route);
echo json_encode(array(
    'stage' => 'prepare',
    'bootstrap_complete' => true,
    'preflight' => $preflight,
    'pre_staged_fixture_removed_before_upload' => $fixture_removed,
    'private_package_upload_status' => $upload['status'],
    'private_package_query_status' => $package_query['status'],
    'private_package_query_identity_exact' => ($package_query['data']['package_id'] ?? null) === $input['package_id'],
    'private_package_bytes_exact' => $package_bytes_exact,
    'private_package_owner_exact' => $package_owner_exact,
    'lifecycle_attempted' => true,
    'publisher_id' => $publisher_id,
    'other_owner_id' => $reviewer_id,
    'core_rest_bypass_status' => $core_bypass['status'],
    'operation_create_status' => $create['status'],
    'operation_pending_in_sqlite' => is_array($pending) && ($pending['state'] ?? '') === 'pending',
    'unapproved_commit_status' => $unapproved['status'],
    'cross_owner_approval_status' => $cross_owner_approval['status'],
    'missing_nonce_approval_status' => $missing_nonce_approval['status'],
    'missing_cookie_approval_status' => $missing_cookie_approval['status'],
    'precommit_anonymous_resource_status' => $anonymous_resource['status'],
    'real_kses_filter_calls' => $GLOBALS['pubv1_kses_calls'],
    'real_the_content_filter_calls' => $GLOBALS['pubv1_content_calls'],
), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
'''

APPROVE_BODY = r'''
$publisher = get_user_by('login', $input['publisher_login']);
$publisher_id = $publisher ? (int) $publisher->ID : 0;
$option_key = pubv1_option_key($input['operation_id']);
$pending = maybe_unserialize(pubv1_read_raw_option($option_key));
$digest = is_array($pending) ? ($pending['digest'] ?? '') : '';
$nonce = pv1_test_login($publisher_id);
$approval = pv1_test_request('POST', '/publication-v1/v1/approve', array(
    'id' => $input['operation_id'],
    'digest' => $digest,
    'decision' => 'approve',
), $nonce);
$record = maybe_unserialize(pubv1_read_raw_option(pubv1_option_key($input['operation_id'])));
$asset_path = 'assets/images/' . $input['image_sha256'] . '.png';
$route = '/publication-v1/v1/resources/' . $input['operation_id'] . '/' . $asset_path;
$resource = pv1_test_request('GET', $route);
$data = $resource['data'];
$bytes = isset($data['_publication_v1_bytes']) ? base64_decode($data['_publication_v1_bytes'], true) : false;
$loaded = pubv1_load_package($input['package_id']);
$expected = $loaded['_inventory_bytes'][$asset_path] ?? false;
echo json_encode(array(
    'stage' => 'approve',
    'owner_approval_status' => $approval['status'],
    'recorded_approval_owner_id' => is_array($record) ? (int) ($record['reviewer_id'] ?? 0) : 0,
    'snapshot_owner_id' => is_array($record) ? (int) ($record['snapshot']['publisher_id'] ?? 0) : 0,
    'operation_state' => is_array($record) ? ($record['state'] ?? null) : null,
    'owner_resource_status' => $resource['status'],
    'owner_resource_private' => isset($data['_publication_v1_public']) && $data['_publication_v1_public'] === false,
    'owner_resource_exact_bytes' => is_string($bytes) && is_string($expected) && hash_equals($expected, $bytes),
    'owner_resource_mime' => $data['_publication_v1_mime'] ?? null,
    'owner_resource_bytes' => is_string($bytes) ? strlen($bytes) : null,
    'owner_resource_sha256' => is_string($bytes) ? hash('sha256', $bytes) : null,
    'real_kses_filter_calls' => $GLOBALS['pubv1_kses_calls'],
    'real_the_content_filter_calls' => $GLOBALS['pubv1_content_calls'],
), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
'''

COMMIT_BODY = r'''
$publisher = get_user_by('login', $input['publisher_login']);
$reviewer = get_user_by('login', $input['reviewer_login']);
$publisher_id = $publisher ? (int) $publisher->ID : 0;
$reviewer_id = $reviewer ? (int) $reviewer->ID : 0;
$option_key = pubv1_option_key($input['operation_id']);
$approved = maybe_unserialize(pubv1_read_raw_option($option_key));
$digest = is_array($approved) ? ($approved['digest'] ?? '') : '';
pv1_test_login($publisher_id);
$commit = pv1_test_request('POST', '/publication-v1/v1/commit', array(
    'id' => $input['operation_id'], 'digest' => $digest,
));
$post_id = (int) ($commit['data']['post_id'] ?? 0);
$post = $post_id ? get_post($post_id) : false;
$raw_record = maybe_unserialize(pubv1_read_raw_option($option_key));
$retry = pv1_test_request('POST', '/publication-v1/v1/commit', array(
    'id' => $input['operation_id'], 'digest' => $digest,
));
$meta_count = (int) $GLOBALS['wpdb']->get_var($GLOBALS['wpdb']->prepare(
    "SELECT COUNT(*) FROM {$GLOBALS['wpdb']->postmeta} WHERE meta_key = %s AND meta_value = %s",
    '_publication_v1_operation', $input['operation_id']
));
$core_readback = pv1_test_request('GET', '/wp/v2/posts/' . $post_id);
$_COOKIE = array();
wp_set_current_user(0);
$asset_path = 'assets/images/' . $input['image_sha256'] . '.png';
$resource = pv1_test_request('GET', '/publication-v1/v1/resources/' . $input['operation_id'] . '/' . $asset_path);
$data = $resource['data'];
$bytes = isset($data['_publication_v1_bytes']) ? base64_decode($data['_publication_v1_bytes'], true) : false;
$loaded = pubv1_load_package($input['package_id']);
$expected = $loaded['_inventory_bytes'][$asset_path] ?? false;
$cas_key = 'pubv1_test_cas_' . $input['operation_id'];
$cas_seeded = add_option($cas_key, 'cas-before', '', false);
$cas_raw = pubv1_read_raw_option($cas_key);
$cas_first = is_string($cas_raw) && pubv1_cas_option($cas_key, $cas_raw, 'cas-after');
$cas_stale_rejected = is_string($cas_raw) && !pubv1_cas_option($cas_key, $cas_raw, 'cas-stale');
$cas_readback = pubv1_read_raw_option($cas_key);
delete_option($cas_key);
$post_exact = $post instanceof WP_Post
    && $post->post_type === 'post'
    && $post->post_status === 'publish'
    && (int) $post->post_author === $publisher_id
    && $post->post_title === $input['title']
    && $post->post_content === ($raw_record['snapshot']['content'] ?? null)
    && get_post_meta($post_id, '_publication_v1_operation', true) === $input['operation_id'];
$record_exact = is_array($raw_record)
    && ($raw_record['state'] ?? '') === 'committed'
    && (int) ($raw_record['post_id'] ?? 0) === $post_id
    && (int) ($raw_record['snapshot']['publisher_id'] ?? 0) === $publisher_id
    && (int) ($raw_record['reviewer_id'] ?? 0) === $publisher_id;
$core_exact = $core_readback['status'] === 200
    && (int) ($core_readback['data']['id'] ?? 0) === $post_id
    && ($core_readback['data']['status'] ?? '') === 'publish'
    && ($core_readback['data']['content']['rendered'] ?? null) === ($raw_record['snapshot']['rendered'] ?? null);
$resource_cache = get_option($option_key);
echo json_encode(array(
    'stage' => 'commit',
    'commit_status' => $commit['status'],
    'same_operation_retry_status' => $retry['status'],
    'same_post_on_retry' => $post_id > 0 && (int) ($retry['data']['post_id'] ?? 0) === $post_id,
    'post_id' => $post_id,
    'exact_database_post_readback' => $post_exact,
    'exact_database_operation_readback' => $record_exact,
    'one_post_for_operation' => $meta_count === 1,
    'core_rest_public_readback_exact' => $core_exact,
    'public_resource_status' => $resource['status'],
    'public_resource_exact_bytes' => is_string($bytes) && is_string($expected) && hash_equals($expected, $bytes),
    'public_resource_mime' => $data['_publication_v1_mime'] ?? null,
    'public_resource_bytes' => is_string($bytes) ? strlen($bytes) : null,
    'public_resource_sha256' => is_string($bytes) ? hash('sha256', $bytes) : null,
    'raw_db_state' => is_array($raw_record) ? ($raw_record['state'] ?? null) : null,
    'request_local_option_state' => is_array($resource_cache) ? ($resource_cache['state'] ?? null) : null,
    'sqlite_cas_seeded' => $cas_seeded,
    'sqlite_cas_first_update' => $cas_first,
    'sqlite_cas_stale_update_rejected' => $cas_stale_rejected,
    'sqlite_cas_readback' => $cas_readback,
    'real_kses_filter_calls' => $GLOBALS['pubv1_kses_calls'],
    'real_the_content_filter_calls' => $GLOBALS['pubv1_content_calls'],
), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
'''


READBACK_BODY = r'''
$publisher = get_user_by('login', $input['publisher_login']);
$reviewer = get_user_by('login', $input['reviewer_login']);
$publisher_id = $publisher ? (int) $publisher->ID : 0;
$reviewer_id = $reviewer ? (int) $reviewer->ID : 0;
$option_key = pubv1_option_key($input['operation_id']);
$record = maybe_unserialize(pubv1_read_raw_option($option_key));
$post_id = is_array($record) ? (int) ($record['post_id'] ?? 0) : 0;
$post = $post_id ? get_post($post_id) : false;
$meta_count = (int) $GLOBALS['wpdb']->get_var($GLOBALS['wpdb']->prepare(
    "SELECT COUNT(*) FROM {$GLOBALS['wpdb']->postmeta} WHERE meta_key = %s AND meta_value = %s",
    '_publication_v1_operation', $input['operation_id']
));
$_COOKIE = array();
wp_set_current_user(0);
$core_readback = pv1_test_request('GET', '/wp/v2/posts/' . $post_id);
$asset_path = 'assets/images/' . $input['image_sha256'] . '.png';
$resource = pv1_test_request('GET', '/publication-v1/v1/resources/' . $input['operation_id'] . '/' . $asset_path);
$data = $resource['data'];
$bytes = isset($data['_publication_v1_bytes']) ? base64_decode($data['_publication_v1_bytes'], true) : false;
$loaded = pubv1_load_package($input['package_id']);
$expected = is_array($loaded) ? ($loaded['_inventory_bytes'][$asset_path] ?? false) : false;
$post_exact = $post instanceof WP_Post
    && $post->post_type === 'post'
    && $post->post_status === 'publish'
    && (int) $post->post_author === $publisher_id
    && $post->post_title === $input['title']
    && $post->post_content === ($record['snapshot']['content'] ?? null)
    && get_post_meta($post_id, '_publication_v1_operation', true) === $input['operation_id'];
$record_exact = is_array($record)
    && ($record['state'] ?? '') === 'committed'
    && (int) ($record['post_id'] ?? 0) === $post_id
    && (int) ($record['snapshot']['publisher_id'] ?? 0) === $publisher_id
    && (int) ($record['reviewer_id'] ?? 0) === $publisher_id;
$core_exact = $core_readback['status'] === 200
    && (int) ($core_readback['data']['id'] ?? 0) === $post_id
    && ($core_readback['data']['status'] ?? '') === 'publish'
    && ($core_readback['data']['content']['rendered'] ?? null) === ($record['snapshot']['rendered'] ?? null);
echo json_encode(array(
    'stage' => 'fresh_public_readback',
    'operation_state' => is_array($record) ? ($record['state'] ?? null) : null,
    'exact_database_post_readback' => $post_exact,
    'exact_database_operation_readback' => $record_exact,
    'one_post_for_operation' => $meta_count === 1,
    'core_public_readback_status' => $core_readback['status'],
    'core_public_readback_exact' => $core_exact,
    'public_resource_status' => $resource['status'],
    'public_resource_exact_bytes' => is_string($bytes) && is_string($expected) && hash_equals($expected, $bytes),
    'public_resource_mime' => $data['_publication_v1_mime'] ?? null,
    'public_resource_bytes' => is_string($bytes) ? strlen($bytes) : null,
    'public_resource_sha256' => is_string($bytes) ? hash('sha256', $bytes) : null,
), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
'''


def stage_code(body: str, payload: dict) -> str:
    return (
        PHP_STAGE_PREFIX.replace("__WP_LOAD__", "/wordpress/PLACEHOLDER/wp-load.php")
        .replace("__INPUT_B64__", base64.b64encode(json.dumps(payload, ensure_ascii=False).encode()).decode())
        + body
    )


class RealWordPressPublicationLifecycleTests(unittest.TestCase):
    def test_simulated_owner_approval_publication_lifecycle_uses_fresh_sqlite_requests(self) -> None:
        RUNTIME_HOME.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="lifecycle-", dir=RUNTIME_HOME) as tmp:
            root = Path(tmp)
            case = build_article(
                root,
                "lifecycle",
                "文章/子目录/完整闭环.md",
                "合成发布闭环验收",
                "# 合成文章\n\n中文正文与 [HTTP 链接](https://example.test/path)。\n\n![批准图片](图.png)\n\n行内公式 $\\frac{a}{b} + x^2$。\n",
                with_png=True,
            )
            payload = {
                "publisher_login": "synthetic-publisher-" + case["operation_id"],
                "reviewer_login": "synthetic-reviewer-" + case["operation_id"],
                "title": case["title"],
                "package_id": case["package_id"],
                "operation_id": case["operation_id"],
                "image_sha256": case["image_sha256"],
            }
            stages = [
                stage_code(PREPARE_BODY, payload),
                stage_code(APPROVE_BODY, payload),
                stage_code(COMMIT_BODY, payload),
                stage_code(READBACK_BODY, payload),
            ]
            smoke, results = run_isolated_wordpress([case], stages)
            summary = {"smoke": smoke, "stages": results}
            print("WORDPRESS_LIFECYCLE_SUMMARY=" + json.dumps(summary, ensure_ascii=False, sort_keys=True))
            self.assertTrue(smoke["complete_core_loaded"], summary)
            self.assertEqual(smoke["database_engine"], "sqlite", summary)
            self.assertIn("SQLite", smoke["database_driver"], summary)
            self.assertTrue(smoke["plugin_active"], summary)
            self.assertIsInstance(results, list, summary)
            self.assertEqual(len(results), 4, summary)
            prepare, approve, commit, readback = results
            self.assertTrue(prepare["pre_staged_fixture_removed_before_upload"], summary)
            self.assertEqual(prepare["private_package_upload_status"], 201, summary)
            self.assertEqual(prepare["private_package_query_status"], 200, summary)
            self.assertTrue(prepare["private_package_query_identity_exact"], summary)
            self.assertTrue(prepare["private_package_bytes_exact"], summary)
            self.assertTrue(prepare["private_package_owner_exact"], summary)
            self.assertTrue(prepare["preflight"]["private_package_bytes_exact"], summary)
            self.assertTrue(prepare["bootstrap_complete"], summary)
            self.assertTrue(prepare["preflight"]["package_valid"], summary)
            self.assertTrue(prepare["preflight"]["producer_cms_content_valid"], summary)
            self.assertTrue(prepare["preflight"]["katex_visual_html_preserved"], summary)
            self.assertTrue(prepare["preflight"]["katex_mathml_preserved"], summary)
            self.assertTrue(
                prepare["preflight"]["real_kses_unchanged"],
                "Lifecycle blocked by real fail-closed KSES; no sanitizer bypass was applied: "
                + json.dumps(summary, ensure_ascii=False, sort_keys=True),
            )
            self.assertTrue(prepare["lifecycle_attempted"], summary)
            self.assertGreater(prepare["publisher_id"], 0, summary)
            self.assertGreater(prepare["other_owner_id"], 0, summary)
            self.assertNotEqual(prepare["publisher_id"], prepare["other_owner_id"], summary)
            self.assertIn(prepare["core_rest_bypass_status"], (401, 403), summary)
            self.assertEqual(prepare["operation_create_status"], 201, summary)
            self.assertTrue(prepare["operation_pending_in_sqlite"], summary)
            self.assertEqual(prepare["unapproved_commit_status"], 409, summary)
            self.assertEqual(prepare["cross_owner_approval_status"], 403, summary)
            self.assertEqual(prepare["missing_nonce_approval_status"], 403, summary)
            self.assertEqual(prepare["missing_cookie_approval_status"], 403, summary)
            self.assertEqual(prepare["precommit_anonymous_resource_status"], 404, summary)
            self.assertEqual(approve["owner_approval_status"], 200, summary)
            self.assertEqual(approve["operation_state"], "approved", summary)
            self.assertEqual(approve["recorded_approval_owner_id"], prepare["publisher_id"], summary)
            self.assertEqual(approve["snapshot_owner_id"], prepare["publisher_id"], summary)
            self.assertEqual(approve["owner_resource_status"], 200, summary)
            self.assertTrue(approve["owner_resource_private"], summary)
            self.assertTrue(approve["owner_resource_exact_bytes"], summary)
            self.assertEqual(approve["owner_resource_mime"], "image/png", summary)
            self.assertEqual(approve["owner_resource_bytes"], len(png_fixture()), summary)
            self.assertEqual(approve["owner_resource_sha256"], case["image_sha256"], summary)
            self.assertEqual(commit["commit_status"], 200, summary)
            self.assertEqual(commit["same_operation_retry_status"], 200, summary)
            self.assertTrue(commit["same_post_on_retry"], summary)
            self.assertTrue(commit["exact_database_post_readback"], summary)
            self.assertTrue(commit["exact_database_operation_readback"], summary)
            self.assertTrue(commit["one_post_for_operation"], summary)
            self.assertTrue(commit["core_rest_public_readback_exact"], summary)
            self.assertEqual(commit["public_resource_status"], 200, summary)
            self.assertTrue(commit["public_resource_exact_bytes"], summary)
            self.assertEqual(commit["public_resource_mime"], "image/png", summary)
            self.assertEqual(commit["public_resource_bytes"], len(png_fixture()), summary)
            self.assertEqual(commit["public_resource_sha256"], case["image_sha256"], summary)
            self.assertEqual(commit["raw_db_state"], "committed", summary)
            self.assertEqual(commit["request_local_option_state"], "committed", summary)
            self.assertTrue(commit["sqlite_cas_seeded"], summary)
            self.assertTrue(commit["sqlite_cas_first_update"], summary)
            self.assertTrue(commit["sqlite_cas_stale_update_rejected"], summary)
            self.assertEqual(commit["sqlite_cas_readback"], "cas-after", summary)
            self.assertEqual(readback["stage"], "fresh_public_readback", summary)
            self.assertEqual(readback["operation_state"], "committed", summary)
            self.assertTrue(readback["exact_database_post_readback"], summary)
            self.assertTrue(readback["exact_database_operation_readback"], summary)
            self.assertTrue(readback["one_post_for_operation"], summary)
            self.assertEqual(readback["core_public_readback_status"], 200, summary)
            self.assertTrue(readback["core_public_readback_exact"], summary)
            self.assertEqual(readback["public_resource_status"], 200, summary)
            self.assertTrue(readback["public_resource_exact_bytes"], summary)
            self.assertEqual(readback["public_resource_mime"], "image/png", summary)
            self.assertEqual(readback["public_resource_bytes"], len(png_fixture()), summary)
            self.assertEqual(readback["public_resource_sha256"], case["image_sha256"], summary)
            self.assertGreater(prepare["real_kses_filter_calls"], 0, summary)
            self.assertGreater(commit["real_the_content_filter_calls"], 0, summary)


if __name__ == "__main__":
    unittest.main()
