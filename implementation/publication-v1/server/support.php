<?php
/**
 * Shared server boundary for the isolated publication-v1 candidate.
 * The canonical producer manifest keys are schema, selected, source_sha256,
 * labels_sha256, title, compiler, and inventory. preview.html is the sole
 * content source; inventory records bind exact bytes and SHA-256. Authenticated
 * receive writes these exact bytes through private same-filesystem staging;
 * the loader remains a content-addressed store verifier, not an archive reader.
 */
if (!defined('ABSPATH')) {
    exit;
}

function pubv1_error($code, $status = 400) {
    return new WP_Error($code, $code, array('status' => $status));
}

function pubv1_hex($value, $length = 64) {
    return is_string($value) && (bool) preg_match('/^[a-f0-9]{' . (int) $length . '}$/D', $value);
}

function pubv1_canonicalize($value) {
    if (!is_array($value)) {
        return $value;
    }
    if (!array_is_list($value)) {
        ksort($value, SORT_STRING);
    }
    foreach ($value as $key => $child) {
        $value[$key] = pubv1_canonicalize($child);
    }
    return $value;
}

function pubv1_canonical_json($value) {
    return wp_json_encode(pubv1_canonicalize($value), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}

function pubv1_selected_path_valid($selected) {
    if (!is_string($selected) || $selected === '' || strlen($selected) > 4096 || strpos($selected, chr(92)) !== false || strpos($selected, ':') !== false || strpos($selected, chr(0)) !== false || !preg_match('//u', $selected) || substr($selected, -3) !== '.md') {
        return false;
    }
    foreach (explode('/', $selected) as $part) {
        if ($part === '' || $part === '.' || $part === '..' || (isset($part[0]) && $part[0] === '.')) {
            return false;
        }
    }
    return true;
}

function pubv1_title_valid($title) {
    if (!is_string($title) || trim($title) === '' || strlen($title) > 800 || !preg_match('//u', $title) || preg_match('/[[:cntrl:]]/u', $title)) {
        return false;
    }
    return preg_match_all('/./us', $title, $characters) !== false && count($characters[0]) <= 200;
}

function pubv1_compiler_valid($compiler) {
    if (!is_array($compiler) || count($compiler) !== 2 || array_diff(array_keys($compiler), array('files', 'toolchain'))) {
        return false;
    }
    $files = $compiler['files'] ?? null;
    $expected_files = array('package_builder.py', 'reader.py', 'render.cjs');
    if (!is_array($files) || count($files) !== count($expected_files)) {
        return false;
    }
    $file_names = array_keys($files);
    sort($file_names, SORT_STRING);
    sort($expected_files, SORT_STRING);
    if ($file_names !== $expected_files) {
        return false;
    }
    foreach ($files as $digest) {
        if (!pubv1_hex($digest)) {
            return false;
        }
    }
    $toolchain = $compiler['toolchain'] ?? null;
    $expected_toolchain = array('dependency_manifest_sha256', 'katex', 'markdown_it', 'node', 'package_lock_sha256');
    if (!is_array($toolchain) || count($toolchain) !== count($expected_toolchain)) {
        return false;
    }
    $toolchain_names = array_keys($toolchain);
    sort($toolchain_names, SORT_STRING);
    sort($expected_toolchain, SORT_STRING);
    if ($toolchain_names !== $expected_toolchain || !preg_match('~^v[0-9]+[.][0-9]+[.][0-9]+$~D', $toolchain['node'] ?? '') || !is_string($toolchain['markdown_it'] ?? null) || $toolchain['markdown_it'] === '' || !is_string($toolchain['katex'] ?? null) || $toolchain['katex'] === '' || !pubv1_hex($toolchain['dependency_manifest_sha256'] ?? null) || !pubv1_hex($toolchain['package_lock_sha256'] ?? null)) {
        return false;
    }
    $canonical = pubv1_canonical_json($compiler);
    return defined('BLOG_V1_COMPILER_SHA256') && pubv1_hex(BLOG_V1_COMPILER_SHA256) && is_string($canonical) && hash_equals(BLOG_V1_COMPILER_SHA256, hash('sha256', $canonical));
}

function pubv1_digest($value) {
    $json = wp_json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    return is_string($json) ? hash('sha256', $json) : false;
}

function pubv1_path_inside($path, $parent) {
    $path = rtrim(wp_normalize_path($path), '/');
    $parent = rtrim(wp_normalize_path($parent), '/');
    if (DIRECTORY_SEPARATOR === '\\') {
        $path = strtolower($path);
        $parent = strtolower($parent);
    }
    return $path === $parent || strpos($path, $parent . '/') === 0;
}

function pubv1_has_link_component($path) {
    $path = wp_normalize_path($path);
    if (preg_match('/^[A-Za-z]:\//', $path)) {
        $current = substr($path, 0, 3);
        $parts = explode('/', substr($path, 3));
    } elseif (isset($path[0]) && $path[0] === '/') {
        $current = '/';
        $parts = explode('/', substr($path, 1));
    } else {
        return true;
    }
    foreach ($parts as $part) {
        if ($part === '') {
            continue;
        }
        $current = rtrim($current, '/') . '/' . $part;
        if (is_link($current)) {
            return true;
        }
    }
    return false;
}

function pubv1_store_root() {
    if (!defined('BLOG_V1_STORE') || !is_string(BLOG_V1_STORE) || BLOG_V1_STORE === '') {
        return false;
    }
    if (!defined('BLOG_V1_COMPILER_SHA256') || !pubv1_hex(BLOG_V1_COMPILER_SHA256)) {
        return false;
    }
    $configured = wp_normalize_path(BLOG_V1_STORE);
    $absolute = (isset($configured[0]) && $configured[0] === '/') || (bool) preg_match('/^[A-Za-z]:\//', $configured);
    if (!$absolute || pubv1_has_link_component($configured) || !is_dir($configured) || is_link($configured)) {
        return false;
    }
    $root = realpath($configured);
    $wordpress_root = realpath(ABSPATH);
    $document_root = isset($_SERVER['DOCUMENT_ROOT']) && is_string($_SERVER['DOCUMENT_ROOT']) ? realpath($_SERVER['DOCUMENT_ROOT']) : false;
    if (!$root || !$wordpress_root || !$document_root || !is_dir($root) || pubv1_has_link_component($root)) {
        return false;
    }
    if (pubv1_path_inside($root, $wordpress_root) || pubv1_path_inside($root, $document_root)) {
        return false;
    }
    return $root;
}

function pubv1_safe_file($root, $parts, $max_bytes) {
    $current = $root;
    foreach ($parts as $part) {
        if (!is_string($part) || $part === '' || $part === '.' || $part === '..' || strpos($part, '/') !== false || strpos($part, '\\') !== false || strpos($part, "\0") !== false) {
            return false;
        }
        $current = rtrim($current, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $part;
        if (is_link($current)) {
            return false;
        }
    }
    $real = realpath($current);
    if (!$real || pubv1_path_inside($real, $root) !== true || !is_file($real) || is_link($real)) {
        return false;
    }
    $size = filesize($real);
    if ($size === false || $size < 0 || $size > $max_bytes) {
        return false;
    }
    $bytes = file_get_contents($real);
    return is_string($bytes) && strlen($bytes) === $size ? $bytes : false;
}

function pubv1_asset_mime($path) {
    if (!is_string($path) || !preg_match('~^assets/(?:[A-Za-z0-9][A-Za-z0-9_.-]*/)*[A-Za-z0-9][A-Za-z0-9_.-]*\.(css|woff2|woff|ttf|otf|png)$~D', $path, $match)) {
        return false;
    }
    $types = array(
        'css' => 'text/css',
        'woff2' => 'font/woff2',
        'woff' => 'font/woff',
        'ttf' => 'font/ttf',
        'otf' => 'font/otf',
        'png' => 'image/png',
    );
    return $types[$match[1]];
}

function pubv1_package_mime($path) {
    return $path === 'preview.html' ? 'text/html' : pubv1_asset_mime($path);
}

function pubv1_asset_bytes_match_type($mime, $bytes) {
    if (!is_string($bytes) || $bytes === '') {
        return false;
    }
    if ($mime === 'image/png') {
        return strlen($bytes) >= 8 && substr($bytes, 0, 8) === "\x89PNG\r\n\x1a\n";
    }
    if ($mime === 'font/woff2') {
        return substr($bytes, 0, 4) === 'wOF2';
    }
    if ($mime === 'font/woff') {
        return substr($bytes, 0, 4) === 'wOFF';
    }
    if ($mime === 'font/ttf') {
        return substr($bytes, 0, 4) === "\x00\x01\x00\x00" || substr($bytes, 0, 4) === 'true';
    }
    if ($mime === 'font/otf') {
        return substr($bytes, 0, 4) === 'OTTO';
    }
    return in_array($mime, array('text/css', 'text/html'), true) && strpos($bytes, "\0") === false && (bool) preg_match('//u', $bytes);
}

function pubv1_resolve_css_reference($css_path, $reference) {
    if (!is_string($reference) || $reference === '' || preg_match('~^(?:[a-z]+:|//|/|#)|[\\\\%?#:]|\s~i', $reference)) {
        return false;
    }
    $base = explode('/', dirname($css_path));
    $parts = array_merge($base, explode('/', $reference));
    $resolved = array();
    foreach ($parts as $part) {
        if ($part === '' || $part === '.') {
            continue;
        }
        if ($part === '..') {
            if (count($resolved) <= 1 || $resolved[0] !== 'assets') {
                return false;
            }
            array_pop($resolved);
            continue;
        }
        if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9_.-]*$/D', $part)) {
            return false;
        }
        $resolved[] = $part;
    }
    if (!$resolved || $resolved[0] !== 'assets') {
        return false;
    }
    return implode('/', $resolved);
}

function pubv1_manifest_valid($manifest, $inventory_bytes = null) {
    $required = array('schema', 'selected', 'source_sha256', 'labels_sha256', 'title', 'compiler', 'inventory');
    if (!is_array($manifest) || count($manifest) !== count($required) || array_diff(array_keys($manifest), $required)) {
        return false;
    }
    if (($manifest['schema'] ?? null) !== 'publication-v1' || !pubv1_selected_path_valid($manifest['selected'] ?? null) || !pubv1_hex($manifest['source_sha256'] ?? null) || !pubv1_hex($manifest['labels_sha256'] ?? null) || !pubv1_title_valid($manifest['title'] ?? null) || !pubv1_compiler_valid($manifest['compiler'] ?? null)) {
        return false;
    }
    $inventory = $manifest['inventory'] ?? null;
    if (!is_array($inventory) || count($inventory) < 2 || count($inventory) > 128 || !isset($inventory['preview.html'], $inventory['assets/katex.min.css'])) {
        return false;
    }
    $total = 0;
    foreach ($inventory as $path => $record) {
        $mime = pubv1_package_mime($path);
        if (!$mime || !is_array($record) || count($record) !== 2 || array_diff(array_keys($record), array('bytes', 'sha256')) || !is_int($record['bytes'] ?? null) || $record['bytes'] < 1 || $record['bytes'] > 2000000 || !pubv1_hex($record['sha256'] ?? null)) {
            return false;
        }
        if (strpos($path, 'assets/images/') === 0 && (!preg_match('~^assets/images/([a-f0-9]{64})\\.png$~D', $path, $image_hash) || !hash_equals($image_hash[1], $record['sha256']))) {
            return false;
        }
        $total += $record['bytes'];
        if ($total > 16000000) {
            return false;
        }
        if (is_array($inventory_bytes)) {
            $bytes = $inventory_bytes[$path] ?? false;
            if (!is_string($bytes) || strlen($bytes) !== $record['bytes'] || !hash_equals($record['sha256'], hash('sha256', $bytes)) || !pubv1_asset_bytes_match_type($mime, $bytes)) {
                return false;
            }
        }
    }
    if (is_array($inventory_bytes)) {
        if (count($inventory_bytes) !== count($inventory)) {
            return false;
        }
        foreach ($inventory as $path => $record) {
            if (pubv1_package_mime($path) !== 'text/css') {
                continue;
            }
            $css = $inventory_bytes[$path];
            if (stripos($css, '@import') !== false || preg_match('~expression[[:space:]]*[(]|(?:https?:)?//~i', $css)) {
                return false;
            }
            preg_match_all('~url[(][[:space:]]*([^)]+?)[[:space:]]*[)]~i', $css, $refs);
            foreach ($refs[1] as $ref) {
                $ref = trim($ref, " " . chr(9) . chr(10) . chr(13) . chr(34) . chr(39));
                $resolved = pubv1_resolve_css_reference($path, $ref);
                if (!$resolved || !isset($inventory[$resolved]) || !in_array(pubv1_asset_mime($resolved), array('font/woff2', 'font/woff', 'font/ttf', 'font/otf', 'image/png'), true)) {
                    return false;
                }
            }
        }
    }
    return true;
}

function pubv1_load_package($manifest_sha256) {
    if (!pubv1_hex($manifest_sha256)) {
        return false;
    }
    $root = pubv1_store_root();
    if (!$root) {
        return false;
    }
    $raw = pubv1_safe_file($root, array($manifest_sha256, 'manifest.json'), 65536);
    if (!is_string($raw) || !hash_equals($manifest_sha256, hash('sha256', $raw))) {
        return false;
    }
    $manifest = json_decode($raw, true);
    $canonical = is_array($manifest) ? pubv1_canonical_json($manifest) : false;
    if (!is_array($manifest) || json_last_error() !== JSON_ERROR_NONE || !is_string($canonical) || !hash_equals($canonical, $raw) || !pubv1_manifest_valid($manifest)) {
        return false;
    }
    if (!pubv1_inventory_directory_matches($root, $manifest_sha256, $manifest['inventory'])) {
        return false;
    }
    $bytes = array();
    foreach ($manifest['inventory'] as $path => $record) {
        $parts = array_merge(array($manifest_sha256, 'bundle'), explode('/', $path));
        $asset = pubv1_safe_file($root, $parts, 2000000);
        if (!is_string($asset)) {
            return false;
        }
        $bytes[$path] = $asset;
    }
    if (!pubv1_manifest_valid($manifest, $bytes)) {
        return false;
    }
    $manifest['_raw_sha256'] = $manifest_sha256;
    $manifest['_inventory_bytes'] = $bytes;
    return $manifest;
}

function pubv1_inventory_directory_matches($root, $manifest_sha256, $expected) {
    $directory = rtrim($root, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $manifest_sha256 . DIRECTORY_SEPARATOR . 'bundle';
    if (is_link($directory) || !is_dir($directory)) {
        return false;
    }
    $real = realpath($directory);
    if (!$real || !pubv1_path_inside($real, $root) || pubv1_has_link_component($real)) {
        return false;
    }
    $seen = array();
    try {
        $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($real, FilesystemIterator::SKIP_DOTS));
        foreach ($iterator as $entry) {
            if ($entry->isLink()) {
                return false;
            }
            if ($entry->isDir()) {
                continue;
            }
            if (!$entry->isFile()) {
                return false;
            }
            $relative = substr(wp_normalize_path($entry->getPathname()), strlen(rtrim(wp_normalize_path($real), '/')) + 1);
            if (!isset($expected[$relative]) || !pubv1_package_mime($relative) || isset($seen[$relative])) {
                return false;
            }
            $seen[$relative] = true;
        }
    } catch (UnexpectedValueException $exception) {
        return false;
    }
    return count($seen) === count($expected);
}

function pubv1_policy() {
    $files = glob(__DIR__ . '/*.php');
    if (!is_array($files) || count($files) < 4) {
        return false;
    }
    sort($files, SORT_STRING);
    $sources = array();
    foreach ($files as $file) {
        $sha = hash_file('sha256', $file);
        if (!is_string($sha)) {
            return false;
        }
        $sources[basename($file)] = $sha;
    }
    return array(
        'schema' => 'publication-v1',
        'compiler_sha256' => defined('BLOG_V1_COMPILER_SHA256') ? BLOG_V1_COMPILER_SHA256 : '',
        'product_sources' => $sources,
        'wordpress_version' => get_bloginfo('version'),
    );
}

function pubv1_preview_body($preview, $title) {
    $escaped = strtr($title, array('&' => '&amp;', '<' => '&lt;', '>' => '&gt;', '"' => '&quot;', chr(39) => '&#x27;'));
    $prefix = '<!doctype html><html><head><meta charset="utf-8"><title>' . $escaped . '</title><link rel="stylesheet" href="assets/katex.min.css"></head><body>';
    $suffix = '</body></html>';
    if (!is_string($preview) || strpos($preview, $prefix) !== 0 || substr($preview, -strlen($suffix)) !== $suffix) {
        return false;
    }
    $body = substr($preview, strlen($prefix), strlen($preview) - strlen($prefix) - strlen($suffix));
    return $body !== '' && strlen($body) <= 65536 ? $body : false;
}

function pubv1_content_for_operation($operation_id, $body, $inventory) {
    $matched = preg_match_all('~<img[[:space:]][^>]*>~i', $body, $images);
    $open_tags = preg_match_all('~<img[[:space:]]~i', $body, $unused);
    if ($matched === false || $open_tags !== $matched) {
        return false;
    }
    $valid = true;
    $content = preg_replace_callback('~<img[[:space:]][^>]*>~i', function ($match) use ($operation_id, $inventory, &$valid) {
        $tag = $match[0];
        if (!preg_match('~src="([^"]*)"~i', $tag, $source) || !preg_match('~^assets/images/([a-f0-9]{64})[.]png$~D', $source[1], $digest)) {
            $valid = false;
            return $tag;
        }
        $path = 'assets/images/' . $digest[1] . '.png';
        $asset = $inventory[$path] ?? null;
        if (!is_array($asset) || pubv1_asset_mime($path) !== 'image/png' || !hash_equals($digest[1], $asset['sha256'])) {
            $valid = false;
            return $tag;
        }
        $url = htmlspecialchars(pubv1_resource_url($operation_id, $path), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        return str_replace($source[0], 'src="' . $url . '"', $tag);
    }, $body);
    return $valid && is_string($content) ? $content : false;
}

function pubv1_freeze($operation_id, $manifest_sha256, $title, $publisher_id, $expires_at) {
    $manifest = pubv1_load_package($manifest_sha256);
    $policy = pubv1_policy();
    if (!$manifest || !$policy || !pubv1_title_valid($title) || $title !== $manifest['title'] || !is_int($publisher_id) || $publisher_id < 1 || !is_int($expires_at)) {
        return false;
    }
    $preview = $manifest['_inventory_bytes']['preview.html'] ?? false;
    $body = pubv1_preview_body($preview, $manifest['title']);
    $content = is_string($body) ? pubv1_content_for_operation($operation_id, $body, $manifest['inventory']) : false;
    if (!is_string($content) || $content === '' || wp_kses_post($content) !== $content) {
        return false;
    }
    $inventory = array();
    foreach ($manifest['inventory'] as $path => $asset) {
        if ($path === 'preview.html') {
            continue;
        }
        $asset['mime'] = pubv1_asset_mime($path);
        $inventory[$path] = $asset;
    }
    $rendered = apply_filters('the_content', $content);
    if (!is_string($rendered)) {
        return false;
    }
    return array(
        'schema' => 'publication-v1',
        'operation_key' => $operation_id,
        'selected' => $manifest['selected'],
        'source_sha256' => $manifest['source_sha256'],
        'labels_sha256' => $manifest['labels_sha256'],
        'title' => $title,
        'publisher_id' => $publisher_id,
        'site_origin' => home_url('/'),
        'visibility' => 'public',
        'target_id' => 0,
        'baseline_sha256' => str_repeat('0', 64),
        'manifest_sha256' => $manifest_sha256,
        'compiler' => $manifest['compiler'],
        'compiler_sha256' => hash('sha256', pubv1_canonical_json($manifest['compiler'])),
        'inventory' => $inventory,
        'content' => $content,
        'rendered' => $rendered,
        'policy' => $policy,
        'policy_sha256' => pubv1_digest($policy),
        'expires_at' => $expires_at,
    );
}

function pubv1_current($record) {
    if (!is_array($record) || !is_array($record['snapshot'] ?? null) || !pubv1_hex($record['digest'] ?? null)) {
        return false;
    }
    if (!hash_equals($record['digest'], (string) pubv1_digest($record['snapshot']))) {
        return false;
    }
    $s = $record['snapshot'];
    $now = pubv1_freeze($s['operation_key'] ?? '', $s['manifest_sha256'] ?? '', $s['title'] ?? '', $s['publisher_id'] ?? 0, $s['expires_at'] ?? 0);
    return is_array($now) && hash_equals($record['digest'], (string) pubv1_digest($now));
}

function pubv1_option_key($operation_id) {
    return 'blog_v1_' . $operation_id;
}

function pubv1_read_raw_option($key) {
    global $wpdb;
    return $wpdb->get_var($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $key));
}

function pubv1_cas_option($key, $raw, $next) {
    global $wpdb;
    $serialized = maybe_serialize($next);
    return $wpdb->query($wpdb->prepare(
        "UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s AND option_value = %s",
        $serialized,
        $key,
        $raw
    )) === 1;
}

function pubv1_record_for_owner($operation_id, $owner_id) {
    if (!pubv1_hex($operation_id, 32)) {
        return false;
    }
    $raw = pubv1_read_raw_option(pubv1_option_key($operation_id));
    $record = $raw === null ? false : maybe_unserialize($raw);
    if (!is_array($record) || (int) ($record['snapshot']['publisher_id'] ?? 0) !== (int) $owner_id || ($record['snapshot']['operation_key'] ?? '') !== $operation_id) {
        return false;
    }
    return array($raw, $record);
}

function pubv1_package_owner_option_key($package_id) {
    return 'blog_v1_package_' . $package_id;
}

function pubv1_package_owner_record($package_id) {
    if (!pubv1_hex($package_id)) {
        return false;
    }
    $raw = pubv1_read_raw_option(pubv1_package_owner_option_key($package_id));
    $record = $raw === null ? false : maybe_unserialize($raw);
    $required = array('schema', 'package_id', 'site_id', 'publisher_id');
    if (!is_array($record) || count($record) !== count($required) || array_diff(array_keys($record), $required)
        || ($record['schema'] ?? null) !== 'publication-v1-package-owner'
        || ($record['package_id'] ?? null) !== $package_id
        || !is_int($record['site_id'] ?? null) || $record['site_id'] < 1
        || !is_int($record['publisher_id'] ?? null) || $record['publisher_id'] < 1) {
        return false;
    }
    return $record;
}

function pubv1_package_owned_by($package_id, $publisher_id, $site_id) {
    $record = pubv1_package_owner_record($package_id);
    return $record !== false
        && is_int($publisher_id) && $publisher_id > 0
        && is_int($site_id) && $site_id > 0
        && $record['publisher_id'] === $publisher_id
        && $record['site_id'] === $site_id;
}

function pubv1_remove_private_tree($path) {
    if (is_link($path)) {
        return @unlink($path);
    }
    if (is_file($path)) {
        return @unlink($path);
    }
    if (!is_dir($path)) {
        return true;
    }
    $names = @scandir($path);
    if (!is_array($names)) {
        return false;
    }
    foreach ($names as $name) {
        if ($name === '.' || $name === '..') {
            continue;
        }
        if (!pubv1_remove_private_tree(rtrim($path, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $name)) {
            return false;
        }
    }
    return @rmdir($path);
}

function pubv1_write_staged_file($stage, $relative, $bytes) {
    $parts = explode('/', $relative);
    $name = array_pop($parts);
    $directory = $stage;
    foreach ($parts as $part) {
        if ($part === '' || $part === '.' || $part === '..' || strpos($part, '\\') !== false || strpos($part, "\0") !== false) {
            return false;
        }
        $directory = rtrim($directory, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $part;
        if (is_link($directory) || (file_exists($directory) && !is_dir($directory))) {
            return false;
        }
        if (!is_dir($directory) && !@mkdir($directory, 0700)) {
            return false;
        }
        @chmod($directory, 0700);
    }
    $target = rtrim($directory, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $name;
    if (is_link($target) || file_exists($target) || !pubv1_path_inside($target, $stage)) {
        return false;
    }
    $handle = @fopen($target, 'xb');
    if ($handle === false) {
        return false;
    }
    $written = 0;
    $length = strlen($bytes);
    while ($written < $length) {
        $count = @fwrite($handle, substr($bytes, $written));
        if (!is_int($count) || $count < 1) {
            @fclose($handle);
            @unlink($target);
            return false;
        }
        $written += $count;
    }
    $flushed = @fflush($handle);
    $closed = @fclose($handle);
    @chmod($target, 0600);
    $stored = @file_get_contents($target);
    if (!$flushed || !$closed || !is_string($stored) || strlen($stored) !== $length || !hash_equals(hash('sha256', $bytes), hash('sha256', $stored))) {
        @unlink($target);
        return false;
    }
    return true;
}

function pubv1_register_package_owner($package_id, $publisher_id, $site_id) {
    $key = pubv1_package_owner_option_key($package_id);
    $raw = pubv1_read_raw_option($key);
    if ($raw !== null) {
        return pubv1_package_owned_by($package_id, $publisher_id, $site_id);
    }
    $record = array(
        'schema' => 'publication-v1-package-owner',
        'package_id' => $package_id,
        'site_id' => $site_id,
        'publisher_id' => $publisher_id,
    );
    if (add_option($key, $record, '', false)) {
        return true;
    }
    return pubv1_package_owned_by($package_id, $publisher_id, $site_id);
}

function pubv1_ingest_package($manifest_raw, $files, $publisher_id, $site_id) {
    if (!is_string($manifest_raw) || $manifest_raw === '' || strlen($manifest_raw) > 65536 || !preg_match('//u', $manifest_raw)
        || !is_array($files) || !$files || array_is_list($files)
        || !is_int($publisher_id) || $publisher_id < 1 || !is_int($site_id) || $site_id < 1) {
        return pubv1_error('invalid_package_request', 400);
    }
    $manifest = json_decode($manifest_raw, true);
    $canonical = is_array($manifest) ? pubv1_canonical_json($manifest) : false;
    if (!is_array($manifest) || json_last_error() !== JSON_ERROR_NONE || !is_string($canonical)
        || !hash_equals($canonical, $manifest_raw) || !pubv1_manifest_valid($manifest)) {
        return pubv1_error('invalid_package_manifest', 400);
    }
    $package_id = hash('sha256', $manifest_raw);
    $inventory = $manifest['inventory'];
    if (count($files) !== count($inventory) || array_diff_key($inventory, $files) || array_diff_key($files, $inventory)) {
        return pubv1_error('invalid_package_inventory', 400);
    }
    $bytes_by_path = array();
    $total = 0;
    foreach ($inventory as $path => $record) {
        $mime = pubv1_package_mime($path);
        $encoded = $files[$path] ?? null;
        if (!$mime || !is_string($encoded) || strlen($encoded) > 2666668) {
            return pubv1_error('invalid_package_inventory', 400);
        }
        $bytes = base64_decode($encoded, true);
        if (!is_string($bytes) || base64_encode($bytes) !== $encoded || strlen($bytes) !== $record['bytes']
            || !hash_equals($record['sha256'], hash('sha256', $bytes)) || !pubv1_asset_bytes_match_type($mime, $bytes)) {
            return pubv1_error('invalid_package_resource', 400);
        }
        $total += strlen($bytes);
        if ($total > 16000000) {
            return pubv1_error('invalid_package_inventory', 400);
        }
        $bytes_by_path[$path] = $bytes;
    }
    if (!pubv1_manifest_valid($manifest, $bytes_by_path)) {
        return pubv1_error('invalid_package_inventory', 400);
    }
    $existing_owner = pubv1_package_owner_record($package_id);
    if ($existing_owner !== false && !pubv1_package_owned_by($package_id, $publisher_id, $site_id)) {
        return pubv1_error('package_unavailable', 404);
    }
    $root = pubv1_store_root();
    if (!$root || !is_writable($root) || !@chmod($root, 0700)) {
        return pubv1_error('private_store_unavailable', 503);
    }
    $target = rtrim($root, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $package_id;
    if (is_link($target) || pubv1_has_link_component($target)) {
        return pubv1_error('package_unavailable', 409);
    }
    $created = false;
    if (file_exists($target)) {
        if (!is_dir($target) || !pubv1_load_package($package_id)) {
            return pubv1_error('package_corrupt', 409);
        }
    } else {
        try {
            $stage_name = '.upload-' . bin2hex(random_bytes(16));
        } catch (Throwable $exception) {
            return pubv1_error('private_store_unavailable', 503);
        }
        $stage = rtrim($root, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $stage_name;
        if (!@mkdir($stage, 0700)) {
            return pubv1_error('private_store_unavailable', 503);
        }
        @chmod($stage, 0700);
        $bundle_stage = $stage . DIRECTORY_SEPARATOR . 'bundle';
        if (!@mkdir($bundle_stage, 0700)) {
            pubv1_remove_private_tree($stage);
            return pubv1_error('package_stage_failed', 503);
        }
        @chmod($bundle_stage, 0700);
        $written = pubv1_write_staged_file($stage, 'manifest.json', $manifest_raw);
        if ($written) {
            foreach ($bytes_by_path as $path => $bytes) {
                if (!pubv1_write_staged_file($bundle_stage, $path, $bytes)) {
                    $written = false;
                    break;
                }
            }
        }
        if (!$written) {
            pubv1_remove_private_tree($stage);
            return pubv1_error('package_stage_failed', 503);
        }
        if (!@rename($stage, $target)) {
            pubv1_remove_private_tree($stage);
            if (!is_dir($target) || !pubv1_load_package($package_id)) {
                return pubv1_error('package_stage_conflict', 409);
            }
        } else {
            $created = true;
        }
        if (!pubv1_load_package($package_id)) {
            return pubv1_error('package_stage_invalid', 409);
        }
    }
    if (!pubv1_register_package_owner($package_id, $publisher_id, $site_id)) {
        return pubv1_error('package_unavailable', 404);
    }
    return array(
        'package_id' => $package_id,
        'manifest_sha256' => $package_id,
        'selected' => $manifest['selected'],
        'title' => $manifest['title'],
        'inventory_count' => count($inventory),
        'total_bytes' => $total,
        'created' => $created,
    );
}

