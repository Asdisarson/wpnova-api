<?php
/*
Plugin Name: CSV Product Updater
Description: Updates WooCommerce product files based on a CSV file.
Version: 1.1
Author: WP NOVA
*/

define('FETCH_API_WPNOVA', 'https://seashell-app-duvll.ondigitalocean.app/');
define('WPNOVA_WEBHOOK_SECRET', '2T1pINQJL3g6WGcf8d0d58cf4fd8b26cf7dd2bfafd87da46d');
// 15 minutes (in seconds) for all network calls made by this plugin
if (!defined('CSV_PRODUCT_UPDATER_HTTP_TIMEOUT')) {
    define('CSV_PRODUCT_UPDATER_HTTP_TIMEOUT', defined('MINUTE_IN_SECONDS') ? 15 * MINUTE_IN_SECONDS : 900);
}

// Default price applied ONLY to newly created products (does not modify existing products)
if (!defined('CSV_PRODUCT_UPDATER_CREATED_PRODUCT_PRICE')) {
    define('CSV_PRODUCT_UPDATER_CREATED_PRODUCT_PRICE', '5.99');
}

// Faster/safer defaults for lightweight CDN HEAD checks (these happen during validation/download flows)
if (!defined('CSV_PRODUCT_UPDATER_CDN_HEAD_TIMEOUT')) {
    define('CSV_PRODUCT_UPDATER_CDN_HEAD_TIMEOUT', 15);
}
if (!defined('CSV_PRODUCT_UPDATER_CDN_HEAD_CACHE_TTL')) {
    define('CSV_PRODUCT_UPDATER_CDN_HEAD_CACHE_TTL', defined('MINUTE_IN_SECONDS') ? 10 * MINUTE_IN_SECONDS : 600);
}

// Register activation hook
register_activation_hook(__FILE__, 'csv_product_updater_refresh_activation');

// Activation function for the new task
function csv_product_updater_refresh_activation() {
    if (!wp_next_scheduled('csv_product_updater_refresh_daily_event')) {
        // Schedule the event for 23:00 GMT every day
        wp_schedule_event(strtotime('23:00:00'), 'daily', 'csv_product_updater_refresh_daily_event');
    }
}

// Register deactivation hook for the new task
register_deactivation_hook(__FILE__, 'csv_product_updater_refresh_deactivation');

// Deactivation function for the new task
function csv_product_updater_refresh_deactivation() {
    wp_clear_scheduled_hook('csv_product_updater_refresh_daily_event');
}

// Hook into the daily event to send the GET request
add_action('csv_product_updater_refresh_daily_event', 'send_refresh_request');

// Function to send the GET request to the endpoint
function send_refresh_request($date = null, $force_update = false) {
    $endpoint_url = FETCH_API_WPNOVA . 'refresh';
    
    $params = array();
    if ($date) {
        $params['date'] = $date;
    }
    if ($force_update) {
        // Tell the API to trigger a forced WP update once CSV is generated
        $params['force_update'] = '1';
    }
    if (!empty($params)) {
        $endpoint_url = add_query_arg($params, $endpoint_url);
    }
    $response = wp_remote_get($endpoint_url, array('timeout' => CSV_PRODUCT_UPDATER_HTTP_TIMEOUT));

    // Handle the response if needed
    if (is_wp_error($response)) {
        return $response;
    } else {
        return $response;
    }
}

// Activation function
function csv_product_updater_activation() {
    // This plugin no longer schedules a standalone daily "update products" cron.
    // Updates are triggered after the daily refresh (API) completes and calls the webhook.
    wp_clear_scheduled_hook('csv_product_updater_daily_event');
}

// Deactivation function
function csv_product_updater_deactivation() {
    wp_clear_scheduled_hook('csv_product_updater_daily_event');
}

// Ensure any legacy scheduled "update products" cron is removed (keep only the refresh cron)
add_action('init', function() {
    wp_clear_scheduled_hook('csv_product_updater_daily_event');
});

// Background batch processor hook
add_action('csv_product_updater_process_batch_event', 'csv_product_updater_process_batch');

// Batch size for background updates (keep low to avoid timeouts; each row may download a ZIP)
if (!defined('CSV_PRODUCT_UPDATER_BATCH_SIZE')) {
    define('CSV_PRODUCT_UPDATER_BATCH_SIZE', 1);
}

// Option/transient keys for background job state
if (!defined('CSV_PRODUCT_UPDATER_JOB_STATE_OPTION')) {
    define('CSV_PRODUCT_UPDATER_JOB_STATE_OPTION', 'csv_product_updater_job_state');
}
if (!defined('CSV_PRODUCT_UPDATER_STOP_OPTION')) {
    define('CSV_PRODUCT_UPDATER_STOP_OPTION', 'csv_product_updater_stop_requested');
}
if (!defined('CSV_PRODUCT_UPDATER_JOB_LOCK_TRANSIENT')) {
    define('CSV_PRODUCT_UPDATER_JOB_LOCK_TRANSIENT', 'csv_product_updater_job_lock');
}
if (!defined('CSV_PRODUCT_UPDATER_JOB_LOCK_TTL')) {
    define('CSV_PRODUCT_UPDATER_JOB_LOCK_TTL', defined('MINUTE_IN_SECONDS') ? 5 * MINUTE_IN_SECONDS : 300);
}

// Refresh backfill (start date -> today)
if (!defined('CSV_PRODUCT_UPDATER_REFRESH_QUEUE_OPTION')) {
    define('CSV_PRODUCT_UPDATER_REFRESH_QUEUE_OPTION', 'csv_product_updater_refresh_queue_state');
}
if (!defined('CSV_PRODUCT_UPDATER_REFRESH_QUEUE_MAX_DAYS')) {
    define('CSV_PRODUCT_UPDATER_REFRESH_QUEUE_MAX_DAYS', 90);
}

// WP-Cron hook for refresh queue processing
add_action('csv_product_updater_process_refresh_queue_event', 'csv_product_updater_process_refresh_queue');

// Log retention (days)
if (!defined('CSV_PRODUCT_UPDATER_LOG_RETENTION_DAYS')) {
    define('CSV_PRODUCT_UPDATER_LOG_RETENTION_DAYS', 3);
}

/**
 * Normalize + prune the update log (removes entries older than retention window).
 *
 * Notes:
 * - Historically the log was stored as plain strings without timestamps.
 * - We now ensure every log line is prefixed with "[YYYY-mm-dd HH:MM:SS]" (WP timezone).
 * - If an entry contains an embedded MySQL datetime, we use that as its timestamp for pruning.
 * - If no timestamp is detectable, we treat it as "now" (so it will expire in the next 3 days).
 *
 * @param mixed $log
 * @return array
 */
function csv_product_updater_normalize_and_prune_log($log) {
    if (!is_array($log)) {
    $log = array();
    }

    $now_ts = (int) current_time('timestamp');
    $now_mysql = (string) current_time('mysql');
    $retention_seconds = (int) (CSV_PRODUCT_UPDATER_LOG_RETENTION_DAYS * (defined('DAY_IN_SECONDS') ? DAY_IN_SECONDS : 86400));
    $cutoff = $now_ts - $retention_seconds;

    $out = array();
    foreach ($log as $entry) {
        if (!is_string($entry)) {
            // Best-effort stringify
            $entry = is_scalar($entry) ? (string) $entry : wp_json_encode($entry);
        }
        $entry = trim($entry);
        if ($entry === '') continue;

        $ts = $now_ts;
        $normalized = $entry;

        // 1) If already prefixed, parse the prefix timestamp
        if (preg_match('/^\\[(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})\\]\\s*/', $entry, $m)) {
            $parsed = strtotime($m[1]);
            if ($parsed !== false) {
                $ts = (int) $parsed;
            }
        } else {
            // 2) Try to find an embedded MySQL datetime anywhere in the message
            if (preg_match('/(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})/', $entry, $m)) {
                $parsed = strtotime($m[1]);
                if ($parsed !== false) {
                    $ts = (int) $parsed;
                    $normalized = '[' . $m[1] . '] ' . $entry;
                } else {
                    $normalized = '[' . $now_mysql . '] ' . $entry;
                }
            } else {
                // 3) No timestamp detectable → treat as now so it will roll off in 3 days
                $normalized = '[' . $now_mysql . '] ' . $entry;
            }
        }

        if ($ts < $cutoff) {
            continue;
        }
        $out[] = $normalized;
    }

    return $out;
}

/**
 * Persist the update log after pruning (non-autoload).
 *
 * @param mixed $log
 * @return array Pruned log
 */
function csv_product_updater_save_log($log) {
    $pruned = csv_product_updater_normalize_and_prune_log($log);
    update_option('csv_product_updater_log', $pruned, false);
    return $pruned;
}

/**
 * Get refresh queue state.
 *
 * @return array
 */
function csv_product_updater_get_refresh_queue_state() {
    $state = get_option(CSV_PRODUCT_UPDATER_REFRESH_QUEUE_OPTION, array());
    return is_array($state) ? $state : array();
}

/**
 * Save refresh queue state (non-autoload).
 *
 * @param array $state
 * @return void
 */
function csv_product_updater_save_refresh_queue_state($state) {
    if (!is_array($state)) $state = array();
    update_option(CSV_PRODUCT_UPDATER_REFRESH_QUEUE_OPTION, $state, false);
}

/**
 * Build list of dates from start date to today (inclusive), capped.
 *
 * @param string $start_date Y-m-d
 * @return array|WP_Error
 */
function csv_product_updater_build_backfill_dates($start_date) {
    $start_date = (string) $start_date;
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $start_date)) {
        return new WP_Error('invalid_date', 'Invalid date format. Use YYYY-MM-DD.');
    }

    $tz = function_exists('wp_timezone') ? wp_timezone() : new DateTimeZone('UTC');
    $start = DateTimeImmutable::createFromFormat('Y-m-d', $start_date, $tz);
    if (!$start) {
        return new WP_Error('invalid_date', 'Invalid start date.');
    }
    $today_str = date('Y-m-d', (int) current_time('timestamp'));
    $end = DateTimeImmutable::createFromFormat('Y-m-d', $today_str, $tz);
    if (!$end) {
        return new WP_Error('invalid_date', 'Could not determine today.');
    }

    if ($start > $end) {
        return new WP_Error('invalid_date', 'Start date cannot be in the future.');
    }

    $diffDays = (int) $start->diff($end)->days;
    $inclusiveDays = $diffDays + 1;
    if ($inclusiveDays > (int) CSV_PRODUCT_UPDATER_REFRESH_QUEUE_MAX_DAYS) {
        return new WP_Error(
            'date_too_old',
            'Start date is too far in the past. Max backfill is ' . (int) CSV_PRODUCT_UPDATER_REFRESH_QUEUE_MAX_DAYS . ' days.'
        );
    }

    $dates = array();
    $cur = $start;
    while ($cur <= $end) {
        $dates[] = $cur->format('Y-m-d');
        $cur = $cur->modify('+1 day');
    }

    return $dates;
}

/**
 * Start a backfill refresh queue (start date -> today).
 *
 * @param string $start_date
 * @param bool   $force_update
 * @param string $source
 * @return array|WP_Error
 */
function csv_product_updater_start_refresh_queue($start_date, $force_update = false, $source = 'admin_form') {
    $existing = csv_product_updater_get_refresh_queue_state();
    if (isset($existing['status']) && $existing['status'] === 'running') {
        return $existing;
    }

    $dates = csv_product_updater_build_backfill_dates($start_date);
    if (is_wp_error($dates)) {
        return $dates;
    }

    $state = array(
        'status'       => 'running',
        'started_at'   => current_time('mysql'),
        'updated_at'   => current_time('mysql'),
        'source'       => (string) $source,
        'force_update' => (bool) $force_update,
        'dates'        => $dates,
        'index'        => 0,
        'last_sent_date' => '',
        'last_sent_at'   => '',
        'last_response_code' => null,
        'last_error'    => '',
        'last_message'  => '',
    );

    csv_product_updater_save_refresh_queue_state($state);

    // Kick off processing quickly
    wp_schedule_single_event(time() + 1, 'csv_product_updater_process_refresh_queue_event');

    // Log start
    $log = get_option('csv_product_updater_log', array());
    if (!is_array($log)) $log = array();
    array_unshift(
        $log,
        sprintf(
            'Backfill refresh started (%s): %s → %s (%d day(s)). Force: %s.',
            $source,
            $dates[0],
            $dates[count($dates) - 1],
            count($dates),
            $force_update ? 'true' : 'false'
        )
    );
    csv_product_updater_save_log($log);

    return $state;
}

/**
 * WP-Cron runner: process one day in the refresh backfill queue.
 *
 * It waits for the product update job to finish before moving to the next day.
 */
function csv_product_updater_process_refresh_queue() {
    $state = csv_product_updater_get_refresh_queue_state();
    if (!is_array($state) || !isset($state['status']) || $state['status'] !== 'running') {
        return;
    }

    $dates = (isset($state['dates']) && is_array($state['dates'])) ? $state['dates'] : array();
    $total = count($dates);
    $index = isset($state['index']) ? (int) $state['index'] : 0;
    $force_update = isset($state['force_update']) ? (bool) $state['force_update'] : false;

    if ($total <= 0) {
        $state['status'] = 'error';
        $state['last_error'] = 'Refresh queue has no dates.';
        $state['updated_at'] = current_time('mysql');
        csv_product_updater_save_refresh_queue_state($state);
        return;
    }

    // Wait while the update job is running
    $job = csv_product_updater_get_job_state();
    if (is_array($job) && isset($job['status']) && $job['status'] === 'running') {
        $state['last_message'] = 'Waiting for product update job to finish...';
        $state['updated_at'] = current_time('mysql');
        csv_product_updater_save_refresh_queue_state($state);
        wp_schedule_single_event(time() + 60, 'csv_product_updater_process_refresh_queue_event');
        return;
    }

    if ($index >= $total) {
        $state['status'] = 'completed';
        $state['completed_at'] = current_time('mysql');
        $state['last_message'] = 'Backfill refresh completed.';
        $state['updated_at'] = current_time('mysql');
        csv_product_updater_save_refresh_queue_state($state);

        $log = get_option('csv_product_updater_log', array());
        if (!is_array($log)) $log = array();
        array_unshift($log, 'Backfill refresh completed at ' . $state['completed_at']);
        csv_product_updater_save_log($log);
        return;
    }

    $date = $dates[$index];
    $human = sprintf('Backfill refresh %d/%d for %s', $index + 1, $total, $date);

    $state['last_message'] = $human;
    $state['updated_at'] = current_time('mysql');
    csv_product_updater_save_refresh_queue_state($state);

    $log = get_option('csv_product_updater_log', array());
    if (!is_array($log)) $log = array();
    array_unshift($log, $human . ' — requesting /refresh');
    csv_product_updater_save_log($log);

    $response = send_refresh_request($date, $force_update);
    if (is_wp_error($response)) {
        $state['status'] = 'error';
        $state['last_error'] = 'Refresh request failed for ' . $date . ': ' . $response->get_error_message();
        $state['updated_at'] = current_time('mysql');
        csv_product_updater_save_refresh_queue_state($state);

        $log = get_option('csv_product_updater_log', array());
        if (!is_array($log)) $log = array();
        array_unshift($log, $state['last_error']);
        csv_product_updater_save_log($log);
        return;
    }

    $code = wp_remote_retrieve_response_code($response);
    $state['last_response_code'] = $code;
    $state['last_sent_date'] = $date;
    $state['last_sent_at'] = current_time('mysql');
    $state['index'] = $index + 1;
    $state['last_message'] = sprintf('Refresh complete for %s (HTTP %s). Starting update job...', $date, $code);
    $state['updated_at'] = current_time('mysql');
    csv_product_updater_save_refresh_queue_state($state);

    $log = get_option('csv_product_updater_log', array());
    if (!is_array($log)) $log = array();
    array_unshift($log, sprintf('Backfill refresh %d/%d complete for %s (HTTP %s).', $index + 1, $total, $date, $code));
    csv_product_updater_save_log($log);

    // Start the product update job for this day's refreshed CSV (best-effort; webhook may also start it)
    csv_product_updater_start_job($force_update, 'refresh_queue');

    $log = get_option('csv_product_updater_log', array());
    if (!is_array($log)) $log = array();
    array_unshift($log, 'Queued product update job for refreshed date ' . $date);
    csv_product_updater_save_log($log);

    // Re-run soon; we will wait for the job to finish before sending the next day.
    wp_schedule_single_event(time() + 60, 'csv_product_updater_process_refresh_queue_event');
}

/**
 * Safely get a value from a CSV row by index.
 */
function csv_product_updater_row_value($row, $index, $default = '') {
    if (!is_array($row) || !isset($row[$index])) {
        return $default;
    }
    $value = $row[$index];
    if (is_string($value)) {
        return trim($value);
    }
    return $value;
}

/**
 * Find a product by its slug (post_name) or by a stored "source slug" meta fallback.
 * This prevents duplicate products if WordPress had to modify the slug to keep it unique.
 *
 * @param string $slug
 * @return WP_Post|null
 */
function csv_product_updater_find_product($slug) {
    $slug = sanitize_title((string) $slug);
    if ($slug === '') {
        return null;
    }

    // Primary lookup by path (fast)
    $product = get_page_by_path($slug, OBJECT, 'product');
    if ($product instanceof WP_Post) {
        return $product;
    }

    // Secondary lookup by exact slug across any status
    $query = new WP_Query(array(
        'post_type'      => 'product',
        'name'           => $slug,
        'posts_per_page' => 1,
        'post_status'    => 'any',
        'no_found_rows'  => true,
    ));
    if ($query->have_posts()) {
        $product = $query->posts[0];
        wp_reset_postdata();
        return $product instanceof WP_Post ? $product : null;
    }
    wp_reset_postdata();

    // Fallback: find by stored original/source slug meta
    $query = new WP_Query(array(
        'post_type'      => 'product',
        'posts_per_page' => 1,
        'post_status'    => 'any',
        'no_found_rows'  => true,
        'meta_query'     => array(
            array(
                'key'     => '_csv_product_updater_source_slug',
                'value'   => $slug,
                'compare' => '=',
            ),
        ),
    ));
    if ($query->have_posts()) {
        $product = $query->posts[0];
        wp_reset_postdata();
        return $product instanceof WP_Post ? $product : null;
    }
    wp_reset_postdata();

    return null;
}

/**
 * Create a WooCommerce product from a CSV row.
 *
 * Expected CSV indices (based on Node generator):
 * - 1: productName
 * - 3: name (version stripped)
 * - 7: slug
 * - 14: featuredImageUrl
 * - 15: shortDescription
 * - 16: description
 * - 17: categories (JSON array)
 * - 18: brand
 * - 19: demoUrl (Developer Live Preview)
 *
 * @param array $row
 * @param string $slug
 * @param array $log
 * @return int|WP_Error Product ID on success
 */
function csv_product_updater_create_product_from_row($row, $slug, &$log) {
    $slug = sanitize_title((string) $slug);
    if ($slug === '') {
        return new WP_Error('csv_product_updater_invalid_slug', 'Empty/invalid slug');
    }

    $default_price = (string) CSV_PRODUCT_UPDATER_CREATED_PRODUCT_PRICE;

    // Title preference: "name" column (no version) > productName > slug-derived
    $title = (string) csv_product_updater_row_value($row, 3, '');
    if ($title === '') {
        $title = (string) csv_product_updater_row_value($row, 1, '');
    }
    if ($title === '') {
        $title = ucwords(str_replace('-', ' ', $slug));
    }
    $title = wp_strip_all_tags($title);

    $description        = (string) csv_product_updater_row_value($row, 16, '');
    $short_description  = (string) csv_product_updater_row_value($row, 15, '');
    $featured_image_url = (string) csv_product_updater_row_value($row, 14, '');

    $product_id = 0;

    if (class_exists('WC_Product_Simple')) {
        $product = new WC_Product_Simple();
        $product->set_name($title);
        $product->set_slug($slug);
        $product->set_status('publish');
        $product->set_downloadable(true);
        $product->set_virtual(true);
        $product->set_regular_price($default_price);
        if (method_exists($product, 'set_price')) {
            $product->set_price($default_price);
        }

        if ($description !== '') {
            $product->set_description(wp_kses_post($description));
        }
        if ($short_description !== '') {
            $product->set_short_description(wp_kses_post($short_description));
        }

        $product->save();
        $product_id = (int) $product->get_id();
    } else {
        // Fallback (should rarely happen): create the product post directly
        $postarr = array(
            'post_title'   => $title,
            'post_name'    => $slug,
            'post_status'  => 'publish',
            'post_type'    => 'product',
            'post_content' => $description !== '' ? wp_kses_post($description) : '',
            'post_excerpt' => $short_description !== '' ? wp_kses_post($short_description) : '',
        );
        $inserted = wp_insert_post($postarr, true);
        if (is_wp_error($inserted)) {
            return $inserted;
        }
        $product_id = (int) $inserted;

        // Price meta for fallback path (WooCommerce will also sync these later)
        update_post_meta($product_id, '_regular_price', $default_price);
        update_post_meta($product_id, '_sale_price', '');
        update_post_meta($product_id, '_price', $default_price);
    }

    if ($product_id <= 0) {
        return new WP_Error('csv_product_updater_create_failed', 'Failed to create product');
    }

    // Ensure product type taxonomy is set
    try {
        wp_set_object_terms($product_id, 'simple', 'product_type');
    } catch (Exception $e) {
        // ignore
    }

    // Store a stable "source slug" for future lookups, even if WP had to modify post_name
    update_post_meta($product_id, '_csv_product_updater_source_slug', $slug);

    // If WordPress changed the slug due to a conflict, log it (updates will still find by meta)
    $actual_slug = (string) get_post_field('post_name', $product_id);
    if ($actual_slug !== '' && $actual_slug !== $slug) {
        $log[] = 'Created product but WordPress modified slug from "' . $slug . '" to "' . $actual_slug . '" (ID: ' . $product_id . '). Using meta fallback for future updates.';
    }

    // Set featured image (best-effort) only if provided and product has no thumbnail yet
    if ($featured_image_url !== '' && filter_var($featured_image_url, FILTER_VALIDATE_URL)) {
        if (function_exists('has_post_thumbnail') && !has_post_thumbnail($product_id)) {
            require_once(ABSPATH . 'wp-admin/includes/file.php');
            require_once(ABSPATH . 'wp-admin/includes/media.php');
            require_once(ABSPATH . 'wp-admin/includes/image.php');

            $attachment_id = media_sideload_image($featured_image_url, $product_id, $title, 'id');
            if (is_wp_error($attachment_id)) {
                $log[] = 'Failed to sideload featured image for product ' . $slug . ' (ID: ' . $product_id . '): ' . $attachment_id->get_error_message();
            } else {
                set_post_thumbnail($product_id, (int) $attachment_id);
                $log[] = 'Set featured image for product ' . $slug . ' (ID: ' . $product_id . ')';
            }
        }
    }

    return $product_id;
}

/**
 * Apply RealGPL metadata onto an existing WooCommerce product.
 *
 * - Categories → product_cat
 * - Tag "Memberships" → product_tag
 * - Meta: demo-url, developer
 * - Descriptions: post_excerpt (short) and post_content (long)
 * - Tax: taxable + standard class
 * - Ensure virtual + downloadable
 *
 * @param int   $product_id
 * @param array $row
 * @param array $log
 * @return void
 */
function csv_product_updater_apply_row_metadata($product_id, $row, &$log) {
    $product_id = absint($product_id);
    if ($product_id <= 0) return;

    // Tax settings + flags
    update_post_meta($product_id, '_downloadable', 'yes');
    update_post_meta($product_id, '_virtual', 'yes');
    update_post_meta($product_id, '_tax_status', 'taxable');
    update_post_meta($product_id, '_tax_class', ''); // Standard

    // Developer (Brand) and demo URL
    $brand   = (string) csv_product_updater_row_value($row, 18, '');
    $demoUrl = (string) csv_product_updater_row_value($row, 19, '');
    if ($brand !== '') {
        update_post_meta($product_id, 'developer', sanitize_text_field($brand));
    }
    if ($demoUrl !== '' && filter_var($demoUrl, FILTER_VALIDATE_URL)) {
        update_post_meta($product_id, 'demo-url', esc_url_raw($demoUrl));
    }

    // Descriptions (standard mapping)
    $short = (string) csv_product_updater_row_value($row, 15, '');
    $long  = (string) csv_product_updater_row_value($row, 16, '');
    if ($short !== '' || $long !== '') {
        $post_update = array('ID' => $product_id);
        if ($short !== '') $post_update['post_excerpt'] = wp_kses_post($short);
        if ($long !== '')  $post_update['post_content'] = wp_kses_post($long);
        wp_update_post($post_update);
    }

    // Categories (JSON array or comma-separated fallback)
    $rawCats = (string) csv_product_updater_row_value($row, 17, '');
    $catNames = array();
    if ($rawCats !== '') {
        $decoded = json_decode($rawCats, true);
        if (is_array($decoded)) {
            $catNames = $decoded;
        } else {
            $catNames = array_map('trim', explode(',', $rawCats));
        }
    }
    $catNames = array_values(array_filter(array_map('sanitize_text_field', $catNames)));
    if (!empty($catNames)) {
        $catIds = array();
        foreach ($catNames as $catName) {
            $exists = term_exists($catName, 'product_cat');
            if (!$exists) {
                $created = wp_insert_term($catName, 'product_cat');
                if (!is_wp_error($created) && isset($created['term_id'])) {
                    $catIds[] = (int) $created['term_id'];
                }
            } else {
                $catIds[] = is_array($exists) ? (int) $exists['term_id'] : (int) $exists;
            }
        }
        $catIds = array_values(array_unique(array_filter($catIds)));
        if (!empty($catIds)) {
            // Replace categories with RealGPL categories (source of truth)
            wp_set_object_terms($product_id, $catIds, 'product_cat', false);
        }
    }

    // Tag: Memberships (always add)
    $tagName = 'Memberships';
    $tag = term_exists($tagName, 'product_tag');
    if (!$tag) {
        $tag = wp_insert_term($tagName, 'product_tag');
    }
    if (!is_wp_error($tag)) {
        $tagId = is_array($tag) ? (int) $tag['term_id'] : (int) $tag;
        if ($tagId > 0) {
            wp_set_object_terms($product_id, array($tagId), 'product_tag', true);
        }
    }
}

/**
 * Get the current job state (background updater).
 *
 * @return array
 */
function csv_product_updater_get_job_state() {
    $state = get_option(CSV_PRODUCT_UPDATER_JOB_STATE_OPTION, array());
    return is_array($state) ? $state : array();
}

/**
 * Save job state (non-autoload).
 */
function csv_product_updater_save_job_state($state) {
    if (!is_array($state)) {
        $state = array();
    }
    // Prevent autoloading large state on every request
    update_option(CSV_PRODUCT_UPDATER_JOB_STATE_OPTION, $state, false);
}

function csv_product_updater_is_stop_requested() {
    return (bool) get_option(CSV_PRODUCT_UPDATER_STOP_OPTION, false);
}

function csv_product_updater_request_stop() {
    update_option(CSV_PRODUCT_UPDATER_STOP_OPTION, true, false);
}

function csv_product_updater_clear_stop() {
    delete_option(CSV_PRODUCT_UPDATER_STOP_OPTION);
}

function csv_product_updater_acquire_lock() {
    if (get_transient(CSV_PRODUCT_UPDATER_JOB_LOCK_TRANSIENT)) {
        return false;
    }
    set_transient(CSV_PRODUCT_UPDATER_JOB_LOCK_TRANSIENT, '1', CSV_PRODUCT_UPDATER_JOB_LOCK_TTL);
    return true;
}

function csv_product_updater_release_lock() {
    delete_transient(CSV_PRODUCT_UPDATER_JOB_LOCK_TRANSIENT);
}

/**
 * Parse a CSV string into rows (without header row).
 *
 * @param string $csv_body
 * @return array|WP_Error
 */
function csv_product_updater_parse_csv_body_to_rows($csv_body) {
    if (!is_string($csv_body) || trim($csv_body) === '') {
        return new WP_Error('csv_empty', 'CSV body is empty');
    }

    $csv_lines = preg_split("/\r\n|\n|\r/", trim($csv_body));
    $csv_data = array_map('str_getcsv', $csv_lines);
    array_shift($csv_data); // Remove header row

    // Filter out any empty lines that parsed as a single empty column
    $csv_data = array_values(array_filter($csv_data, function($row) {
        return is_array($row) && !(count($row) === 1 && trim((string) $row[0]) === '');
    }));

    return $csv_data;
}

/**
 * Get a stable local cache file path for the current job's CSV.
 *
 * @return string|WP_Error
 */
function csv_product_updater_get_job_csv_cache_file_path() {
    $upload_dir = wp_upload_dir();
    if (!is_array($upload_dir) || empty($upload_dir['basedir'])) {
        return new WP_Error('csv_cache_dir', 'Could not determine uploads directory');
    }

    $dir = trailingslashit($upload_dir['basedir']) . 'csv-product-updater';
    if (!file_exists($dir)) {
        if (!wp_mkdir_p($dir)) {
            return new WP_Error('csv_cache_dir', 'Failed to create cache directory: ' . $dir);
        }
    }

    return trailingslashit($dir) . 'data.csv';
}

/**
 * Download remote data.csv to a local file (once per job).
 *
 * @param string $csv_file_url
 * @param string $file_path
 * @param array  $log
 * @return string|WP_Error
 */
function csv_product_updater_download_csv_to_file($csv_file_url, $file_path, &$log) {
    // Stream to disk (fast + memory safe)
    $response = wp_remote_get($csv_file_url, array(
        'timeout'     => CSV_PRODUCT_UPDATER_HTTP_TIMEOUT,
        'stream'      => true,
        'filename'    => $file_path,
        'redirection' => 5,
    ));

    if (is_wp_error($response)) {
        if (file_exists($file_path)) @unlink($file_path);
        return new WP_Error('csv_fetch_failed', 'Failed to fetch CSV data from ' . $csv_file_url . ' - ' . $response->get_error_message());
    }

    $code = wp_remote_retrieve_response_code($response);
    if ($code != 200) {
        if (file_exists($file_path)) @unlink($file_path);
        return new WP_Error('csv_fetch_failed', 'Failed to fetch CSV data from ' . $csv_file_url . ' - HTTP ' . $code);
    }

    if (!file_exists($file_path) || filesize($file_path) <= 0) {
        if (file_exists($file_path)) @unlink($file_path);
        return new WP_Error('csv_fetch_failed', 'CSV download succeeded but file is empty: ' . $file_path);
    }

    $log[] = 'Cached data.csv locally: ' . basename($file_path) . ' (' . filesize($file_path) . ' bytes)';
    return $file_path;
}

/**
 * Read cached CSV file and parse rows.
 *
 * @param string $file_path
 * @return array|WP_Error
 */
function csv_product_updater_read_csv_rows_from_file($file_path) {
    if (!$file_path || !file_exists($file_path)) {
        return new WP_Error('csv_cache_missing', 'Cached CSV file not found');
    }
    $csv_body = file_get_contents($file_path);
    return csv_product_updater_parse_csv_body_to_rows($csv_body);
}

/**
 * Fetch and parse the remote CSV into rows (without header row).
 *
 * @param string $csv_file_url
 * @param array  $log
 * @return array|WP_Error
 */
function csv_product_updater_fetch_csv_rows($csv_file_url, &$log) {
    $csv_response = wp_remote_get($csv_file_url, array(
        'timeout'     => CSV_PRODUCT_UPDATER_HTTP_TIMEOUT,
        'redirection' => 5,
    ));

    if (is_wp_error($csv_response)) {
        return new WP_Error('csv_fetch_failed', 'Failed to fetch CSV data from ' . $csv_file_url . ' - ' . $csv_response->get_error_message());
    }

    $csv_response_code = wp_remote_retrieve_response_code($csv_response);
    if ($csv_response_code != 200) {
        return new WP_Error('csv_fetch_failed', 'Failed to fetch CSV data from ' . $csv_file_url . ' - HTTP ' . $csv_response_code);
    }

    $csv_body = wp_remote_retrieve_body($csv_response);
    if (!is_string($csv_body) || trim($csv_body) === '') {
        return new WP_Error('csv_fetch_failed', 'Failed to fetch CSV data from ' . $csv_file_url . ' - empty body');
    }

    $parsed = csv_product_updater_parse_csv_body_to_rows($csv_body);
    return $parsed;
    }

/**
 * Process a single CSV row (shared by sync and background modes).
 *
 * @param array $row
 * @param bool  $force_update
 * @param array $result
 * @param array $log
 * @return void
 */
function csv_product_updater_process_row($row, $force_update, &$result, &$log) {
    $slug = sanitize_title((string) csv_product_updater_row_value($row, 7, '')); // slug column
        if ($slug === '') {
            $log[] = 'Skipped row - empty slug';
        return;
        }

    // Find a product that matches the slug (with meta fallback)
    $product = csv_product_updater_find_product($slug);
        
    // Create missing products on-the-fly
        if (!$product) {
        $created_id = csv_product_updater_create_product_from_row($row, $slug, $log);
        if (is_wp_error($created_id)) {
            $log[] = 'Failed to create product for slug: ' . $slug . ' - ' . $created_id->get_error_message();
            $result['products_not_found']++;
            return;
        }
        $product = get_post((int) $created_id);
        if ($product instanceof WP_Post) {
            $log[] = 'Created product: ' . $slug . ' (ID: ' . $product->ID . ')';
            $result['products_created']++;
        } else {
            $log[] = 'Failed to load newly created product for slug: ' . $slug;
            $result['products_not_found']++;
            return;
        }
        }

    // Apply metadata/taxonomies for both created and existing products (even if version is up-to-date)
    csv_product_updater_apply_row_metadata($product->ID, $row, $log);

    $new_version = (string) csv_product_updater_row_value($row, 5, ''); // version column
            $existing_version = get_post_meta($product->ID, 'product-version', true);
            if (!$force_update && $new_version !== '' && (string) $existing_version === (string) $new_version) {
                $log[] = 'Up-to-date - skipped download for product: ' . $slug . ' (ID: ' . $product->ID . ', version: ' . $new_version . ')';
                $result['products_up_to_date']++;
        return;
            }

    // Extract the file URL
    $file_url = (string) csv_product_updater_row_value($row, 8, ''); // fileUrl column
            // Ensure no double slashes when concatenating
            $file_url = rtrim(FETCH_API_WPNOVA, '/') . '/' . ltrim($file_url, '/');

            if (filter_var($file_url, FILTER_VALIDATE_URL) === false) {
                $log[] = 'Invalid file URL: ' . $file_url;
                $result['download_failures']++;
        return;
            }

            $download_result = download_file($file_url);
            if ($download_result === false || !is_array($download_result)) {
                $log[] = 'Failed to download file from URL: ' . $file_url;
                $result['download_failures']++;
        return;
            }

            list($temp_file_path, $original_file_name) = $download_result;

            $download_file_name = basename(parse_url($file_url, PHP_URL_PATH));
            $download_file_name = sanitize_file_name($download_file_name);
            if (empty($download_file_name)) {
                $download_file_name = sanitize_file_name($original_file_name);
            }
            if (empty($download_file_name)) {
                $download_file_name = 'download.zip';
            }

            $update_success = update_product_file($product->ID, $temp_file_path, $download_file_name);
            if ($update_success) {
                if ($new_version !== '') {
            update_post_meta($product->ID, 'product-version', $new_version);
                }
        // Keep flags consistent
                update_post_meta($product->ID, '_downloadable', 'yes');
                update_post_meta($product->ID, '_virtual', 'yes');
                
                $log[] = 'Updated product: ' . $slug . ' (ID: ' . $product->ID . ')';
                $result['products_updated']++;
            } else {
                if (isset($temp_file_path) && file_exists($temp_file_path)) {
                    unlink($temp_file_path);
                }
                $log[] = 'Failed to update files for product: ' . $slug . ' (ID: ' . $product->ID . ')';
                $result['download_failures']++;
            }
}

/**
 * Start a background update job (manual or webhook).
 *
 * @param bool   $force_update
 * @param string $source
 * @return array Job state
 */
function csv_product_updater_start_job($force_update = false, $source = 'manual') {
    $state = csv_product_updater_get_job_state();
    if (isset($state['status']) && $state['status'] === 'running') {
        return $state;
    }

    csv_product_updater_clear_stop();

    $csv_file_url = FETCH_API_WPNOVA . 'data.csv';
    $log = get_option('csv_product_updater_log', array());
    if (!is_array($log)) $log = array();

    // Download data.csv ONCE per job and cache locally (prevents repeated GET /data.csv per batch)
    $cache_path = csv_product_updater_get_job_csv_cache_file_path();
    if (is_wp_error($cache_path)) {
        $rows = $cache_path;
        } else {
        $downloaded = csv_product_updater_download_csv_to_file($csv_file_url, $cache_path, $log);
        if (is_wp_error($downloaded)) {
            $rows = $downloaded;
        } else {
            $rows = csv_product_updater_read_csv_rows_from_file($cache_path);
        }
    }
    if (is_wp_error($rows)) {
        $message = 'Failed to start job: ' . $rows->get_error_message();
        array_unshift($log, $message);
        csv_product_updater_save_log($log);

        $state = array(
            'status'      => 'error',
            'error'       => $message,
            'started_at'  => current_time('mysql'),
            'ended_at'    => current_time('mysql'),
            'cursor'      => 0,
            'total_rows'  => 0,
            'current'     => array('slug' => '', 'title' => ''),
            'result'      => array(),
            'force_update'=> (bool) $force_update,
            'source'      => (string) $source,
        );
        csv_product_updater_save_job_state($state);
        return $state;
    }

    $total_rows = count($rows);
    $start_time = current_time('mysql');

    $result = array(
        'start_time'         => $start_time,
        'total_rows'         => $total_rows,
        'products_updated'   => 0,
        'products_up_to_date'=> 0,
        'products_created'   => 0,
        'products_not_found' => 0,
        'download_failures'  => 0,
        'force_update'       => $force_update ? true : false,
    );

    $state = array(
        'status'       => 'running',
        'started_at'   => $start_time,
        'ended_at'     => null,
        'cursor'       => 0,
        'total_rows'   => $total_rows,
        'current'      => array('slug' => '', 'title' => ''),
        'csv_cache'    => array(
            'file_path' => is_wp_error($cache_path) ? '' : $cache_path,
            'url'       => $csv_file_url,
            'fetched_at'=> $start_time,
        ),
        'result'       => $result,
        'force_update' => (bool) $force_update,
        'source'       => (string) $source,
        'last_message' => '',
    );

    array_unshift($log, sprintf('Background update job started (%s). Total rows: %d. Force: %s. Time: %s', $source, $total_rows, $force_update ? 'true' : 'false', $start_time));
    csv_product_updater_save_log($log);
    csv_product_updater_save_job_state($state);

    // Schedule first batch ASAP
    wp_schedule_single_event(time() + 1, 'csv_product_updater_process_batch_event');

    return $state;
}

/**
 * Daily cron handler: start a background job instead of running a long synchronous request.
 */
function csv_product_updater_daily_event_handler() {
    csv_product_updater_start_job(false, 'daily_cron');
}

/**
 * Process a small batch of rows in the background.
 */
function csv_product_updater_process_batch() {
    $state = csv_product_updater_get_job_state();
    if (!is_array($state) || !isset($state['status']) || $state['status'] !== 'running') {
        return;
    }

    // Stop requested?
    if (csv_product_updater_is_stop_requested()) {
        $state['status'] = 'stopped';
        $state['ended_at'] = current_time('mysql');
        $state['last_message'] = 'Stop requested; job stopped.';
        $state['current'] = array('slug' => '', 'title' => '');
        csv_product_updater_save_job_state($state);

        $log = get_option('csv_product_updater_log', array());
        if (!is_array($log)) $log = array();
        array_unshift($log, 'Background update job stopped at ' . $state['ended_at']);
        csv_product_updater_save_log($log);
        update_option('csv_product_updater_last_updated_date', $state['ended_at']);
        return;
    }

    // Prevent overlapping runs
    if (!csv_product_updater_acquire_lock()) {
        // Another batch is running; try again shortly
        wp_schedule_single_event(time() + 10, 'csv_product_updater_process_batch_event');
        return;
    }

    $log = get_option('csv_product_updater_log', array());
    if (!is_array($log)) $log = array();

    // Use cached CSV file from job state (do NOT re-download data.csv every batch)
    $csv_file_url = FETCH_API_WPNOVA . 'data.csv';
    $cache_path = '';
    if (isset($state['csv_cache']) && is_array($state['csv_cache']) && !empty($state['csv_cache']['file_path'])) {
        $cache_path = (string) $state['csv_cache']['file_path'];
    }
    if ($cache_path === '' || !file_exists($cache_path)) {
        // Cache missing; re-download once (then reuse for all remaining batches)
        $cache_path = csv_product_updater_get_job_csv_cache_file_path();
        if (!is_wp_error($cache_path)) {
            $downloaded = csv_product_updater_download_csv_to_file($csv_file_url, $cache_path, $log);
            if (!is_wp_error($downloaded)) {
                $state['csv_cache'] = array(
                    'file_path' => $cache_path,
                    'url'       => $csv_file_url,
                    'fetched_at'=> current_time('mysql'),
                );
                csv_product_updater_save_job_state($state);
            }
        }
    }

    $rows = csv_product_updater_read_csv_rows_from_file($cache_path);
    if (is_wp_error($rows)) {
        $state['status'] = 'error';
        $state['ended_at'] = current_time('mysql');
        $state['last_message'] = 'Batch failed: ' . $rows->get_error_message();
        $state['error'] = $rows->get_error_message();
        csv_product_updater_save_job_state($state);

        array_unshift($log, 'Background update job failed: ' . $rows->get_error_message());
        csv_product_updater_save_log($log);

        csv_product_updater_release_lock();
        return;
    }

    $total_rows = count($rows);
    $cursor = isset($state['cursor']) ? (int) $state['cursor'] : 0;
    $force_update = isset($state['force_update']) ? (bool) $state['force_update'] : false;

    // Keep totals fresh (in case CSV size changes)
    $state['total_rows'] = $total_rows;
    if (isset($state['result']) && is_array($state['result'])) {
        $state['result']['total_rows'] = $total_rows;
    }

    $batch_size = (int) CSV_PRODUCT_UPDATER_BATCH_SIZE;
    if ($batch_size < 1) $batch_size = 1;

    $processed_any = false;

    for ($i = 0; $i < $batch_size; $i++) {
        if ($cursor >= $total_rows) {
            break;
        }

        $row = $rows[$cursor];

        // Update current product info for UI
        $slug = sanitize_title((string) csv_product_updater_row_value($row, 7, ''));
        $title = (string) csv_product_updater_row_value($row, 3, '');
        if ($title === '') {
            $title = (string) csv_product_updater_row_value($row, 1, '');
        }

        $state['current'] = array(
            'slug'  => $slug,
            'title' => $title,
        );
        $state['last_message'] = 'Processing: ' . ($title !== '' ? $title : $slug);
        csv_product_updater_save_job_state($state);

        // Do the work
        if (!isset($state['result']) || !is_array($state['result'])) {
            $state['result'] = array();
        }
        csv_product_updater_process_row($row, $force_update, $state['result'], $log);

        $cursor++;
        $state['cursor'] = $cursor;
        $processed_any = true;

        // Persist state/log after each item so UI stays accurate
        csv_product_updater_save_job_state($state);
        csv_product_updater_save_log($log);

        // If stop was requested mid-batch, stop after current row
        if (csv_product_updater_is_stop_requested()) {
            break;
        }
    }

    // Completion / stop handling
    if (csv_product_updater_is_stop_requested()) {
        $state['status'] = 'stopped';
        $state['ended_at'] = current_time('mysql');
        $state['current'] = array('slug' => '', 'title' => '');
        $state['last_message'] = 'Stop requested; job stopped.';
        csv_product_updater_save_job_state($state);

        array_unshift($log, 'Background update job stopped at ' . $state['ended_at']);
        csv_product_updater_save_log($log);
        update_option('csv_product_updater_last_updated_date', $state['ended_at']);

        csv_product_updater_release_lock();
        return;
    }

    if ($cursor >= $total_rows) {
        $state['status'] = 'completed';
        $state['ended_at'] = current_time('mysql');
        $state['current'] = array('slug' => '', 'title' => '');
        $state['last_message'] = 'Job completed.';
        // Compute duration/success
        if (isset($state['result']) && is_array($state['result'])) {
            $state['result']['end_time'] = $state['ended_at'];
            $state['result']['duration_seconds'] = strtotime($state['ended_at']) - strtotime($state['result']['start_time']);
            $state['result']['success'] = (isset($state['result']['download_failures']) ? (int) $state['result']['download_failures'] : 0) === 0;
        }
        csv_product_updater_save_job_state($state);

        array_unshift($log, 'Background update job completed at ' . $state['ended_at']);
        csv_product_updater_save_log($log);
        update_option('csv_product_updater_last_updated_date', $state['ended_at']);

        csv_product_updater_release_lock();
        return;
    }

    // Schedule next batch if we did any work (or if cursor is behind)
    if ($processed_any) {
        wp_schedule_single_event(time() + 5, 'csv_product_updater_process_batch_event');
    } else {
        // Nothing processed; try again later
        wp_schedule_single_event(time() + 15, 'csv_product_updater_process_batch_event');
    }

    csv_product_updater_release_lock();
}

function update_product_files($options = array()) {
    $force_update = false;
    if (is_bool($options)) {
        // Back-compat if called as update_product_files(true)
        $force_update = $options;
    } elseif (is_array($options) && isset($options['force_update'])) {
        $force_update = (bool) $options['force_update'];
    }

    $log = array();
    if ($force_update) {
        $log[] = 'Force update enabled - bypassing up-to-date version checks.';
    }
    $result = array(
        'start_time' => current_time('mysql'),
        'total_rows' => 0,
        'products_updated' => 0,
        'products_up_to_date' => 0,
        'products_created' => 0,
        'products_not_found' => 0,
        'download_failures' => 0,
        'force_update' => $force_update ? true : false,
    );

    $csv_file_url = FETCH_API_WPNOVA . 'data.csv';
    $csv_data = csv_product_updater_fetch_csv_rows($csv_file_url, $log);
    if (is_wp_error($csv_data)) {
        $error_message = $csv_data->get_error_message();
        $log[] = $error_message;
        csv_product_updater_save_log($log);
        $result['error'] = $error_message;
        $result['end_time'] = current_time('mysql');
        return $result;
    }

    $result['total_rows'] = count($csv_data);
    $log[] = 'Total rows in CSV: ' . count($csv_data);

    foreach ($csv_data as $row) {
        csv_product_updater_process_row($row, $force_update, $result, $log);
    }

    // Store the log data in an option instead of a transient so it persists until the next update
    csv_product_updater_save_log($log);
    
    // Add completion information
    $result['end_time'] = current_time('mysql');
    $result['duration_seconds'] = strtotime($result['end_time']) - strtotime($result['start_time']);
    $result['success'] = ($result['download_failures'] === 0);
    
    return $result;
}

// Download a file from a URL and return the path to the downloaded file along with its original name
function download_file($url) {
    // Stream to disk (avoids loading large ZIPs into memory)
    $temp_file_path = tempnam(sys_get_temp_dir(), 'csv_product_updater');
    if (!$temp_file_path) {
        return false;
    }

    $response = wp_remote_get($url, array(
        'timeout'     => CSV_PRODUCT_UPDATER_HTTP_TIMEOUT,
        'stream'      => true,
        'filename'    => $temp_file_path,
        'redirection' => 5,
    ));

    if (is_wp_error($response)) {
        if (file_exists($temp_file_path)) {
            unlink($temp_file_path);
        }
        return false;
    }

    $response_code = wp_remote_retrieve_response_code($response);
    if ($response_code != 200) {
        if (file_exists($temp_file_path)) {
            unlink($temp_file_path);
        }
        return false;
    }

    // Ensure the file was written
    if (!file_exists($temp_file_path) || filesize($temp_file_path) <= 0) {
        if (file_exists($temp_file_path)) {
            unlink($temp_file_path);
        }
        return false;
    }

    // Extract the original file name from the URL
    $original_file_name = basename(parse_url($url, PHP_URL_PATH));

    return array($temp_file_path, $original_file_name);
}

// Update a product's file with a new file while retaining the original download_id
function update_product_file($product_id, $file_path, $file_name) {
    // Validate input parameters
    if (!$file_path || !file_exists($file_path)) {
        error_log('CSV Product Updater: Invalid file path provided to update_product_file()');
        return false;
    }
    
    // Create a WC_Product_Download object
    $download = new WC_Product_Download();

    // Prepare for upload to Media Library
    $upload_dir = wp_upload_dir();
    $new_file_path = $upload_dir['path'] . '/' . $file_name;
    
    // Ensure the upload directory exists
    if (!file_exists($upload_dir['path'])) {
        wp_mkdir_p($upload_dir['path']);
    }
    
    // Move the file to the uploads directory
    if (!rename($file_path, $new_file_path)) {
        error_log('CSV Product Updater: Failed to move file to uploads directory');
        return false;
    }

    // Insert the file into the Media Library and get its ID
    $file_info = wp_insert_attachment(array(
        'guid'           => $upload_dir['url'] . '/' . $file_name,
        'post_mime_type' => 'application/zip',
        'post_title'     => 'Download Now',
        'post_content'   => '',
        'post_status'    => 'inherit'
    ), $new_file_path);

    // Generate the metadata for the attachment
    require_once(ABSPATH . 'wp-admin/includes/image.php');
    $metadata = wp_generate_attachment_metadata($file_info, $new_file_path);

    // Update metadata
    wp_update_attachment_metadata($file_info, $metadata);

    // Get the offload media URL (CDN URL) from the attachment
    $file_url = wp_get_attachment_url($file_info);
    
    // Validate and fix the URL if needed
    if (!$file_url || empty($file_url)) {
        // Fallback to constructing URL manually
        $file_url = $upload_dir['url'] . '/' . $file_name;
        error_log('CSV Product Updater: wp_get_attachment_url returned empty, using fallback URL');
    }
    
    // Fix protocol-relative URLs (starting with //)
    if (strpos($file_url, '//') === 0) {
        $file_url = 'https:' . $file_url;
        error_log('CSV Product Updater: Fixed protocol-relative URL');
    }
    
    // Fix URLs that are just paths (starting with /)
    if (strpos($file_url, '/') === 0 && strpos($file_url, '//') !== 0) {
        // Use site URL as base
        $site_url = get_site_url();
        $file_url = rtrim($site_url, '/') . $file_url;
        error_log('CSV Product Updater: Fixed path-only URL to full URL');
    }
    
    // Ensure the URL has proper protocol
    if (!preg_match('#^https?://#', $file_url)) {
        // Check if it's a CDN URL without protocol
        if (strpos($file_url, 'digitaloceanspaces.com') !== false) {
            $file_url = 'https://' . $file_url;
        } else {
            // Use site URL as base for relative paths
            $site_url = get_site_url();
            $file_url = rtrim($site_url, '/') . '/' . ltrim($file_url, '/');
        }
        error_log('CSV Product Updater: Added missing protocol to URL');
    }
    
    // Log the URLs for debugging
    error_log('CSV Product Updater: File path: ' . $new_file_path);
    error_log('CSV Product Updater: File URL being set: ' . $file_url);
    error_log('CSV Product Updater: Attachment ID: ' . $file_info);

    // Set the file URL and name
    $download->set_file($file_url);
    $download->set_name('Download Now');

    // Use WooCommerce's API to get existing product file
    $product = wc_get_product($product_id);
    if (!$product) {
        error_log('CSV Product Updater: Product not found for ID: ' . $product_id);
        return false;
    }
    
    $existing_downloads = $product->get_downloads();

    if (!empty($existing_downloads)) {
        // Use the existing download's ID to maintain the same download_id
        $existing_download = reset($existing_downloads); // Get the first download
        $download->set_id($existing_download->get_id());
    }

    // Temporarily disable file validation for CDN URLs
    add_filter('woocommerce_product_downloadable_file_allowed_mime_types', '__return_empty_array', 999);
    add_filter('woocommerce_file_is_allowed_for_download', '__return_true', 999);
    
    try {
        $product->set_downloads(array($download));
        $product->save();
    } catch (Exception $e) {
        error_log('CSV Product Updater: Error setting downloads - ' . $e->getMessage());
        // If validation fails, try alternative method
        update_post_meta($product_id, '_downloadable_files', array(
            $download->get_id() => array(
                'id' => $download->get_id(),
                'name' => $download->get_name(),
                'file' => $file_url
            )
        ));
    }
    
    // Re-enable file validation
    remove_filter('woocommerce_product_downloadable_file_allowed_mime_types', '__return_empty_array', 999);
    remove_filter('woocommerce_file_is_allowed_for_download', '__return_true', 999);
    
    return true;
}

// Add a settings page to the admin menu
add_action('admin_menu', 'csv_product_updater_admin_menu');

function csv_product_updater_admin_menu() {
    add_options_page('CSV Product Updater', 'CSV Product Updater', 'manage_options', 'csv-product-updater', 'csv_product_updater_admin_page');
}

// Admin AJAX endpoints for background job control/status
add_action('wp_ajax_csv_product_updater_start', 'csv_product_updater_ajax_start');
add_action('wp_ajax_csv_product_updater_status', 'csv_product_updater_ajax_status');
add_action('wp_ajax_csv_product_updater_stop', 'csv_product_updater_ajax_stop');

function csv_product_updater_ajax_start() {
    if (!current_user_can('manage_options')) {
        wp_send_json_error(array('error' => 'forbidden'), 403);
    }
    check_ajax_referer('csv_product_updater_job');

    $force_update = false;
    if (isset($_POST['force_update'])) {
        $force_update = (intval($_POST['force_update']) === 1);
    }

    $state = csv_product_updater_start_job($force_update, 'admin_ajax');
    wp_send_json_success($state);
}

function csv_product_updater_ajax_status() {
    if (!current_user_can('manage_options')) {
        wp_send_json_error(array('error' => 'forbidden'), 403);
    }
    check_ajax_referer('csv_product_updater_job');

    $state = csv_product_updater_get_job_state();
    wp_send_json_success($state);
}

function csv_product_updater_ajax_stop() {
    if (!current_user_can('manage_options')) {
        wp_send_json_error(array('error' => 'forbidden'), 403);
    }
    check_ajax_referer('csv_product_updater_job');

    csv_product_updater_request_stop();
    $state = csv_product_updater_get_job_state();
    wp_send_json_success($state);
}

// The settings page
function csv_product_updater_admin_page() {
    // Check user capabilities
    if (!current_user_can('manage_options')) {
        return;
    }

    // Print the page title
    echo '<h1>' . esc_html(get_admin_page_title()) . '</h1>';
    
    // Remove notification section from admin panel - updates will happen silently when triggered by API

    // Print the existing update button with nonce field for security
    echo '<form method="post" id="csvpu-update-form">';
    wp_nonce_field('csv_product_updater_nonce', 'csv_product_updater_nonce_field');
    echo '<input type="submit" id="csvpu-start" name="csv_product_updater_update" value="Update Products" class="button button-primary" />';
    echo ' <input type="submit" id="csvpu-force" name="csv_product_updater_force_update" value="Force Update Products" class="button" style="background:#ff6b6b;color:#fff;border-color:#ff6b6b;" onclick="return confirm(\'Force Update will re-download and re-attach files even if the version is unchanged. Continue?\');" />';
    echo '<p>Last manual update on: ' . get_option('csv_product_updater_last_updated_date', 'Never') . '</p>';
    echo '</form>';

    // Background progress UI
    echo '<h2>Background Update Status</h2>';
    echo '<div id="csvpu-job-box" style="max-width: 740px; background: #fff; border: 1px solid #dcdcde; padding: 12px; margin: 10px 0;">';
    echo '  <div id="csvpu-progress-wrap" style="position: relative; width: 100%; height: 18px; background: #f0f0f1; border: 1px solid #c3c4c7; border-radius: 3px; overflow: hidden;">';
    echo '    <div id="csvpu-progress-bar" style="height: 18px; width: 0%; background: #2271b1;"></div>';
    echo '    <div id="csvpu-progress-text" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:12px; line-height:18px; color:#1d2327;">0%</div>';
    echo '  </div>';
    echo '  <p id="csvpu-status" style="margin: 10px 0 0 0;"></p>';
    echo '  <p id="csvpu-current" style="margin: 6px 0 0 0;"></p>';
    echo '  <div id="csvpu-counters" style="margin-top: 8px;"></div>';
    echo '  <div style="margin-top: 10px;">';
    echo '    <button type="button" id="csvpu-stop" class="button">Stop</button>';
    echo '  </div>';
    echo '</div>';
    
    // Add test slug lookup form
    echo '<h2>Test Product Lookup</h2>';
    echo '<form method="post">';
    wp_nonce_field('csv_product_test_nonce', 'csv_product_test_nonce_field');
    echo '<label for="test_slug">Test Slug: </label>';
    echo '<input type="text" id="test_slug" name="test_slug" value="" placeholder="Enter slug to test" style="width: 300px;" />';
    echo '<input type="submit" name="csv_product_test_slug" value="Test Slug Lookup" />';
    echo '</form>';
    
    // Display test results if available
    if (get_transient('csv_product_test_result')) {
        $test_result = get_transient('csv_product_test_result');
        echo '<div style="background: #f0f0f0; padding: 10px; margin: 10px 0; border: 1px solid #ccc;">';
        echo '<h3>Test Results:</h3>';
        echo '<pre>' . esc_html($test_result) . '</pre>';
        echo '</div>';
        delete_transient('csv_product_test_result');
    }
    
    // Add diagnostic section for checking current download URLs
    echo '<h2>Recent Product Download URLs</h2>';
    echo '<div style="background: #f9f9f9; padding: 10px; margin: 10px 0; border: 1px solid #ddd;">';
    
    // Get 5 most recent downloadable products
    $args = array(
        'post_type' => 'product',
        'posts_per_page' => 5,
        'meta_key' => '_downloadable',
        'meta_value' => 'yes',
        'orderby' => 'modified',
        'order' => 'DESC'
    );
    $query = new WP_Query($args);
    
    if ($query->have_posts()) {
        echo '<table style="width: 100%; border-collapse: collapse;">';
        echo '<tr style="background: #e0e0e0;"><th style="padding: 5px; text-align: left;">Product</th><th style="padding: 5px; text-align: left;">Download URL</th></tr>';
        
        while ($query->have_posts()) {
            $query->the_post();
            $product = wc_get_product(get_the_ID());
            $downloads = $product->get_downloads();
            
            echo '<tr>';
            echo '<td style="padding: 5px; border-top: 1px solid #ddd;">' . esc_html(get_the_title()) . ' (ID: ' . get_the_ID() . ')</td>';
            echo '<td style="padding: 5px; border-top: 1px solid #ddd;">';
            
            if (!empty($downloads)) {
                foreach ($downloads as $download) {
                    $url = $download->get_file();
                    // Highlight problematic URLs
                    if (strpos($url, '//downloads/') === 0 || strpos($url, '/downloads/') === 0) {
                        echo '<span style="color: red;">⚠ ' . esc_html($url) . '</span>';
                    } else {
                        echo '<span style="color: green;">✓ ' . esc_html(substr($url, 0, 100)) . (strlen($url) > 100 ? '...' : '') . '</span>';
                    }
                    echo '<br>';
                }
            } else {
                echo '<em>No downloads</em>';
            }
            
            echo '</td>';
            echo '</tr>';
        }
        
        echo '</table>';
    } else {
        echo '<p>No downloadable products found.</p>';
    }
    
    wp_reset_postdata();
    echo '</div>';
    
    // Add button to fix problematic URLs
    echo '<form method="post" style="margin-top:10px;">';
    wp_nonce_field('csv_product_fix_urls_nonce', 'csv_product_fix_urls_nonce_field');
    echo '<input type="submit" name="csv_product_fix_urls" value="Fix Problematic Download URLs" style="background: #ff6b6b; color: white;" />';
    echo '<span style="margin-left: 10px; color: #666;">This will fix products with malformed download URLs</span>';
    echo '</form>';
    
    // Display fix result if available
    $fix_result = get_option('csv_product_fix_urls_result', false);
    if ($fix_result) {
        echo '<div style="background: #d4edda; color: #155724; padding: 10px; margin: 10px 0; border: 1px solid #c3e6cb;">';
        echo esc_html($fix_result);
        echo '</div>';
        delete_option('csv_product_fix_urls_result');
    }
    
    // Add the new "Send Refresh Request" button with nonce field and date picker
    $last_refresh_date_value = get_option('csv_product_updater_last_refresh_date', date('Y-m-d'));
    if (is_string($last_refresh_date_value) && preg_match('/^\d{4}-\d{2}-\d{2}/', $last_refresh_date_value, $m)) {
        $last_refresh_date_value = $m[0];
    } else {
        $last_refresh_date_value = date('Y-m-d');
    }
    $last_refresh_requested_at = get_option(
        'csv_product_updater_last_refresh_requested_at',
        get_option('csv_product_updater_last_refresh_date', 'Never')
    );

    echo '<form method="post" style="margin-top:20px;">';
    wp_nonce_field('csv_product_refresh_nonce', 'csv_product_refresh_nonce_field');
    echo '<label for="csv_product_updater_date">Start Date: </label>';
    echo '<input type="date" id="csv_product_updater_date" name="csv_product_updater_date" value="' . esc_attr($last_refresh_date_value) . '" />';
    echo '<input type="submit" name="csv_product_updater_send_refresh" value="Send Refresh Request" />';
    echo ' <label style="margin-left:10px;"><input type="checkbox" name="csv_product_updater_refresh_force_update" value="1" /> Force update products</label>';
    echo '<p style="margin:6px 0 0 0; color:#666;">This will refresh from the start date through today (max ' . (int) CSV_PRODUCT_UPDATER_REFRESH_QUEUE_MAX_DAYS . ' days).</p>';
    echo '<p>Last refresh request sent at: ' . esc_html($last_refresh_requested_at) . '</p>';
    echo '</form>';

    // Backfill refresh queue status
    $queue = csv_product_updater_get_refresh_queue_state();
    if (is_array($queue) && !empty($queue)) {
        $q_status = isset($queue['status']) ? (string) $queue['status'] : 'idle';
        $q_dates = (isset($queue['dates']) && is_array($queue['dates'])) ? $queue['dates'] : array();
        $q_total = count($q_dates);
        $q_index = isset($queue['index']) ? (int) $queue['index'] : 0;
        $q_completed = min(max($q_index, 0), $q_total);
        $q_next = ($q_status === 'running' && $q_index < $q_total) ? $q_dates[$q_index] : '';
        $q_msg = isset($queue['last_message']) ? (string) $queue['last_message'] : '';
        $q_err = isset($queue['last_error']) ? (string) $queue['last_error'] : '';

        echo '<div style="background:#fff; border:1px solid #dcdcde; padding:12px; margin:10px 0; max-width:740px;">';
        echo '<h3 style="margin-top:0;">Backfill Refresh Status</h3>';
        echo '<p>Status: <strong>' . esc_html($q_status) . '</strong></p>';
        if ($q_total > 0) {
            echo '<p>Progress: ' . esc_html($q_completed) . '/' . esc_html($q_total) . ' day(s) completed' . ($q_next ? (' — next: <code>' . esc_html($q_next) . '</code>') : '') . '</p>';
        }
        if ($q_msg) {
            echo '<p>' . esc_html($q_msg) . '</p>';
        }
        if ($q_err) {
            echo '<p style="color:#b32d2e;">Error: ' . esc_html($q_err) . '</p>';
        }
        echo '</div>';
    }

    // Loading sign (no external image dependency)
    echo '<div id="loading-sign" style="display: none;"><span class="spinner is-active" style="float:none;margin:0 6px 0 0;"></span> Loading...</div>';

    // Get the log data from the option
    $log = get_option('csv_product_updater_log', array());
    // Prune log entries older than retention window (3 days)
    $log = csv_product_updater_save_log($log);

    // If the log data exists, display it
    if (!empty($log)) {
        echo '<h2>Update Log</h2>';
        
        // Clear log button
        echo '<form method="post" style="margin: 10px 0;">';
        wp_nonce_field('csv_product_clear_log_nonce', 'csv_product_clear_log_nonce_field');
        echo '<input type="submit" name="csv_product_updater_clear_log" value="Clear Log" class="button" onclick="return confirm(\'Clear the update log?\');" />';
        echo '</form>';
        
        echo '<ul>';
        foreach ($log as $log_item) {
            echo '<li>' . esc_html($log_item) . '</li>';
        }
        echo '</ul>';
    }
}

// Handle the form submission from the settings page
add_action('admin_init', 'csv_product_updater_admin_init');

function csv_product_updater_admin_init() {
    if (isset($_POST['csv_product_updater_clear_log']) && check_admin_referer('csv_product_clear_log_nonce', 'csv_product_clear_log_nonce_field')) {
        update_option('csv_product_updater_log', array(), false);
        // Keep the UI clean: do not erase job state, just the log
        wp_safe_redirect(menu_page_url('csv-product-updater', false));
        exit;
    }

    if (isset($_POST['csv_product_updater_update']) && check_admin_referer('csv_product_updater_nonce', 'csv_product_updater_nonce_field')) {
        // Start background job (fallback if JS is disabled)
        csv_product_updater_start_job(false, 'admin_form');
        wp_safe_redirect(menu_page_url('csv-product-updater', false));
        exit;
    }

    if (isset($_POST['csv_product_updater_force_update']) && check_admin_referer('csv_product_updater_nonce', 'csv_product_updater_nonce_field')) {
        // Start background job (force)
        csv_product_updater_start_job(true, 'admin_form');
        wp_safe_redirect(menu_page_url('csv-product-updater', false));
        exit;
    }

    // Check if the new "Send Refresh Request" button was clicked and verify nonce
    if (isset($_POST['csv_product_updater_send_refresh']) && check_admin_referer('csv_product_refresh_nonce', 'csv_product_refresh_nonce_field')) {
        // Get the selected date
        $selected_date = sanitize_text_field($_POST['csv_product_updater_date']);
        if (empty($selected_date)) {
            $selected_date = date('Y-m-d'); // Default to current date if none selected
        }

        // Force update (propagates to the API which then triggers WP update with force_update)
        $force_refresh_update = isset($_POST['csv_product_updater_refresh_force_update']) && (string) $_POST['csv_product_updater_refresh_force_update'] === '1';

        // Store selected date for the date input, and store request time for display
        update_option('csv_product_updater_last_refresh_date', $selected_date, false);
        update_option('csv_product_updater_last_refresh_requested_at', current_time('mysql'), false);

        // Start backfill refresh queue (start date -> today)
        $queue = csv_product_updater_start_refresh_queue($selected_date, $force_refresh_update, 'admin_form');
        if (is_wp_error($queue)) {
            $log = get_option('csv_product_updater_log', array());
            if (!is_array($log)) $log = array();
            array_unshift($log, 'Backfill refresh failed to start: ' . $queue->get_error_message());
            csv_product_updater_save_log($log);
        }

        wp_safe_redirect(menu_page_url('csv-product-updater', false));
        exit;
    }
    
    // Handle fixing problematic URLs
    if (isset($_POST['csv_product_fix_urls']) && check_admin_referer('csv_product_fix_urls_nonce', 'csv_product_fix_urls_nonce_field')) {
        $fixed_count = 0;
        $site_url = get_site_url();
        
        // Get all downloadable products
        $args = array(
            'post_type' => 'product',
            'posts_per_page' => -1,
            'meta_key' => '_downloadable',
            'meta_value' => 'yes'
        );
        $query = new WP_Query($args);
        
        if ($query->have_posts()) {
            while ($query->have_posts()) {
                $query->the_post();
                $product = wc_get_product(get_the_ID());
                $downloads = $product->get_downloads();
                $needs_update = false;
                
                if (!empty($downloads)) {
                    foreach ($downloads as $download_id => $download) {
                        $url = $download->get_file();
                        $fixed_url = $url;
                        
                        // Fix protocol-relative URLs
                        if (strpos($url, '//downloads/') === 0) {
                            $fixed_url = rtrim($site_url, '/') . '/wp-content/uploads' . substr($url, 1);
                            $needs_update = true;
                        }
                        // Fix path-only URLs
                        elseif (strpos($url, '/downloads/') === 0) {
                            $fixed_url = rtrim($site_url, '/') . '/wp-content/uploads' . $url;
                            $needs_update = true;
                        }
                        // Fix URLs without protocol
                        elseif (!preg_match('#^https?://#', $url) && strpos($url, 'downloads/') === 0) {
                            $fixed_url = rtrim($site_url, '/') . '/wp-content/uploads/' . $url;
                            $needs_update = true;
                        }
                        
                        if ($needs_update) {
                            $download->set_file($fixed_url);
                            error_log('CSV Product Updater: Fixed URL for product ' . get_the_ID() . ' from "' . $url . '" to "' . $fixed_url . '"');
                        }
                    }
                    
                    if ($needs_update) {
                        $product->set_downloads($downloads);
                        $product->save();
                        $fixed_count++;
                    }
                }
            }
        }
        
        wp_reset_postdata();
        
        // Store result message
        update_option('csv_product_fix_urls_result', 'Fixed download URLs for ' . $fixed_count . ' products.');
    }
    
    // Handle test slug lookup
    if (isset($_POST['csv_product_test_slug']) && check_admin_referer('csv_product_test_nonce', 'csv_product_test_nonce_field')) {
        $test_slug = sanitize_text_field($_POST['test_slug']);
        $result = "Testing slug: '$test_slug'\n\n";
        
        // Try get_page_by_path
        $product = get_page_by_path($test_slug, OBJECT, 'product');
        if ($product) {
            $result .= "✓ Found by get_page_by_path:\n";
            $result .= "  - ID: {$product->ID}\n";
            $result .= "  - Title: {$product->post_title}\n";
            $result .= "  - Slug: {$product->post_name}\n";
            $result .= "  - Status: {$product->post_status}\n";
        } else {
            $result .= "✗ Not found by get_page_by_path\n";
        }
        
        // Try WP_Query
        $args = array(
            'post_type' => 'product',
            'name' => $test_slug,
            'posts_per_page' => 1,
            'post_status' => 'publish'
        );
        $query = new WP_Query($args);
        if ($query->have_posts()) {
            $product = $query->posts[0];
            $result .= "\n✓ Found by WP_Query:\n";
            $result .= "  - ID: {$product->ID}\n";
            $result .= "  - Title: {$product->post_title}\n";
            $result .= "  - Slug: {$product->post_name}\n";
        } else {
            $result .= "\n✗ Not found by WP_Query\n";
        }
        wp_reset_postdata();
        
        // List all products to help debug
        global $wpdb;
        $all_products = $wpdb->get_results(
            "SELECT ID, post_name, post_title FROM {$wpdb->posts} 
            WHERE post_type = 'product' 
            AND post_status = 'publish'
            ORDER BY post_title
            LIMIT 10"
        );
        
        if ($all_products) {
            $result .= "\n\nFirst 10 products in database:\n";
            foreach ($all_products as $prod) {
                $result .= "  - ID: {$prod->ID}, Slug: {$prod->post_name}, Title: {$prod->post_title}\n";
            }
        }
        
        set_transient('csv_product_test_result', $result, 60);
    }
}

// Enqueue scripts and styles for the date picker and loading sign
function csv_product_updater_enqueue_scripts($hook) {
    if ('settings_page_csv-product-updater' !== $hook) {
        return;
    }

    // Ensure jQuery is present before our inline script runs
    wp_enqueue_script('jquery');
    wp_enqueue_script('jquery-ui-datepicker');
    wp_enqueue_style('jquery-ui', 'https://code.jquery.com/ui/1.12.1/themes/base/jquery-ui.css');

    $nonce_js = wp_json_encode(wp_create_nonce('csv_product_updater_job'));
    $inline_js = <<<JS
jQuery(function($) {
            $('#csv_product_updater_date').datepicker({
                dateFormat: 'yy-mm-dd'
            });

  const nonce = $nonce_js;
  let pollTimer = null;

  function renderState(state) {
    state = state || {};
    const status = state.status || 'idle';
    const cursor = parseInt(state.cursor || 0, 10) || 0;
    const total = parseInt(state.total_rows || (state.result && state.result.total_rows) || 0, 10) || 0;

    let pct = 0;
    if (total > 0) {
      pct = Math.round((cursor / total) * 100);
      if (pct > 100) pct = 100;
      if (pct < 0) pct = 0;
    }

    $('#csvpu-progress-bar').css('width', pct + '%');
    const label = (total > 0) ? (pct + '% (' + cursor + '/' + total + ')') : (status === 'running' ? 'Starting…' : '0%');
    $('#csvpu-progress-text').text(label);
    $('#csvpu-progress-text').css('color', pct >= 55 ? '#fff' : '#1d2327');

    const msg = state.last_message || '';
    $('#csvpu-status').text('Status: ' + status + (msg ? ' — ' + msg : ''));

    const cur = state.current || {};
    const curText = (cur.title || cur.slug) ? ('Current: ' + (cur.title || '') + (cur.slug ? (' (' + cur.slug + ')') : '')) : 'Current: -';
    $('#csvpu-current').text(curText);

    const r = state.result || {};
    const counters = [
      'Total: ' + (r.total_rows || total || 0),
      'Processed: ' + cursor,
      'Created: ' + (r.products_created || 0),
      'Updated: ' + (r.products_updated || 0),
      'Up-to-date: ' + (r.products_up_to_date || 0),
      'Not found: ' + (r.products_not_found || 0),
      'Failures: ' + (r.download_failures || 0)
    ];
    $('#csvpu-counters').html('<code style=\"display:block;white-space:pre-wrap;\">' + counters.join('\\n') + '</code>');

    $('#csvpu-stop').prop('disabled', status !== 'running');
  }

  function fetchStatus() {
    return $.post(ajaxurl, {
      action: 'csv_product_updater_status',
      _ajax_nonce: nonce
    }).done(function(resp) {
      if (resp && resp.success) {
        renderState(resp.data || {});
        const st = (resp.data && resp.data.status) ? resp.data.status : 'idle';
        if (st === 'running') schedulePoll();
      }
    });
  }

  function schedulePoll() {
    if (pollTimer) return;
    pollTimer = setTimeout(function() {
      pollTimer = null;
      fetchStatus();
    }, 1500);
  }

  function startJob(forceUpdate) {
    $('#csvpu-start, #csvpu-force').prop('disabled', true);
    return $.post(ajaxurl, {
      action: 'csv_product_updater_start',
      force_update: forceUpdate ? 1 : 0,
      _ajax_nonce: nonce
    }).done(function(resp) {
      if (resp && resp.success) {
        renderState(resp.data || {});
        schedulePoll();
      }
    }).always(function() {
      setTimeout(function() {
        $('#csvpu-start, #csvpu-force').prop('disabled', false);
      }, 1500);
    });
  }

  function stopJob() {
    $('#csvpu-stop').prop('disabled', true);
    return $.post(ajaxurl, {
      action: 'csv_product_updater_stop',
      _ajax_nonce: nonce
    }).done(function(resp) {
      if (resp && resp.success) {
        renderState(resp.data || {});
      }
    });
  }

  $('#csvpu-update-form').on('submit', function(e) {
    e.preventDefault();
    const isForce = $(document.activeElement).attr('id') === 'csvpu-force';
    startJob(isForce);
  });

  $('#csvpu-stop').on('click', function(e) {
    e.preventDefault();
    stopJob();
            });

  fetchStatus();
});
JS;

    // Attach inline script after jQuery UI datepicker (depends on jQuery)
    wp_add_inline_script('jquery-ui-datepicker', $inline_js);
}

add_action('admin_enqueue_scripts', 'csv_product_updater_enqueue_scripts');

// Add filter to allow local upload directory for WooCommerce downloads
add_filter('woocommerce_downloadable_file_allowed_mime_types', 'csv_product_updater_allowed_mime_types');
function csv_product_updater_allowed_mime_types($mime_types) {
    $mime_types['zip'] = 'application/zip';
    return $mime_types;
}

// Critical: Disable WooCommerce's file validation for external URLs during product save
// This filter is called during validation of downloadable files
add_filter('woocommerce_downloadable_file_validation', 'csv_product_updater_skip_validation', 10, 3);
function csv_product_updater_skip_validation($valid, $file, $product) {
    // Skip validation for DigitalOcean Spaces URLs
    if (strpos($file, 'digitaloceanspaces.com') !== false) {
        return true;
    }
    return $valid;
}

// Force redirect download method for CDN URLs (bypasses local file checks)
add_filter('pre_option_woocommerce_file_download_method', 'csv_product_updater_force_redirect_for_cdn');
function csv_product_updater_force_redirect_for_cdn($value) {
    // Check if we're in the context of saving a product with CDN URLs
    if (is_admin() && isset($_POST['action']) && $_POST['action'] === 'editpost') {
        return 'redirect';
    }

    // If a customer is downloading a file that points to DigitalOcean Spaces,
    // force "redirect" so WooCommerce doesn't proxy the file through PHP.
    if (!is_admin() && isset($_GET['download_file']) && isset($_GET['key']) && function_exists('wc_get_product')) {
        $product_id = absint($_GET['download_file']);
        $download_id = sanitize_text_field(wp_unslash($_GET['key']));

        if ($product_id > 0 && $download_id !== '') {
            $product = wc_get_product($product_id);
            if ($product) {
                $downloads = $product->get_downloads();

                // If the "key" matches the download ID, inspect that file
                if (isset($downloads[$download_id])) {
                    $file_url = $downloads[$download_id]->get_file();
                    if (is_string($file_url) && strpos($file_url, 'digitaloceanspaces.com') !== false) {
                        return 'redirect';
                    }
                } else {
                    // Fallback: if the product has any Spaces-backed downloads, prefer redirect
                    foreach ($downloads as $d) {
                        if (is_object($d) && method_exists($d, 'get_file')) {
                            $file_url = $d->get_file();
                            if (is_string($file_url) && strpos($file_url, 'digitaloceanspaces.com') !== false) {
                                return 'redirect';
                            }
                        }
                    }
                }
            }
        }
    }
    return $value;
}

// Override the file download validation completely for our CDN URLs
add_filter('woocommerce_download_product_filepath', 'csv_product_updater_filepath', 10, 4);
function csv_product_updater_filepath($file_path, $product, $download_id, $order) {
    // If it's a DigitalOcean Spaces URL, return it unchanged
    if (strpos($file_path, 'digitaloceanspaces.com') !== false) {
        return $file_path;
    }
    return $file_path;
}

// Add filter to approve external CDN URLs for WooCommerce downloads
add_filter('woocommerce_downloadable_file_exists', 'csv_product_updater_file_exists', 10, 2);
function csv_product_updater_file_exists($file_exists, $file_url) {
    // Allow DigitalOcean Spaces URLs
    if (strpos($file_url, 'digitaloceanspaces.com') !== false) {
        // Cache existence checks so downloads don't incur an extra HEAD call each time
        $cache_key = 'csv_product_updater_cdn_exists_' . md5($file_url);
        $cached = get_transient($cache_key);
        if ($cached !== false) {
            return ($cached === '1');
        }

        // For CDN URLs, we'll check if the URL is accessible (short timeout)
        $response = wp_remote_head($file_url, array(
            'timeout'     => CSV_PRODUCT_UPDATER_CDN_HEAD_TIMEOUT,
            'redirection' => 5,
        ));
        if (!is_wp_error($response)) {
            $response_code = wp_remote_retrieve_response_code($response);
            $file_exists = ($response_code == 200);
        } else {
            // Avoid blocking downloads on transient network issues; let the CDN 404 if needed
            $file_exists = true;
        }

        set_transient($cache_key, $file_exists ? '1' : '0', CSV_PRODUCT_UPDATER_CDN_HEAD_CACHE_TTL);
    }
    
    // Also check local files if not already found
    if (!$file_exists) {
        $upload_dir = wp_upload_dir();
        $upload_url = $upload_dir['baseurl'];
        
        // Check if the URL is within our uploads directory
        if (strpos($file_url, $upload_url) === 0) {
            // Convert URL to local path
            $file_path = str_replace($upload_url, $upload_dir['basedir'], $file_url);
            $file_exists = file_exists($file_path);
        }
    }
    return $file_exists;
}

// Note: External CDN URLs are handled by other filters below

// This is the key filter to bypass WooCommerce's local file requirement for our CDN URLs
add_filter('woocommerce_file_is_allowed_for_download', 'csv_product_updater_allow_cdn_downloads', 10, 2);
function csv_product_updater_allow_cdn_downloads($allowed, $file_path) {
    // Allow all DigitalOcean Spaces URLs
    if (strpos($file_path, 'digitaloceanspaces.com') !== false) {
        return true;
    }
    return $allowed;
}

// Also bypass the download method check for CDN files
add_filter('woocommerce_downloadable_file_permission_check', 'csv_product_updater_permission_check', 10, 2);
function csv_product_updater_permission_check($check, $file_url) {
    // Skip permission check for DigitalOcean Spaces URLs
    if (strpos($file_url, 'digitaloceanspaces.com') !== false) {
        return true;
    }
    return $check;
}

// Add our CDN domain to approved download paths
add_filter('woocommerce_downloadable_file_paths', 'csv_product_updater_download_paths');
function csv_product_updater_download_paths($paths) {
    $upload_dir = wp_upload_dir();
    $paths[] = $upload_dir['basedir'];
    $paths[] = $upload_dir['baseurl'];
    // Add DigitalOcean Spaces as an approved path pattern
    $paths[] = 'https://wpnova.ams3.digitaloceanspaces.com';
    $paths[] = 'https://*.digitaloceanspaces.com';
    return $paths;
}

// Register REST API endpoint to receive notifications when data.csv is ready
add_action('rest_api_init', 'register_data_ready_endpoint');

function register_data_ready_endpoint() {
    register_rest_route('wpnova/v1', '/data-ready', array(
        'methods' => 'POST',
        'callback' => 'handle_data_ready_notification',
        'permission_callback' => 'csv_product_updater_webhook_permission',
    ));
}

/**
 * Shared-secret auth for the data-ready webhook.
 *
 * Configure in wp-config.php:
 *   define('WPNOVA_WEBHOOK_SECRET', 'your-long-random-secret');
 */
function csv_product_updater_webhook_permission($request) {
    if (!defined('WPNOVA_WEBHOOK_SECRET') || !is_string(WPNOVA_WEBHOOK_SECRET) || WPNOVA_WEBHOOK_SECRET === '') {
        return new WP_Error('wpnova_secret_missing', 'WPNOVA_WEBHOOK_SECRET is not configured', array('status' => 403));
    }

    // Header names are case-insensitive; WP_REST_Request normalizes internally.
    $provided = '';
    if (is_object($request) && method_exists($request, 'get_header')) {
        $provided = (string) $request->get_header('x-wpnova-secret');
    }

    if ($provided === '') {
        return new WP_Error('wpnova_secret_required', 'Missing X-WPNOVA-Secret header', array('status' => 403));
        }

    if (!hash_equals((string) WPNOVA_WEBHOOK_SECRET, $provided)) {
        return new WP_Error('wpnova_secret_invalid', 'Invalid webhook secret', array('status' => 403));
    }

    return true;
}

/**
 * Handle incoming notification that data.csv is ready
 *
 * @param WP_REST_Request $request The request object
 * @return WP_REST_Response Response object
 */
function handle_data_ready_notification($request) {
    // Get parameters from the request
    $params = $request->get_params();

    // Optional force update (bypass up-to-date skip)
    $force_update = false;
    if (isset($params['force_update'])) {
        $force_update = (bool) filter_var($params['force_update'], FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
        $force_update = ($force_update === null) ? false : $force_update;
    } elseif (isset($params['force'])) {
        $force_update = (bool) filter_var($params['force'], FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
        $force_update = ($force_update === null) ? false : $force_update;
    }
    
    // No notifications - just log the API trigger silently
    $log_message = sprintf(
        'Update job queued via API trigger at %s',
        current_time('mysql')
    );
    
    // Add to existing log or create new log
    $existing_log = get_option('csv_product_updater_log', array());
    array_unshift($existing_log, $log_message); // Add to beginning of log
    csv_product_updater_save_log($existing_log);
    
    // Update the last update time
    update_option('csv_product_updater_last_updated_date', current_time('mysql'));
    
    // Queue background job (returns immediately; batches run via WP-Cron)
    $job_state = csv_product_updater_start_job($force_update, 'webhook');
    
    // Return success response
    return new WP_REST_Response(array(
        'success' => true,
        'message' => 'Update queued successfully',
        'job_state' => $job_state,
        'timestamp' => current_time('mysql')
    ), 200);
}

// Also handle direct access to plugin.php for non-WordPress environments
if (basename($_SERVER['SCRIPT_FILENAME']) === 'plugin.php' && !defined('ABSPATH')) {
    // This code runs when plugin.php is called directly
    
    // Check if it's a POST request to handle data ready notification
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        // Get the raw POST data
        $json_data = file_get_contents('php://input');
        $data = json_decode($json_data, true);
        
        if (isset($data['action']) && $data['action'] === 'data_ready') {
            // Rather than showing a notification, just trigger the update silently
            // Include a minimal log entry for diagnostics but don't display to admins
            $log_file = __DIR__ . '/api_update_log.txt';
            $log_message = sprintf(
                "[%s] Products updated via API trigger\n",
                date('Y-m-d H:i:s')
            );
            
            file_put_contents($log_file, $log_message, FILE_APPEND);
            
            // Send success response
            header('Content-Type: application/json');
            echo json_encode(array(
                'success' => true,
                'message' => 'Update triggered successfully',
                'timestamp' => date('Y-m-d H:i:s')
            ));
            
            exit;
        }
    }
    
    // If it's not a valid POST request, return error
    header('Content-Type: application/json');
    header('HTTP/1.1 400 Bad Request');
    echo json_encode(array(
        'success' => false,
        'message' => 'Invalid request'
    ));
    exit;
}
