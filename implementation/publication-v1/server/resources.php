<?php
if (!defined('ABSPATH')) {
    exit;
}

function pubv1_public_post_matches($operation_id, $record) {
    if (($record['state'] ?? '') !== 'committed' || !isset($record['post_id'])) {
        return false;
    }
    $s = $record['snapshot'];
    $post = get_post((int) $record['post_id']);
    return $post instanceof WP_Post
        && $post->post_type === 'post'
        && $post->post_status === 'publish'
        && (int) $post->post_author === (int) $s['publisher_id']
        && (int) $s['target_id'] === 0
        && $post->post_title === $s['title']
        && $post->post_content === $s['content']
        && get_post_meta($post->ID, '_publication_v1_operation', true) === $operation_id;
}

function pubv1_reviewer_cookie_user() {
    $uid = wp_validate_auth_cookie('', 'logged_in');
    if (!$uid || (int) $uid !== (int) get_current_user_id() || !user_can((int) $uid, 'approve_publication_v1')) {
        return false;
    }
    return (int) $uid;
}

function pubv1_resource_url($operation_id, $path) {
    return rest_url('publication-v1/v1/resources/' . $operation_id . '/' . $path);
}

function pubv1_resource_callback($request) {
    $operation_id = $request['id'];
    $path = $request['path'];
    if (!pubv1_hex($operation_id, 32) || !pubv1_asset_mime($path)) {
        return pubv1_error('resource_unavailable', 404);
    }
    $record = get_option(pubv1_option_key($operation_id));
    if (!is_array($record) || !is_array($record['snapshot'] ?? null)) {
        return pubv1_error('resource_unavailable', 404);
    }
    $s = $record['snapshot'];
    $asset = $s['inventory'][$path] ?? null;
    if (!is_array($asset)) {
        return pubv1_error('resource_unavailable', 404);
    }
    $public = pubv1_public_post_matches($operation_id, $record);
    if ($public) {
        if (!pubv1_current($record)) {
            return pubv1_error('resource_changed', 409);
        }
    } else {
        $reviewer_id = pubv1_reviewer_cookie_user();
        if (!$reviewer_id || (int) $reviewer_id === (int) $s['publisher_id'] || (int) ($s['expires_at'] ?? 0) <= time() || !in_array($record['state'] ?? '', array('pending', 'approved'), true)) {
            return pubv1_error('resource_unavailable', 404);
        }
        if (!pubv1_current($record)) {
            return pubv1_error('resource_changed', 409);
        }
    }
    $package = pubv1_load_package($s['manifest_sha256'] ?? '');
    $bytes = $package && isset($package['_inventory_bytes'][$path]) ? $package['_inventory_bytes'][$path] : false;
    if (!is_string($bytes) || strlen($bytes) !== (int) $asset['bytes'] || !hash_equals($asset['sha256'], hash('sha256', $bytes))) {
        return pubv1_error('resource_changed', 409);
    }
    return new WP_REST_Response(array(
        '_publication_v1_bytes' => base64_encode($bytes),
        '_publication_v1_mime' => $asset['mime'],
        '_publication_v1_public' => $public,
    ), 200, array(
        'Cache-Control' => $public ? 'public, max-age=31536000, immutable' : 'private, no-store',
        'X-Content-Type-Options' => 'nosniff',
    ));
}

function pubv1_serve_resource_bytes($served, $result, $request, $server) {
    $data = $result instanceof WP_REST_Response ? $result->get_data() : null;
    if (!is_array($data) || !isset($data['_publication_v1_bytes'], $data['_publication_v1_mime']) || strpos($request->get_route(), '/publication-v1/v1/resources/') !== 0) {
        return $served;
    }
    $bytes = base64_decode($data['_publication_v1_bytes'], true);
    if (!is_string($bytes)) {
        return $served;
    }
    header('Content-Type: ' . $data['_publication_v1_mime']);
    header('Cache-Control: ' . (!empty($data['_publication_v1_public']) ? 'public, max-age=31536000, immutable' : 'private, no-store'));
    header('X-Content-Type-Options: nosniff');
    echo $bytes;
    return true;
}

function pubv1_enqueue_public_styles() {
    if (!is_singular('post')) {
        return;
    }
    $post_id = (int) get_queried_object_id();
    $operation_id = get_post_meta($post_id, '_publication_v1_operation', true);
    if (!pubv1_hex($operation_id, 32)) {
        return;
    }
    $record = get_option(pubv1_option_key($operation_id));
    if (!is_array($record) || !pubv1_public_post_matches($operation_id, $record) || !pubv1_current($record)) {
        return;
    }
    foreach ($record['snapshot']['inventory'] as $path => $asset) {
        if (($asset['mime'] ?? '') !== 'text/css') {
            continue;
        }
        $handle = 'publication-v1-' . substr(hash('sha256', $path), 0, 16);
        wp_enqueue_style($handle, pubv1_resource_url($operation_id, $path), array(), $asset['sha256']);
    }
}

add_action('rest_api_init', function () {
    register_rest_route('publication-v1/v1', '/resources/(?P<id>[a-f0-9]{32})/(?P<path>assets/[A-Za-z0-9_./-]+)', array(
        'methods' => WP_REST_Server::READABLE,
        'permission_callback' => '__return_true',
        'callback' => 'pubv1_resource_callback',
    ));
});
add_filter('rest_pre_serve_request', 'pubv1_serve_resource_bytes', 10, 4);
add_action('wp_enqueue_scripts', 'pubv1_enqueue_public_styles');
