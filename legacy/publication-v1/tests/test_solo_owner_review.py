"""Focused real-WordPress single-owner review and commit boundary."""
from __future__ import annotations

import base64
import json
import os
import subprocess
import uuid
from pathlib import Path
import tempfile
import unittest

from test_wordpress_lifecycle import stage_code
from test_wordpress_runtime import NODE, RUNTIME_HOME, png_fixture, run_isolated_wordpress


def fixture_node_environment() -> dict[str, str]:
    """Use the pinned parser dependencies in CI without global NODE_PATH changes."""
    environment = dict(os.environ)
    parser = environment.get("PUBLICATION_PARSER_ROOT")
    if parser:
        environment["NODE_PATH"] = os.pathsep.join(value for value in (
            str(Path(parser) / "node_modules"), environment.get("NODE_PATH", "")
        ) if value)
    return environment


SOLO_OWNER_BODY = r'''
$owner_id = pv1_test_user($input['owner_login']);
$other_id = pv1_test_user($input['other_login']);
$owner_user = new WP_User($owner_id);
$owner_user->add_cap('publish_publication_v1');
$owner_user->add_cap('approve_publication_v1');
(new WP_User($other_id))->add_cap('approve_publication_v1');
(new WP_User($other_id))->add_cap('publish_publication_v1');
$owner_nonce = pv1_test_login($owner_id);
$package_path = rtrim(BLOG_V1_STORE, '/') . '/' . $input['package_id'];
$manifest_raw = @file_get_contents($package_path . '/manifest.json');
$manifest = is_string($manifest_raw) ? json_decode($manifest_raw, true) : false;
$files = array();
$fixture_valid = is_array($manifest) && is_array($manifest['inventory'] ?? null);
if ($fixture_valid) {
    foreach ($manifest['inventory'] as $relative => $asset) {
        $bytes = @file_get_contents($package_path . '/bundle/' . $relative);
        if (!is_string($bytes)) { $fixture_valid = false; break; }
        $files[$relative] = base64_encode($bytes);
    }
}
$fixture_removed = $fixture_valid && pv1_test_remove_tree($package_path);
$upload = $fixture_removed
    ? pv1_test_request('POST', '/publication-v1/v1/packages', array('manifest' => $manifest_raw, 'files' => $files), $owner_nonce)
    : array('status' => 0, 'data' => array());
$create = pv1_test_request('POST', '/publication-v1/v1/operations', array(
    'id' => $input['operation_id'], 'title' => $input['title'],
    'expires_at' => time() + 300, 'manifest_sha256' => $input['package_id'],
));
$record = maybe_unserialize(pubv1_read_raw_option(pubv1_option_key($input['operation_id'])));
$digest = is_array($record) ? ($record['digest'] ?? '') : '';
$asset_path = 'assets/images/' . $input['image_sha256'] . '.png';
$resource_route = '/publication-v1/v1/resources/' . $input['operation_id'] . '/' . $asset_path;
$owner_resource = pv1_test_request('GET', $resource_route);
$no_nonce = pv1_test_request('POST', '/publication-v1/v1/approve', array(
    'id' => $input['operation_id'], 'digest' => $digest, 'decision' => 'approve',
));
$_COOKIE = array();
wp_set_current_user($owner_id);
$api_nonce = wp_create_nonce('wp_rest');
$api_only = pv1_test_request('POST', '/publication-v1/v1/approve', array(
    'id' => $input['operation_id'], 'digest' => $digest, 'decision' => 'approve',
), $api_nonce);
wp_set_current_user(0);
$anonymous_resource = pv1_test_request('GET', $resource_route);
$other_nonce = pv1_test_login($other_id);
$other_resource = pv1_test_request('GET', $resource_route);
$other_lookup = pv1_test_request('GET', '/publication-v1/v1/operations/' . $input['operation_id']);
$other_approval = pv1_test_request('POST', '/publication-v1/v1/approve', array(
    'id' => $input['operation_id'], 'digest' => $digest, 'decision' => 'approve',
), $other_nonce);
$owner_nonce = pv1_test_login($owner_id);
$owner_approval = pv1_test_request('POST', '/publication-v1/v1/approve', array(
    'id' => $input['operation_id'], 'digest' => $digest, 'decision' => 'approve',
), $owner_nonce);
$approved_record = maybe_unserialize(pubv1_read_raw_option(pubv1_option_key($input['operation_id'])));
$posts_before_commit = (int) $GLOBALS['wpdb']->get_var($GLOBALS['wpdb']->prepare(
    "SELECT COUNT(*) FROM {$GLOBALS['wpdb']->postmeta} WHERE meta_key = %s AND meta_value = %s",
    '_publication_v1_operation', $input['operation_id']
));
pv1_test_login($other_id);
$other_commit = pv1_test_request('POST', '/publication-v1/v1/commit', array(
    'id' => $input['operation_id'], 'digest' => $digest,
));
$commit = array('status' => 0, 'data' => array());
$retry = array('status' => 0, 'data' => array());
if ($owner_approval['status'] === 200) {
    pv1_test_login($owner_id);
    // SIMULATED legacy approved state: a foreign reviewer had approved before the owner-policy update.
    $legacy = $approved_record;
    $legacy['reviewer_id'] = $other_id;
    update_option(pubv1_option_key($input['operation_id']), $legacy, false);
    $foreign_approved_commit = pv1_test_request('POST', '/publication-v1/v1/commit', array(
        'id' => $input['operation_id'], 'digest' => $digest,
    ));
    $legacy_after = maybe_unserialize(pubv1_read_raw_option(pubv1_option_key($input['operation_id'])));
    $legacy_posts = (int) $GLOBALS['wpdb']->get_var($GLOBALS['wpdb']->prepare(
        "SELECT COUNT(*) FROM {$GLOBALS['wpdb']->postmeta} WHERE meta_key = %s AND meta_value = %s",
        '_publication_v1_operation', $input['operation_id']
    ));
    update_option(pubv1_option_key($input['operation_id']), $approved_record, false);
    $commit = pv1_test_request('POST', '/publication-v1/v1/commit', array(
        'id' => $input['operation_id'], 'digest' => $digest,
    ));
    $retry = pv1_test_request('POST', '/publication-v1/v1/commit', array(
        'id' => $input['operation_id'], 'digest' => $digest,
    ));
}
$post_id = (int) ($commit['data']['post_id'] ?? 0);
$post = $post_id ? get_post($post_id) : false;
$final = maybe_unserialize(pubv1_read_raw_option(pubv1_option_key($input['operation_id'])));
$posts_after_commit = (int) $GLOBALS['wpdb']->get_var($GLOBALS['wpdb']->prepare(
    "SELECT COUNT(*) FROM {$GLOBALS['wpdb']->postmeta} WHERE meta_key = %s AND meta_value = %s",
    '_publication_v1_operation', $input['operation_id']
));
$admin_role = get_role('administrator');
echo json_encode(array(
    'legacy_foreign_approved_commit_status' => $foreign_approved_commit['status'] ?? 0,
    'legacy_foreign_approved_commit_code' => $foreign_approved_commit['data']['code'] ?? null,
    'legacy_foreign_approved_no_write' => isset($legacy_after) && $legacy_posts === 0
        && ($legacy_after['state'] ?? '') === 'approved'
        && (int) ($legacy_after['reviewer_id'] ?? 0) === $other_id,
    'fixture_upload_status' => $upload['status'],
    'operation_create_status' => $create['status'],
    'operation_pending' => is_array($record) && ($record['state'] ?? '') === 'pending',
    'owner_cookie_nonce_approval_status' => $owner_approval['status'],
    'owner_cookie_nonce_approval_code' => $owner_approval['data']['code'] ?? null,
    'owner_no_nonce_status' => $no_nonce['status'],
    'api_only_with_nonce_status' => $api_only['status'],
    'other_owner_lookup_status' => $other_lookup['status'],
    'other_owner_approval_status' => $other_approval['status'],
    'other_owner_resource_status' => $other_resource['status'],
    'owner_pending_resource_status' => $owner_resource['status'],
    'anonymous_pending_resource_status' => $anonymous_resource['status'],
    'approval_did_not_publish' => $posts_before_commit === 0,
    'recorded_owner_approval' => is_array($approved_record)
        && ($approved_record['state'] ?? '') === 'approved'
        && ($approved_record['reviewer_id'] ?? null) === $owner_id
        && ($approved_record['snapshot']['publisher_id'] ?? null) === $owner_id,
    'other_owner_commit_status' => $other_commit['status'],
    'commit_status' => $commit['status'],
    'retry_status' => $retry['status'],
    'retry_same_post' => $post_id > 0 && (int) ($retry['data']['post_id'] ?? 0) === $post_id,
    'one_post_for_operation' => $post_id > 0 && $posts_after_commit === 1,
    'exact_post_readback' => $post instanceof WP_Post
        && $post->post_type === 'post' && $post->post_status === 'publish'
        && (int) $post->post_author === $owner_id
        && $post->post_title === $input['title']
        && $post->post_content === ($final['snapshot']['content'] ?? null)
        && get_post_meta($post_id, '_publication_v1_operation', true) === $input['operation_id'],
    'final_state_committed' => is_array($final) && ($final['state'] ?? '') === 'committed',
    'administrator_has_publish_cap' => $admin_role instanceof WP_Role && $admin_role->has_cap('publish_publication_v1'),
    'administrator_has_approve_cap' => $admin_role instanceof WP_Role && $admin_role->has_cap('approve_publication_v1'),
    'SIMULATED' => true,
), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
'''


class SoloOwnerReviewTests(unittest.TestCase):
    def test_same_owner_cookie_nonce_approval_then_explicit_idempotent_commit(self) -> None:
        RUNTIME_HOME.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="solo-owner-", dir=RUNTIME_HOME) as tmp:
            root = Path(tmp)
            fixture = subprocess.run(
                [str(NODE), str(Path(__file__).with_name("solo_owner_package.cjs"))],
                input=json.dumps({"output": str(root), "selected": "文章/单作者确认.md",
                    "title": "合成单作者确认",
                    "source": "# 合成文章\n\n同一合成人确认冻结稿。\n\n![图片](图.png)\n",
                    "png": base64.b64encode(png_fixture()).decode("ascii")}, ensure_ascii=False),
                capture_output=True, text=True, encoding="utf-8", timeout=30,
                env=fixture_node_environment(),
            )
            self.assertEqual(fixture.returncode, 0, fixture.stderr)
            case = json.loads(fixture.stdout)
            case["package_path"] = root / case["package_id"]
            case["operation_id"] = uuid.uuid4().hex
            payload = {
                "owner_login": "synthetic-owner-" + case["operation_id"],
                "other_login": "synthetic-other-" + case["operation_id"],
                "title": case["title"],
                "package_id": case["package_id"],
                "operation_id": case["operation_id"],
                "image_sha256": case["image_sha256"],
            }
            smoke, result = run_isolated_wordpress([case], stage_code(SOLO_OWNER_BODY, payload))
            summary = {"smoke": smoke, "result": result}
            print("SOLO_OWNER_WORDPRESS_SUMMARY=" + json.dumps(summary, ensure_ascii=False, sort_keys=True))
            self.assertTrue(smoke["complete_core_loaded"], summary)
            self.assertEqual(smoke["database_engine"], "sqlite", summary)
            self.assertTrue(smoke["plugin_active"], summary)
            self.assertTrue(result["SIMULATED"], summary)
            self.assertEqual(result["fixture_upload_status"], 201, summary)
            self.assertEqual(result["operation_create_status"], 201, summary)
            self.assertTrue(result["operation_pending"], summary)
            self.assertEqual(result["legacy_foreign_approved_commit_status"], 409, summary)
            self.assertEqual(result["legacy_foreign_approved_commit_code"], "not_approved_or_changed", summary)
            self.assertTrue(result["legacy_foreign_approved_no_write"], summary)
            self.assertEqual(result["owner_cookie_nonce_approval_status"], 200, summary)
            self.assertEqual(result["owner_no_nonce_status"], 403, summary)
            self.assertEqual(result["api_only_with_nonce_status"], 403, summary)
            self.assertEqual(result["other_owner_lookup_status"], 404, summary)
            self.assertEqual(result["other_owner_approval_status"], 403, summary)
            self.assertEqual(result["other_owner_resource_status"], 404, summary)
            self.assertEqual(result["owner_pending_resource_status"], 200, summary)
            self.assertEqual(result["anonymous_pending_resource_status"], 404, summary)
            self.assertTrue(result["approval_did_not_publish"], summary)
            self.assertTrue(result["recorded_owner_approval"], summary)
            self.assertEqual(result["other_owner_commit_status"], 403, summary)
            self.assertEqual(result["commit_status"], 200, summary)
            self.assertEqual(result["retry_status"], 200, summary)
            self.assertTrue(result["retry_same_post"], summary)
            self.assertTrue(result["one_post_for_operation"], summary)
            self.assertTrue(result["exact_post_readback"], summary)
            self.assertTrue(result["final_state_committed"], summary)
            self.assertTrue(result["administrator_has_publish_cap"], summary)
            self.assertTrue(result["administrator_has_approve_cap"], summary)


    def test_private_review_page_uses_owner_cookie_and_short_chinese_confirmation(self) -> None:
        RUNTIME_HOME.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="solo-page-", dir=RUNTIME_HOME) as tmp:
            root = Path(tmp)
            fixture = subprocess.run(
                [str(NODE), str(Path(__file__).with_name("solo_owner_package.cjs"))],
                input=json.dumps({"output": str(root), "selected": "文章/确认页.md",
                    "title": "合成确认页", "source": "合成正文\n\n![图](图.png)\n",
                    "png": base64.b64encode(png_fixture()).decode("ascii")}, ensure_ascii=False),
                capture_output=True, text=True, encoding="utf-8", timeout=30,
                env=fixture_node_environment(),
            )
            self.assertEqual(fixture.returncode, 0, fixture.stderr)
            case = json.loads(fixture.stdout)
            case["package_path"] = root / case["package_id"]
            case["operation_id"] = uuid.uuid4().hex
            payload = {"owner_login": "page-owner-" + case["operation_id"],
                "other_login": "page-other-" + case["operation_id"],
                "title": case["title"], "package_id": case["package_id"],
                "operation_id": case["operation_id"], "image_sha256": case["image_sha256"]}
            setup = SOLO_OWNER_BODY.split("$asset_path =", 1)[0] + "echo json_encode(array('created'=>$create['status']));"
            preview = r'''
$uid = pv1_test_user($input['actor_login']);
pv1_test_login($uid);
if (!empty($input['api_only'])) { $_COOKIE = array(); }
$_GET['publication_v1_preview'] = $input['operation_id'];
$captured = '';
ob_start(function ($html) use (&$captured) { $captured .= $html; return ''; });
register_shutdown_function(function () use (&$captured) {
    while (ob_get_level() > 0) { ob_end_flush(); }
    echo json_encode(array('status' => http_response_code() ?: 200,
        'short_ui' => strpos($captured, '>确认</button>') !== false
            && strpos($captured, '>取消</button>') !== false
            && strpos($captured, '确认后仍需回到插件点击发布') !== false
            && strpos($captured, '; publisher:') === false
            && strpos($captured, '; digest:') === false,
        'has_bound_form' => strpos($captured, 'name="_wpnonce"') !== false
            && strpos($captured, 'name="digest"') !== false,
        'denied_body_empty' => $captured === '', 'SIMULATED' => true), JSON_UNESCAPED_UNICODE);
});
pubv1_preview_page();
'''
            owner = dict(payload, actor_login=payload["owner_login"])
            foreign = dict(payload, actor_login=payload["other_login"])
            api = dict(owner, api_only=True)
            smoke, results = run_isolated_wordpress([case], [stage_code(setup, payload),
                stage_code(preview, owner), stage_code(preview, foreign), stage_code(preview, api)])
            print("SOLO_PAGE_SUMMARY=" + json.dumps(results, ensure_ascii=False))
            self.assertTrue(smoke["complete_core_loaded"])
            self.assertEqual(results[0]["created"], 201)
            self.assertEqual(results[1]["status"], 200)
            self.assertTrue(results[1]["short_ui"], results)
            self.assertTrue(results[1]["has_bound_form"], results)
            for denied in results[2:]:
                self.assertEqual(denied["status"], 403, results)
                self.assertTrue(denied["denied_body_empty"], results)


if __name__ == "__main__":
    unittest.main(verbosity=2)
