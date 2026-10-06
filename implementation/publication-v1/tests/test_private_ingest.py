"""Authenticated package receive/query against a fresh PHP-WASM WordPress."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

from test_wordpress_runtime import RUNTIME_HOME, build_article, run_isolated_wordpress

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path(tempfile.gettempdir()) / "publication-v1-ingest-output"
EVIDENCE = OUTPUT / "latest.json"

PHP_SCENARIO = r'''<?php
$_SERVER['DOCUMENT_ROOT'] = dirname('__WP_LOAD__');
require_once '__WP_LOAD__';
do_action('rest_api_init', rest_get_server());
$input = json_decode(base64_decode('__INPUT_B64__'), true);
function ingest_test_response($value) {
    if ($value instanceof WP_REST_Response) {
        return array('status' => $value->get_status(), 'data' => $value->get_data());
    }
    if (is_wp_error($value)) {
        $error_data = $value->get_error_data();
        return array(
            'status' => is_array($error_data) ? (int) ($error_data['status'] ?? 0) : 0,
            'data' => array('code' => $value->get_error_code()),
        );
    }
    return array('status' => 0, 'data' => array());
}
function ingest_test_request($method, $route, $body = null) {
    $request = new WP_REST_Request($method, $route);
    if ($body !== null) {
        $request->set_header('content-type', 'application/json');
        $request->set_body(wp_json_encode($body));
    }
    return ingest_test_response(rest_do_request($request));
}
function ingest_test_remove_tree($path) {
    if (is_link($path) || (file_exists($path) && !is_dir($path))) return @unlink($path);
    if (!is_dir($path)) return true;
    foreach (scandir($path) as $name) {
        if ($name === '.' || $name === '..') continue;
        if (!ingest_test_remove_tree($path . DIRECTORY_SEPARATOR . $name)) return false;
    }
    return @rmdir($path);
}
$publisher_id = wp_insert_user(array(
    'user_login' => $input['publisher_login'],
    'user_email' => $input['publisher_login'] . '@example.test',
    'user_pass' => wp_generate_password(48, true, true),
    'role' => 'subscriber',
));
if (is_wp_error($publisher_id)) throw new RuntimeException('synthetic publisher setup failed');
(new WP_User($publisher_id))->add_cap('publish_publication_v1');
wp_set_current_user((int) $publisher_id);
$legacy_operation_id = str_repeat('a', 32);
$legacy_denied = ingest_test_request('POST', '/publication-v1/v1/operations', array(
    'id' => $legacy_operation_id,
    'title' => $input['legacy_title'],
    'expires_at' => time() + 300,
    'manifest_sha256' => $input['legacy_package_id'],
));
$legacy_operation_absent_before_seed = pubv1_read_raw_option(pubv1_option_key($legacy_operation_id)) === null;
$legacy_seeded = add_option(pubv1_package_owner_option_key($input['legacy_package_id']), array(
    'schema' => 'publication-v1-package-owner',
    'package_id' => $input['legacy_package_id'],
    'site_id' => (int) get_current_blog_id(),
    'publisher_id' => (int) $publisher_id,
), '', false);
$legacy_allowed = ingest_test_request('POST', '/publication-v1/v1/operations', array(
    'id' => $legacy_operation_id,
    'title' => $input['legacy_title'],
    'expires_at' => time() + 300,
    'manifest_sha256' => $input['legacy_package_id'],
));
// The shared harness preloads producer fixtures; remove this one so receive is a fresh install.
$package_path = rtrim(BLOG_V1_STORE, '/') . '/' . $input['package_id'];
$manifest_raw = @file_get_contents($package_path . '/manifest.json');
$manifest = is_string($manifest_raw) ? json_decode($manifest_raw, true) : false;
if (!is_array($manifest) || !is_array($manifest['inventory'] ?? null)) throw new RuntimeException('synthetic package fixture invalid');
$files = array();
foreach ($manifest['inventory'] as $relative => $record) {
    $bytes = @file_get_contents($package_path . '/bundle/' . $relative);
    if (!is_string($bytes)) throw new RuntimeException('synthetic package fixture resource missing');
    $files[$relative] = base64_encode($bytes);
}
$payload = array('manifest' => $manifest_raw, 'files' => $files);
$fixture_removed = ingest_test_remove_tree($package_path);
$first_path = array_key_first($files);
$bad_extra = $payload;
$bad_extra['files']['assets/unlisted.png'] = base64_encode('unlisted');
$extra_result = ingest_test_request('POST', '/publication-v1/v1/packages', $bad_extra);
$bad_missing = $payload;
unset($bad_missing['files'][$first_path]);
$missing_result = ingest_test_request('POST', '/publication-v1/v1/packages', $bad_missing);
$bad_corrupt = $payload;
$bad_corrupt['files'][$first_path] = base64_encode('corrupted resource');
$corrupt_result = ingest_test_request('POST', '/publication-v1/v1/packages', $bad_corrupt);
$bad_traversal = $payload;
unset($bad_traversal['files'][$first_path]);
$bad_traversal['files']['../escape.css'] = $payload['files'][$first_path];
$traversal_result = ingest_test_request('POST', '/publication-v1/v1/packages', $bad_traversal);
$bad_schema = $payload;
$bad_schema['extra'] = 'not allowed';
$schema_result = ingest_test_request('POST', '/publication-v1/v1/packages', $bad_schema);
$bad_canonical = $payload;
$bad_canonical['manifest'] .= ' ';
$canonical_result = ingest_test_request('POST', '/publication-v1/v1/packages', $bad_canonical);
$invalid_target_absent = !file_exists($package_path) && !is_link($package_path);
$invalid_owner_absent = pubv1_package_owner_record($input['package_id']) === false;
$invalid_staging = glob(rtrim(BLOG_V1_STORE, '/') . '/.upload-*');
$outside_dir = '/private/ingest-outside-' . substr($input['package_id'], 0, 8);
@mkdir($outside_dir, 0700);
$outside_marker = $outside_dir . '/marker.txt';
@file_put_contents($outside_marker, 'outside-unchanged');
$symlink_supported = function_exists('symlink');
$symlink_created = $symlink_supported ? @symlink($outside_dir, $package_path) : false;
$symlink_result = $symlink_created ? ingest_test_request('POST', '/publication-v1/v1/packages', $payload) : array('status' => 0);
$symlink_rejected = $symlink_created && $symlink_result['status'] === 409 && is_file($outside_marker)
    && file_get_contents($outside_marker) === 'outside-unchanged';
if ($symlink_created) @unlink($package_path);
ingest_test_remove_tree($outside_dir);
$upload = ingest_test_request('POST', '/publication-v1/v1/packages', $payload);
$retry = ingest_test_request('POST', '/publication-v1/v1/packages', $payload);
$query = ingest_test_request('GET', '/publication-v1/v1/packages/' . $input['package_id']);
$loaded = pubv1_load_package($input['package_id']);
$bytes_valid = is_array($loaded);
if ($bytes_valid) {
    foreach ($payload['files'] as $path => $encoded) {
        $expected_bytes = base64_decode($encoded, true);
        if (!is_string($expected_bytes) || !isset($loaded['_inventory_bytes'][$path]) || !hash_equals($expected_bytes, $loaded['_inventory_bytes'][$path])) {
            $bytes_valid = false;
            break;
        }
    }
}
$root_mode = @fileperms(BLOG_V1_STORE);
$package_mode = @fileperms($package_path);
$manifest_mode = @fileperms($package_path . '/manifest.json');
$asset_mode = @fileperms($package_path . '/bundle/assets/katex.min.css');
$permissions_private = is_int($root_mode) && is_int($package_mode) && is_int($manifest_mode) && is_int($asset_mode)
    && (($root_mode & 0077) === 0) && (($package_mode & 0077) === 0)
    && (($manifest_mode & 0077) === 0) && (($asset_mode & 0077) === 0);
$wrong_site_denied = !pubv1_package_owned_by($input['package_id'], (int) $publisher_id, (int) get_current_blog_id() + 1);
$pending = ingest_test_request('POST', '/publication-v1/v1/operations', array(
    'id' => $input['operation_id'],
    'title' => $input['title'],
    'expires_at' => time() + 300,
    'manifest_sha256' => $input['package_id'],
));
$owner = pubv1_package_owner_record($input['package_id']);
$owner_exact = is_array($owner) && $owner['publisher_id'] === (int) $publisher_id && $owner['site_id'] === (int) get_current_blog_id();
$other_id = wp_insert_user(array(
    'user_login' => $input['publisher_login'] . '-other',
    'user_email' => $input['publisher_login'] . '-other@example.test',
    'user_pass' => wp_generate_password(48, true, true),
    'role' => 'subscriber',
));
if (is_wp_error($other_id)) throw new RuntimeException('second synthetic publisher setup failed');
(new WP_User($other_id))->add_cap('publish_publication_v1');
wp_set_current_user((int) $other_id);
$other_query = ingest_test_request('GET', '/publication-v1/v1/packages/' . $input['package_id']);
$other_upload = ingest_test_request('POST', '/publication-v1/v1/packages', $payload);
$other_operation_id = str_repeat('b', 32);
$other_pending = ingest_test_request('POST', '/publication-v1/v1/operations', array(
    'id' => $other_operation_id,
    'title' => $input['title'],
    'expires_at' => time() + 300,
    'manifest_sha256' => $input['package_id'],
));
$other_operation_absent = pubv1_read_raw_option(pubv1_option_key($other_operation_id)) === null;
$anonymous_id = wp_insert_user(array(
    'user_login' => $input['publisher_login'] . '-no-cap',
    'user_email' => $input['publisher_login'] . '-no-cap@example.test',
    'user_pass' => wp_generate_password(48, true, true),
    'role' => 'subscriber',
));
if (is_wp_error($anonymous_id)) throw new RuntimeException('synthetic no-capability setup failed');
wp_set_current_user((int) $anonymous_id);
$no_cap_query = ingest_test_request('GET', '/publication-v1/v1/packages/' . $input['package_id']);
$no_cap_upload = ingest_test_request('POST', '/publication-v1/v1/packages', $payload);
wp_set_current_user((int) $publisher_id);
$corrupt_path = $package_path . '/bundle/assets/katex.min.css';
$stored_css = @file_get_contents($corrupt_path);
$corruption_written = is_string($stored_css) && @file_put_contents($corrupt_path, $stored_css . 'x') !== false;
$corrupt_retry = ingest_test_request('POST', '/publication-v1/v1/packages', $payload);
$corrupt_query = ingest_test_request('GET', '/publication-v1/v1/packages/' . $input['package_id']);
$exposed = json_encode(array(
    'upload' => $upload, 'retry' => $retry, 'query' => $query,
    'other_query' => $other_query, 'other_pending' => $other_pending,
    'no_cap_query' => $no_cap_query, 'no_cap_upload' => $no_cap_upload,
), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
$staging = glob(rtrim(BLOG_V1_STORE, '/') . '/.upload-*');
echo json_encode(array(
    'stage' => 'fresh_receive',
    'legacy_denied_status' => $legacy_denied['status'],
    'legacy_denied_code' => $legacy_denied['data']['code'] ?? null,
    'legacy_operation_absent_before_seed' => $legacy_operation_absent_before_seed,
    'legacy_test_seeded' => $legacy_seeded,
    'legacy_allowed_status' => $legacy_allowed['status'],
    'fixture_removed' => $fixture_removed,
    'invalid_statuses' => array($extra_result['status'], $missing_result['status'], $corrupt_result['status'], $traversal_result['status'], $schema_result['status'], $canonical_result['status']),
    'invalid_errors' => array($extra_result['data']['code'] ?? null, $missing_result['data']['code'] ?? null, $corrupt_result['data']['code'] ?? null, $traversal_result['data']['code'] ?? null, $schema_result['data']['code'] ?? null, $canonical_result['data']['code'] ?? null),
    'invalid_target_absent' => $invalid_target_absent,
    'invalid_owner_absent' => $invalid_owner_absent,
    'invalid_stage_count' => is_array($invalid_staging) ? count($invalid_staging) : -1,
    'symlink_supported' => $symlink_supported,
    'symlink_rejected' => $symlink_rejected,
    'upload_status' => $upload['status'],
    'upload_data' => $upload['data'],
    'retry_status' => $retry['status'],
    'retry_data' => $retry['data'],
    'query_status' => $query['status'],
    'query_data' => $query['data'],
    'package_bytes_valid' => $bytes_valid,
    'permissions_private' => $permissions_private,
    'wrong_site_denied' => $wrong_site_denied,
    'package_loaded' => is_array($loaded),
    'pending_status' => $pending['status'],
    'pending_code' => $pending['data']['code'] ?? null,
    'owner_exact' => $owner_exact,
    'other_query_status' => $other_query['status'],
    'other_upload_status' => $other_upload['status'],
    'other_pending_status' => $other_pending['status'],
    'other_pending_code' => $other_pending['data']['code'] ?? null,
    'other_operation_absent' => $other_operation_absent,
    'no_cap_query_status' => $no_cap_query['status'],
    'no_cap_upload_status' => $no_cap_upload['status'],
    'corruption_written' => $corruption_written,
    'corrupt_retry_status' => $corrupt_retry['status'],
    'corrupt_retry_code' => $corrupt_retry['data']['code'] ?? null,
    'corrupt_query_status' => $corrupt_query['status'],
    'stage_count' => is_array($staging) ? count($staging) : -1,
    'raw_manifest_hidden' => strpos($exposed, $manifest_raw) === false,
    'package_body_hidden' => strpos($exposed, 'PRIVATE_INGEST_BODY_SENTINEL') === false,
    'host_path_hidden' => strpos($exposed, BLOG_V1_STORE) === false,
), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
'''


def _php_code(case: dict, payload: dict, legacy_case: dict) -> str:
    php_input = {
        "publisher_login": "ingest-publisher-" + case["operation_id"],
        "package_id": case["package_id"],
        "operation_id": case["operation_id"],
        "title": case["title"],
        "legacy_package_id": legacy_case["package_id"],
        "legacy_title": legacy_case["title"],
    }
    encoded = base64.b64encode(json.dumps(php_input, ensure_ascii=False).encode("utf-8")).decode("ascii")
    return PHP_SCENARIO.replace(
        "__WP_LOAD__", "/wordpress/PLACEHOLDER/wp-load.php"
    ).replace("__INPUT_B64__", encoded)


def _write_evidence(value: dict) -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    temporary = EVIDENCE.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(EVIDENCE)


def _upload_payload(case: dict) -> dict:
    raw_manifest = (case["package_path"] / "manifest.json").read_bytes()
    files = {
        path.relative_to(case["package_path"] / "bundle").as_posix(): base64.b64encode(path.read_bytes()).decode("ascii")
        for path in sorted((case["package_path"] / "bundle").rglob("*"))
        if path.is_file()
    }
    assert hashlib.sha256(raw_manifest).hexdigest() == case["package_id"]
    return {"manifest": raw_manifest.decode("utf-8"), "files": files}


class PrivatePackageIngestTests(unittest.TestCase):
    def test_authenticated_receive_query_retry_and_owner_freeze(self) -> None:
        OUTPUT.mkdir(parents=True, exist_ok=True)
        _write_evidence({"verdict": "REJECTED", "reason": "run_in_progress"})
        try:
            with tempfile.TemporaryDirectory(prefix="ingest-", dir=RUNTIME_HOME) as tmp:
                root = Path(tmp)
                case = build_article(
                    root,
                    "receive",
                    "文章/私有接收.md",
                    "私有包接收验收",
                    "# PRIVATE_INGEST_BODY_SENTINEL\n\n接收路径合成验收。\n",
                )
                legacy_case = build_article(
                    root,
                    "pre-staged",
                    "articles/pre-staged.md",
                    "旧生命周期预置包",
                    "# Pre-staged fixture\n\nOnly a test-owned package record enables freeze.\n",
                )
                payload = _upload_payload(case)
                smoke, result = run_isolated_wordpress([case, legacy_case], _php_code(case, payload, legacy_case))
                self.assertTrue(smoke["complete_core_loaded"], smoke)
                self.assertEqual(smoke["database_engine"], "sqlite", smoke)
                self.assertEqual(result["stage"], "fresh_receive", result)
                self.assertEqual(result["legacy_denied_status"], 404, result)
                self.assertEqual(result["legacy_denied_code"], "package_not_owned", result)
                self.assertTrue(result["legacy_operation_absent_before_seed"], result)
                self.assertTrue(result["legacy_test_seeded"], result)
                self.assertEqual(result["legacy_allowed_status"], 201, result)
                self.assertTrue(result["fixture_removed"], result)
                self.assertEqual(result["invalid_statuses"], [400] * 6, result)
                self.assertTrue(result["invalid_target_absent"], result)
                self.assertTrue(result["invalid_owner_absent"], result)
                self.assertEqual(result["invalid_stage_count"], 0, result)
                self.assertTrue(result["symlink_supported"], result)
                self.assertTrue(result["symlink_rejected"], result)
                self.assertEqual(result["upload_status"], 201, result)
                self.assertEqual(result["upload_data"]["package_id"], case["package_id"], result)
                self.assertEqual(result["retry_status"], 200, result)
                self.assertEqual(result["query_status"], 200, result)
                self.assertTrue(result["package_bytes_valid"], result)
                self.assertTrue(result["permissions_private"], result)
                self.assertTrue(result["wrong_site_denied"], result)
                self.assertTrue(result["package_loaded"], result)
                self.assertEqual(result["pending_status"], 201, result)
                self.assertTrue(result["owner_exact"], result)
                self.assertEqual(result["other_query_status"], 404, result)
                self.assertEqual(result["other_upload_status"], 404, result)
                self.assertEqual(result["other_pending_status"], 404, result)
                self.assertEqual(result["other_pending_code"], "package_not_owned", result)
                self.assertTrue(result["other_operation_absent"], result)
                self.assertEqual(result["no_cap_query_status"], 403, result)
                self.assertEqual(result["no_cap_upload_status"], 403, result)
                self.assertTrue(result["corruption_written"], result)
                self.assertEqual(result["corrupt_retry_status"], 409, result)
                self.assertEqual(result["corrupt_retry_code"], "package_corrupt", result)
                self.assertEqual(result["corrupt_query_status"], 409, result)
                self.assertEqual(result["stage_count"], 0, result)
                self.assertTrue(result["raw_manifest_hidden"], result)
                self.assertTrue(result["package_body_hidden"], result)
                self.assertTrue(result["host_path_hidden"], result)
            _write_evidence({
                "verdict": "PASS",
                "run_date": "2026-10-06",
                "scenario": "authenticated fresh receive/query/retry/owner freeze",
                "local_synthetic_only": True,
                "wordpress": smoke.get("wordpress_version"),
                "package_id_sha256": case["package_id"],
                "compiler_pin_sha256": case["compiler_sha256"],
                "manifest_bytes": len(payload["manifest"].encode("utf-8")),
                "inventory_files": len(payload["files"]),
                "inventory_total_bytes": sum(record["bytes"] for record in case["manifest"]["inventory"].values()),
                "limits": {
                    "request_body_bytes": 25165824,
                    "manifest_bytes": 65536,
                    "inventory_files": 128,
                    "resource_bytes": 2000000,
                    "total_resource_bytes": 16000000,
                },
                "requests": {
                    "first_upload": result["upload_status"],
                    "idempotent_retry": result["retry_status"],
                    "owner_query": result["query_status"],
                    "owner_pending": result["pending_status"],
                    "invalid_batch_statuses": result["invalid_statuses"],
                    "symlink_supported": result["symlink_supported"],
                    "symlink_rejected": result["symlink_rejected"],
                    "other_publisher_query": result["other_query_status"],
                    "other_publisher_upload": result["other_upload_status"],
                    "other_publisher_pending": result["other_pending_status"],
                    "no_capability_query": result["no_cap_query_status"],
                    "no_capability_upload": result["no_cap_upload_status"],
                    "corrupt_existing_retry": result["corrupt_retry_status"],
                    "corrupt_existing_query": result["corrupt_query_status"],
                },
                "owner_scope": {
                    "publisher_and_site_record_exact": result["owner_exact"],
                    "wrong_site_denied": result["wrong_site_denied"],
                    "other_operation_written": not result["other_operation_absent"],
                },
                "pre_staged_fixture": {
                    "denied_without_owner": result["legacy_denied_status"],
                    "no_operation_before_test_seed": result["legacy_operation_absent_before_seed"],
                    "isolated_test_owner_seeded": result["legacy_test_seeded"],
                    "allowed_after_test_seed": result["legacy_allowed_status"],
                },
                "private_permissions_verified": result["permissions_private"],
                "response_body_and_host_path_hidden": result["raw_manifest_hidden"] and result["package_body_hidden"] and result["host_path_hidden"],
                "staging_entries_after_receive": result["stage_count"],
                "temporary_fixtures_cleaned": True,
            })
        except BaseException as exc:
            _write_evidence({"verdict": "REJECTED", "failure_class": type(exc).__name__})
            raise


if __name__ == "__main__":
    unittest.main()
