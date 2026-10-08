<?php
/**
 * Plugin Name: Publication v1 isolated server candidate
 * Description: Review-gated, content-addressed initial-post publication boundary.
 * Version: 0.1.0
 */
if (!defined('ABSPATH')) {
    exit;
}

require_once __DIR__ . '/support.php';
require_once __DIR__ . '/resources.php';
require_once __DIR__ . '/workflow.php';

register_activation_hook(__FILE__, 'pubv1_activate');
