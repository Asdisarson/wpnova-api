<?php
/*
Plugin Name: CSV Product Updater
Description: Updates WooCommerce product files based on a CSV file.
Version: 1.1
Author: WP NOVA
*/

define('FETCH_API_WPNOVA', 'https://seashell-app-duvll.ondigitalocean.app/');

// 15 minutes (in seconds) for all network calls made by this plugin
if (!defined('CSV_PRODUCT_UPDATER_HTTP_TIMEOUT')) {
    define('CSV_PRODUCT_UPDATER_HTTP_TIMEOUT', defined('MINUTE_IN_SECONDS') ? 15 * MINUTE_IN_SECONDS : 900);
}

// Register activation hook
register_activation_hook(__FILE__, 'csv_product_updater_activation');
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
function send_refresh_request($date = null) {
    $endpoint_url = FETCH_API_WPNOVA . 'refresh';
    if ($date) {
        $endpoint_url .= '?date=' . urlencode($date);
    }
    $response = wp_remote_get($endpoint_url, array('timeout' => CSV_PRODUCT_UPDATER_HTTP_TIMEOUT));

    // Handle the response if needed
    if (is_wp_error($response)) {
        // Log error or take necessary action
    } else {
        // Process the response if needed
    }
}

// Activation function
function csv_product_updater_activation() {
    if (!wp_next_scheduled('csv_product_updater_daily_event')) {
        // Schedule the event for 23:30 GMT every day
        wp_schedule_event(strtotime('23:30:00'), 'daily', 'csv_product_updater_daily_event');
    }
}

// Register deactivation hook
register_deactivation_hook(__FILE__, 'csv_product_updater_deactivation');

// Deactivation function
function csv_product_updater_deactivation() {
    wp_clear_scheduled_hook('csv_product_updater_daily_event');
}

// Hook into the daily event
add_action('csv_product_updater_daily_event', 'update_product_files');

function update_product_files() {
    $csv_file_url = FETCH_API_WPNOVA . 'data.csv';
    $log = array();
    $result = array(
        'start_time' => current_time('mysql'),
        'total_rows' => 0,
        'products_updated' => 0,
        'products_up_to_date' => 0,
        'products_not_found' => 0,
        'download_failures' => 0
    );

    // Get CSV data from the URL (WordPress HTTP API)
    $csv_response = wp_remote_get($csv_file_url, array(
        'timeout'     => CSV_PRODUCT_UPDATER_HTTP_TIMEOUT,
        'redirection' => 5,
    ));

    if (is_wp_error($csv_response)) {
        $error_message = 'Failed to fetch CSV data from ' . $csv_file_url . ' - ' . $csv_response->get_error_message();
        $log[] = $error_message;
        update_option('csv_product_updater_log', $log);
        $result['error'] = $error_message;
        $result['end_time'] = current_time('mysql');
        return $result;
    }

    $csv_response_code = wp_remote_retrieve_response_code($csv_response);
    if ($csv_response_code != 200) {
        $error_message = 'Failed to fetch CSV data from ' . $csv_file_url . ' - HTTP ' . $csv_response_code;
        $log[] = $error_message;
        update_option('csv_product_updater_log', $log);
        $result['error'] = $error_message;
        $result['end_time'] = current_time('mysql');
        return $result;
    }

    $csv_body = wp_remote_retrieve_body($csv_response);
    if (!is_string($csv_body) || trim($csv_body) === '') {
        $error_message = 'Failed to fetch CSV data from ' . $csv_file_url . ' - empty body';
        $log[] = $error_message;
        update_option('csv_product_updater_log', $log);
        $result['error'] = $error_message;
        $result['end_time'] = current_time('mysql');
        return $result;
    }

    $csv_lines = preg_split("/\r\n|\n|\r/", trim($csv_body));
    
    $csv_data = array_map('str_getcsv', $csv_lines);
    
    array_shift($csv_data);  // Remove the header row
    $result['total_rows'] = count($csv_data);
    $log[] = 'Total rows in CSV: ' . count($csv_data);

    // Iterate over each row of the CSV data
    foreach ($csv_data as $row) {
        // Extract the slug early so we don't download files for missing products
        $slug = isset($row[7]) ? trim($row[7]) : '';  // slug column
        if ($slug === '') {
            $log[] = 'Skipped row - empty slug';
            continue;
        }

        // Find a product that matches the slug
        $product = get_page_by_path($slug, OBJECT, 'product');
        
        // If not found by path, try WP_Query with exact slug match
        if (!$product) {
            $args = array(
                'post_type' => 'product',
                'name' => $slug,
                'posts_per_page' => 1,
                'post_status' => 'publish'
            );
            $query = new WP_Query($args);
            if ($query->have_posts()) {
                $product = $query->posts[0];
            }
            wp_reset_postdata();
        }

        // If a matching product was found, update its file (only if version changed)
        if ($product) {
            $new_version = isset($row[5]) ? trim($row[5]) : ''; // version column
            $existing_version = get_post_meta($product->ID, 'product-version', true);
            if ($new_version !== '' && (string) $existing_version === (string) $new_version) {
                $log[] = 'Up-to-date - skipped download for product: ' . $slug . ' (ID: ' . $product->ID . ', version: ' . $new_version . ')';
                $result['products_up_to_date']++;
                continue;
            }

            // Extract the file URL (only after we know we need to update)
            $file_url = isset($row[8]) ? $row[8] : '';  // fileUrl column
            // Ensure no double slashes when concatenating
            $file_url = rtrim(FETCH_API_WPNOVA, '/') . '/' . ltrim($file_url, '/');

            // Check if the file URL is valid
            if (filter_var($file_url, FILTER_VALIDATE_URL) === false) {
                $log[] = 'Invalid file URL: ' . $file_url;
                $result['download_failures']++;
                continue;
            }

            // Download the file and save it temporarily on your server (streaming, no in-memory body)
            $download_result = download_file($file_url);

            // Check if the file was downloaded successfully
            if ($download_result === false || !is_array($download_result)) {
                $log[] = 'Failed to download file from URL: ' . $file_url;
                $result['download_failures']++;
                continue;
            }

            list($temp_file_path, $original_file_name) = $download_result;

            // Use the filename from the URL path (ignores query strings)
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
                // Update the product version
                if ($new_version !== '') {
                    update_post_meta($product->ID, 'product-version', $new_version);  // version column
                }
                
                // Ensure product is marked as downloadable
                update_post_meta($product->ID, '_downloadable', 'yes');
                update_post_meta($product->ID, '_virtual', 'yes');
                
                $log[] = 'Updated product: ' . $slug . ' (ID: ' . $product->ID . ')';
                $result['products_updated']++;
            } else {
                // Clean up the temp file on failure (update_product_file only moves it on success)
                if (isset($temp_file_path) && file_exists($temp_file_path)) {
                    unlink($temp_file_path);
                }
                $log[] = 'Failed to update files for product: ' . $slug . ' (ID: ' . $product->ID . ')';
                $result['download_failures']++;
            }
        } else {
            $log[] = 'Skipped - no product found for slug: ' . $slug;
            $result['products_not_found']++;
        }
    }

    // Store the log data in an option instead of a transient so it persists until the next update
    update_option('csv_product_updater_log', $log);
    
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
    echo '<form method="post">';
    wp_nonce_field('csv_product_updater_nonce', 'csv_product_updater_nonce_field');
    echo '<input type="submit" name="csv_product_updater_update" value="Update Products" />';
    echo '<p>Last manual update on: ' . get_option('csv_product_updater_last_updated_date', 'Never') . '</p>';
    echo '</form>';
    
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
    echo '<form method="post" style="margin-top:20px;">';
    wp_nonce_field('csv_product_refresh_nonce', 'csv_product_refresh_nonce_field');
    echo '<label for="csv_product_updater_date">Select Date: </label>';
    echo '<input type="date" id="csv_product_updater_date" name="csv_product_updater_date" value="' . esc_attr(get_option('csv_product_updater_last_refresh_date', date('Y-m-d'))) . '" />';
    echo '<input type="submit" name="csv_product_updater_send_refresh" value="Send Refresh Request" />';
    echo '<p>Last refresh request sent on: ' . get_option('csv_product_updater_last_refresh_date', 'Never') . '</p>';
    echo '</form>';

    // Display the loading sign (hidden by default, to be shown by JS when needed)
    echo '<div id="loading-sign" style="display: none;"><img src="/loading.gif" alt="Loading..."> Loading...</div>';

    // Get the log data from the option
    $log = get_option('csv_product_updater_log', array());

    // If the log data exists, display it
    if (!empty($log)) {
        echo '<h2>Update Log</h2>';
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
    if (isset($_POST['csv_product_updater_update']) && check_admin_referer('csv_product_updater_nonce', 'csv_product_updater_nonce_field')) {
        // Set the date of the last update
        update_option('csv_product_updater_last_updated_date', current_time('mysql'));

        update_product_files();
    }

    // Check if the new "Send Refresh Request" button was clicked and verify nonce
    if (isset($_POST['csv_product_updater_send_refresh']) && check_admin_referer('csv_product_refresh_nonce', 'csv_product_refresh_nonce_field')) {
        // Get the selected date
        $selected_date = sanitize_text_field($_POST['csv_product_updater_date']);
        if (empty($selected_date)) {
            $selected_date = date('Y-m-d'); // Default to current date if none selected
        }

        // Set the date of the last refresh request
        update_option('csv_product_updater_last_refresh_date', current_time('mysql'));

        send_refresh_request($selected_date);
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

    wp_enqueue_script('jquery-ui-datepicker');
    wp_enqueue_style('jquery-ui', 'https://code.jquery.com/ui/1.12.1/themes/base/jquery-ui.css');

    ?>
    <script type="text/javascript">
        jQuery(document).ready(function($) {
            $('#csv_product_updater_date').datepicker({
                dateFormat: 'yy-mm-dd'
            });

            const updateBtn = document.querySelector('[name="csv_product_updater_update"]');
            const refreshBtn = document.querySelector('[name="csv_product_updater_send_refresh"]');
            const loadingSign = document.getElementById('loading-sign');

            updateBtn.addEventListener('click', function() {
                loadingSign.style.display = 'block';
            });

            refreshBtn.addEventListener('click', function() {
                loadingSign.style.display = 'block';
            });
        });
    </script>
    <?php
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
        // For CDN URLs, we'll check if the URL is accessible
        $response = wp_remote_head($file_url, array('timeout' => CSV_PRODUCT_UPDATER_HTTP_TIMEOUT));
        if (!is_wp_error($response)) {
            $response_code = wp_remote_retrieve_response_code($response);
            $file_exists = ($response_code == 200);
            error_log('CSV Product Updater: CDN file check for ' . $file_url . ' - exists: ' . ($file_exists ? 'yes' : 'no'));
        }
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
        'permission_callback' => function() {
            // You can implement more advanced authentication here
            return true;
        }
    ));
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
    
    // No notifications - just log the API trigger silently
    $log_message = sprintf(
        'Products updated via API trigger at %s',
        current_time('mysql')
    );
    
    // Add to existing log or create new log
    $existing_log = get_option('csv_product_updater_log', array());
    array_unshift($existing_log, $log_message); // Add to beginning of log
    update_option('csv_product_updater_log', $existing_log);
    
    // Update the last update time
    update_option('csv_product_updater_last_updated_date', current_time('mysql'));
    
    // Trigger product update process immediately without notification
    $update_result = update_product_files();
    
    // Return success response
    return new WP_REST_Response(array(
        'success' => true,
        'message' => 'Update triggered successfully',
        'update_result' => $update_result,
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
