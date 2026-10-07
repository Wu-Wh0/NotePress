<?php
if (!defined('ABSPATH')) {
    exit;
}

function pubv1_publisher_permission() {
    return current_user_can('publish_publication_v1')
        ? true
        : pubv1_error('publisher_required', 403);
}

function pubv1_reviewer_permission($request) {
    $nonce = $request->get_header('X-WP-Nonce');
    if (!is_string($nonce) || $nonce === '') {
        $nonce = $request->get_param('_wpnonce');
    }
    $uid = wp_validate_auth_cookie('', 'logged_in');
    if (!$uid || (int) $uid !== (int) get_current_user_id() || !is_string($nonce) || !wp_verify_nonce($nonce, 'wp_rest')) {
        return pubv1_error('review_cookie_and_nonce_required', 403);
    }
    if (!user_can((int) $uid, 'approve_publication_v1')) {
        return pubv1_error('reviewer_required', 403);
    }
    return true;
}

function pubv1_request_body($request) {
    $body = $request->get_json_params();
    return is_array($body) ? $body : $request->get_body_params();
}

function pubv1_pending_callback($request) {
    $body = pubv1_request_body($request);
    $allowed = array('id', 'title', 'expires_at', 'manifest_sha256');
    if (!is_array($body) || count($body) !== count($allowed) || array_diff(array_keys($body), $allowed)) {
        return pubv1_error('invalid_publication_request', 400);
    }
    $operation_id = $body['id'] ?? null;
    $manifest_sha256 = $body['manifest_sha256'] ?? null;
    $title_input = $body['title'] ?? null;
    $expires_at = $body['expires_at'] ?? null;
    if (!pubv1_hex($operation_id, 32) || !pubv1_hex($manifest_sha256) || !is_string($title_input) || !is_int($expires_at)) {
        return pubv1_error('invalid_publication_request', 400);
    }
    $title = sanitize_text_field($title_input);
    if ($title === '' || strlen($title) > 200 || $expires_at <= time() || $expires_at > time() + 3600) {
        return pubv1_error('invalid_publication_request', 400);
    }
    $publisher_id = (int) get_current_user_id();
    $site_id = (int) get_current_blog_id();
    if (!pubv1_package_owned_by($manifest_sha256, $publisher_id, $site_id)) {
        return pubv1_error('package_not_owned', 404);
    }
    $snapshot = pubv1_freeze($operation_id, $manifest_sha256, $title, $publisher_id, $expires_at);
    if (!$snapshot) {
        return pubv1_error('package_or_policy_invalid', 409);
    }
    $digest = pubv1_snapshot_digest($snapshot);
    if (!is_string($digest)) {
        return pubv1_error('snapshot_digest_failed', 503);
    }
    $record = array(
        'snapshot' => $snapshot,
        'digest' => $digest,
        'state' => 'pending',
        'created_at' => time(),
    );
    $key = pubv1_option_key($operation_id);
    if (!add_option($key, $record, '', false)) {
        $existing = pubv1_record_for_owner($operation_id, $publisher_id);
        if (!$existing || !hash_equals($existing[1]['digest'] ?? '', $digest)) {
            return pubv1_error('operation_conflict', 409);
        }
        $record = $existing[1];
        return new WP_REST_Response(array(
            'id' => $operation_id,
            'digest' => $record['digest'],
            'state' => $record['state'],
            'preview_url' => add_query_arg('publication_v1_preview', $operation_id, home_url('/')),
        ), 200);
    }
    return new WP_REST_Response(array(
        'id' => $operation_id,
        'digest' => $digest,
        'state' => 'pending',
        'preview_url' => add_query_arg('publication_v1_preview', $operation_id, home_url('/')),
    ), 201);
}

function pubv1_package_receive_callback($request) {
    $raw_body = $request->get_body();
    if (!is_string($raw_body) || strlen($raw_body) > 25165824) {
        return pubv1_error('package_request_too_large', 413);
    }
    $body = $request->get_json_params();
    $allowed = array('manifest', 'files');
    if (!is_array($body) || count($body) !== count($allowed) || array_diff(array_keys($body), $allowed)) {
        return pubv1_error('invalid_package_request', 400);
    }
    $result = pubv1_ingest_package(
        $body['manifest'] ?? null,
        $body['files'] ?? null,
        (int) get_current_user_id(),
        (int) get_current_blog_id()
    );
    if (is_wp_error($result)) {
        return $result;
    }
    $created = !empty($result['created']);
    unset($result['created']);
    return new WP_REST_Response($result, $created ? 201 : 200, array('Cache-Control' => 'private, no-store'));
}

function pubv1_package_query_callback($request) {
    $package_id = $request['id'];
    $publisher_id = (int) get_current_user_id();
    $site_id = (int) get_current_blog_id();
    if (!pubv1_package_owned_by($package_id, $publisher_id, $site_id)) {
        return pubv1_error('package_not_found', 404);
    }
    $owner = pubv1_package_owner_record($package_id);
    $manifest = pubv1_load_package($package_id);
    $site_origin = home_url('/');
    if (!is_array($owner) || !is_array($manifest) || !is_string($site_origin) || strlen($site_origin) > 256) {
        return pubv1_error('package_unavailable', 409);
    }
    $compiler_json = pubv1_canonical_json($manifest['compiler']);
    $server_policy = pubv1_policy();
    $server_policy_sha256 = is_array($server_policy) ? pubv1_digest($server_policy) : false;
    if (!is_string($compiler_json) || !pubv1_hex($server_policy_sha256)) {
        return pubv1_error('package_unavailable', 409);
    }
    $inventory = array();
    foreach ($manifest['inventory'] as $path => $record) {
        $inventory[$path] = array(
            'bytes' => $record['bytes'],
            'sha256' => $record['sha256'],
            'mime' => pubv1_package_mime($path),
        );
    }
    return new WP_REST_Response(array(
        'package_id' => $package_id,
        'manifest_sha256' => $package_id,
        'schema' => $manifest['schema'],
        'selected' => $manifest['selected'],
        'title' => $manifest['title'],
        'source_sha256' => $manifest['source_sha256'],
        'labels_sha256' => $manifest['labels_sha256'],
        'compiler_sha256' => hash('sha256', $compiler_json),
        'server_policy_sha256' => $server_policy_sha256,
        'publisher_id' => $owner['publisher_id'],
        'site_id' => $owner['site_id'],
        'site_origin' => $site_origin,
        'inventory' => $inventory,
    ), 200, array('Cache-Control' => 'private, no-store'));
}

function pubv1_operation_lookup_callback($request) {
    $operation_id = $request['id'];
    $found = pubv1_record_for_owner($operation_id, get_current_user_id());
    if (!$found) {
        return pubv1_error('operation_not_found', 404);
    }
    $record = $found[1];
    $snapshot = $record['snapshot'] ?? null;
    $publisher_id = is_array($snapshot) ? ($snapshot['publisher_id'] ?? null) : null;
    $site_id = (int) get_current_blog_id();
    if (!is_array($snapshot)
        || !is_int($publisher_id) || $publisher_id < 1
        || !pubv1_current($record)
        || !pubv1_package_owned_by($snapshot['manifest_sha256'] ?? null, $publisher_id, $site_id)) {
        return pubv1_error('operation_binding_unavailable', 409);
    }
    $site_origin = $snapshot['site_origin'] ?? null;
    $selected = $snapshot['selected'] ?? null;
    $expires_at = $snapshot['expires_at'] ?? null;
    if (!is_string($site_origin) || strlen($site_origin) > 256
        || !is_string($selected) || strlen($selected) > 4096
        || !is_int($expires_at)
        || !is_int($snapshot['publisher_id'] ?? null) || $snapshot['publisher_id'] < 1
        || $site_id < 1) {
        return pubv1_error('operation_binding_unavailable', 409);
    }
    $binding = array(
        'publisher_id' => $snapshot['publisher_id'],
        'site_id' => $site_id,
        'site_origin' => $site_origin,
        'manifest_sha256' => $snapshot['manifest_sha256'],
        'selected_sha256' => hash('sha256', $selected),
        'source_sha256' => $snapshot['source_sha256'],
        'labels_sha256' => $snapshot['labels_sha256'],
        'title_sha256' => hash('sha256', $snapshot['title']),
        'compiler_sha256' => $snapshot['compiler_sha256'],
        'server_policy_sha256' => $snapshot['policy_sha256'],
        'expires_at' => $expires_at,
    );
    foreach (array('manifest_sha256', 'selected_sha256', 'source_sha256', 'labels_sha256', 'title_sha256', 'compiler_sha256', 'server_policy_sha256') as $field) {
        if (!pubv1_hex($binding[$field] ?? null)) {
            return pubv1_error('operation_binding_unavailable', 409);
        }
    }
    return new WP_REST_Response(array(
        'id' => $operation_id,
        'digest' => $record['digest'],
        'state' => $record['state'],
        'post_id' => isset($record['post_id']) ? (int) $record['post_id'] : null,
        'binding' => $binding,
    ), 200, array('Cache-Control' => 'no-store'));
}

function pubv1_operation_snapshot_callback($request) {
    $operation_id = $request['id'];
    $publisher_id = (int) get_current_user_id();
    $found = pubv1_record_for_owner($operation_id, $publisher_id);
    if (!$found) {
        return pubv1_error('operation_not_found', 404);
    }
    $record = $found[1];
    $snapshot = $record['snapshot'] ?? null;
    $site_id = (int) get_current_blog_id();
    if (!is_array($snapshot)
        || !in_array($record['state'] ?? '', array('pending', 'approved'), true)
        || !is_int($snapshot['publisher_id'] ?? null) || $snapshot['publisher_id'] !== $publisher_id
        || !is_int($snapshot['expires_at'] ?? null) || $snapshot['expires_at'] <= time()
        || $site_id < 1
        || !pubv1_package_owned_by($snapshot['manifest_sha256'] ?? null, $publisher_id, $site_id)
        || !pubv1_current($record)) {
        return pubv1_error('operation_snapshot_unavailable', 409);
    }
    $rendered = $snapshot['rendered'] ?? null;
    if (!is_string($rendered) || wp_kses_post($rendered) !== $rendered) {
        return pubv1_error('operation_snapshot_rendering_unsupported', 409);
    }
    $snapshot_json = pubv1_canonical_json($snapshot);
    $digest = $record['digest'] ?? null;
    if (!is_string($snapshot_json) || strlen($snapshot_json) > 1048576
        || !is_string($digest) || !pubv1_hex($digest)
        || !hash_equals($digest, hash('sha256', $snapshot_json))) {
        return pubv1_error('operation_snapshot_digest_unavailable', 409);
    }
    return new WP_REST_Response(array(
        'id' => $operation_id,
        'digest' => $digest,
        'state' => $record['state'],
        'snapshot_json' => $snapshot_json,
    ), 200, array(
        'Cache-Control' => 'private, no-store',
        'X-Content-Type-Options' => 'nosniff',
    ));
}

function pubv1_approve_callback($request) {
    $body = pubv1_request_body($request);
    if (!is_array($body) || array_diff(array_keys($body), array('id', 'digest', 'decision', '_wpnonce')) || !pubv1_hex($body['id'] ?? null, 32) || !pubv1_hex($body['digest'] ?? null) || !in_array($body['decision'] ?? null, array('approve', 'cancel'), true)) {
        return pubv1_error('invalid_review_request', 400);
    }
    $operation_id = $body['id'];
    $key = pubv1_option_key($operation_id);
    $raw = pubv1_read_raw_option($key);
    $record = $raw === null ? false : maybe_unserialize($raw);
    if (!is_array($record) || !is_array($record['snapshot'] ?? null) || !is_string($record['digest'] ?? null) || !hash_equals($record['digest'], $body['digest'])) {
        return pubv1_error('preview_mismatch', 409);
    }
    $publisher_id = (int) ($record['snapshot']['publisher_id'] ?? 0);
    $reviewer_id = (int) get_current_user_id();
    if ($reviewer_id === $publisher_id) {
        return pubv1_error('publisher_cannot_self_approve', 403);
    }
    if (($record['state'] ?? '') !== 'pending' || (int) ($record['snapshot']['expires_at'] ?? 0) <= time() || !pubv1_current($record)) {
        return pubv1_error('approval_unavailable', 409);
    }
    $record['state'] = $body['decision'] === 'approve' ? 'approved' : 'cancelled';
    $record['reviewer_id'] = $reviewer_id;
    if (!pubv1_cas_option($key, $raw, $record)) {
        return pubv1_error('approval_conflict', 409);
    }
    return new WP_REST_Response(array(
        'id' => $operation_id,
        'digest' => $record['digest'],
        'state' => $record['state'],
    ), 200, array('Cache-Control' => 'no-store'));
}

function pubv1_commit_callback($request) {
    global $wpdb;
    $body = pubv1_request_body($request);
    if (!is_array($body) || count($body) !== 2 || array_diff(array_keys($body), array('id', 'digest')) || !pubv1_hex($body['id'] ?? null, 32) || !pubv1_hex($body['digest'] ?? null)) {
        return pubv1_error('invalid_commit_request', 400);
    }
    $operation_id = $body['id'];
    $key = pubv1_option_key($operation_id);
    $raw = pubv1_read_raw_option($key);
    $record = $raw === null ? false : maybe_unserialize($raw);
    if (!is_array($record) || !is_array($record['snapshot'] ?? null)) {
        return pubv1_error('operation_not_found', 404);
    }
    $s = $record['snapshot'];
    if ((int) ($s['publisher_id'] ?? 0) !== (int) get_current_user_id()) {
        return pubv1_error('object_forbidden', 403);
    }
    if (!is_string($record['digest'] ?? null) || !hash_equals($record['digest'], $body['digest'])) {
        return pubv1_error('preview_mismatch', 409);
    }
    if (($record['state'] ?? '') === 'committed') {
        if (!pubv1_public_post_matches($operation_id, $record)) {
            return pubv1_error('committed_post_changed', 409);
        }
        return new WP_REST_Response(array('id' => $operation_id, 'state' => 'committed', 'post_id' => (int) $record['post_id'], 'digest' => $record['digest']), 200);
    }
    if (($record['state'] ?? '') === 'committing') {
        return pubv1_error('commit_in_progress', 409);
    }
    if (($record['state'] ?? '') !== 'approved' || (int) ($s['expires_at'] ?? 0) <= time() || (int) ($record['reviewer_id'] ?? 0) < 1 || (int) $record['reviewer_id'] === (int) $s['publisher_id'] || !pubv1_current($record)) {
        return pubv1_error('not_approved_or_changed', 409);
    }
    if ($wpdb->query('START TRANSACTION') === false) {
        return pubv1_error('transaction_unavailable', 503);
    }
    $claim = $record;
    $claim['state'] = 'committing';
    if (!pubv1_cas_option($key, $raw, $claim)) {
        $wpdb->query('ROLLBACK');
        return pubv1_error('claim_conflict', 409);
    }
    $post_id = wp_insert_post(wp_slash(array(
        'post_type' => 'post',
        'post_status' => 'publish',
        'post_author' => (int) $s['publisher_id'],
        'post_title' => $s['title'],
        'post_content' => $s['content'],
        'post_excerpt' => '',
        'post_parent' => 0,
        'post_password' => '',
        'post_category' => array(),
        'tags_input' => array(),
        'meta_input' => array('_publication_v1_operation' => $operation_id),
    )), true);
    if (is_wp_error($post_id) || !$post_id) {
        $wpdb->query('ROLLBACK');
        return is_wp_error($post_id) ? $post_id : pubv1_error('post_insert_failed', 503);
    }
    $saved = get_post((int) $post_id);
    if (!$saved || $saved->post_type !== 'post' || $saved->post_status !== 'publish' || (int) $saved->post_author !== (int) $s['publisher_id'] || $saved->post_title !== $s['title'] || $saved->post_content !== $s['content'] || get_post_meta((int) $post_id, '_publication_v1_operation', true) !== $operation_id) {
        $wpdb->query('ROLLBACK');
        return pubv1_error('stored_post_changed', 409);
    }
    if (apply_filters('the_content', $saved->post_content) !== $s['rendered'] || !pubv1_current($claim)) {
        $wpdb->query('ROLLBACK');
        return pubv1_error('rendering_or_policy_changed', 409);
    }
    $final = $claim;
    $final['state'] = 'committed';
    $final['post_id'] = (int) $post_id;
    if (!pubv1_cas_option($key, maybe_serialize($claim), $final)) {
        $wpdb->query('ROLLBACK');
        return pubv1_error('state_persist_failed', 503);
    }
    if ($wpdb->query('COMMIT') === false) {
        return pubv1_error('commit_result_unknown', 503);
    }
    return new WP_REST_Response(array(
        'id' => $operation_id,
        'state' => 'committed',
        'post_id' => (int) $post_id,
        'digest' => $record['digest'],
    ), 200);
}

function pubv1_preview_page() {
    if (!isset($_GET['publication_v1_preview'])) {
        return;
    }
    $operation_id = wp_unslash($_GET['publication_v1_preview']);
    if (!is_string($operation_id) || !pubv1_hex($operation_id, 32)) {
        status_header(404);
        exit;
    }
    $reviewer_id = pubv1_reviewer_cookie_user();
    $record = get_option(pubv1_option_key($operation_id));
    if (!$reviewer_id || !is_array($record) || !is_array($record['snapshot'] ?? null) || (int) $reviewer_id === (int) $record['snapshot']['publisher_id']) {
        status_header(403);
        exit;
    }
    if (!in_array($record['state'] ?? '', array('pending', 'approved'), true) || (int) $record['snapshot']['expires_at'] <= time() || !pubv1_current($record)) {
        status_header(409);
        exit;
    }
    $s = $record['snapshot'];
    nocache_headers();
    header('Content-Type: text/html; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: same-origin');
    header("Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    echo '<!doctype html><html><head><meta charset="utf-8"><title>' . esc_html($s['title']) . '</title>';
    foreach ($s['inventory'] as $path => $asset) {
        if (($asset['mime'] ?? '') === 'text/css') {
            echo '<link rel="stylesheet" href="' . esc_url(pubv1_resource_url($operation_id, $path)) . '">';
        }
    }
    echo '</head><body><h1>Private publication-v1 review; nothing is published until the publisher commits.</h1>';
    echo '<p>State: ' . esc_html($record['state']) . '; publisher: ' . (int) $s['publisher_id'] . '; digest: ' . esc_html($record['digest']) . '</p>';
    echo '<article><h2>' . esc_html($s['title']) . '</h2>' . wp_kses_post($s['rendered']) . '</article>';
    if ($record['state'] === 'pending') {
        echo '<form method="post" action="' . esc_url(rest_url('publication-v1/v1/approve')) . '">';
        echo '<input type="hidden" name="id" value="' . esc_attr($operation_id) . '">';
        echo '<input type="hidden" name="digest" value="' . esc_attr($record['digest']) . '">';
        echo '<input type="hidden" name="_wpnonce" value="' . esc_attr(wp_create_nonce('wp_rest')) . '">';
        echo '<button type="submit" name="decision" value="approve">Approve frozen draft</button>';
        echo '<button type="submit" name="decision" value="cancel">Cancel without publishing</button></form>';
    } else {
        echo '<p>Approved; publisher commit is still required.</p>';
    }
    echo '</body></html>';
    exit;
}

add_action('init', 'pubv1_preview_page', 99);
add_action('rest_api_init', function () {
    register_rest_route('publication-v1/v1', '/packages', array(
        'methods' => WP_REST_Server::CREATABLE,
        'permission_callback' => 'pubv1_publisher_permission',
        'callback' => 'pubv1_package_receive_callback',
    ));
    register_rest_route('publication-v1/v1', '/packages/(?P<id>[a-f0-9]{64})', array(
        'methods' => WP_REST_Server::READABLE,
        'permission_callback' => 'pubv1_publisher_permission',
        'callback' => 'pubv1_package_query_callback',
    ));
    register_rest_route('publication-v1/v1', '/operations', array(
        'methods' => WP_REST_Server::CREATABLE,
        'permission_callback' => 'pubv1_publisher_permission',
        'callback' => 'pubv1_pending_callback',
    ));
    register_rest_route('publication-v1/v1', '/operations/(?P<id>[a-f0-9]{32})', array(
        'methods' => WP_REST_Server::READABLE,
        'permission_callback' => 'pubv1_publisher_permission',
        'callback' => 'pubv1_operation_lookup_callback',
    ));
    register_rest_route('publication-v1/v1', '/operations/(?P<id>[a-f0-9]{32})/snapshot', array(
        'methods' => WP_REST_Server::READABLE,
        'permission_callback' => 'pubv1_publisher_permission',
        'callback' => 'pubv1_operation_snapshot_callback',
    ));
    register_rest_route('publication-v1/v1', '/approve', array(
        'methods' => WP_REST_Server::CREATABLE,
        'permission_callback' => 'pubv1_reviewer_permission',
        'callback' => 'pubv1_approve_callback',
    ));
    register_rest_route('publication-v1/v1', '/commit', array(
        'methods' => WP_REST_Server::CREATABLE,
        'permission_callback' => 'pubv1_publisher_permission',
        'callback' => 'pubv1_commit_callback',
    ));
});
