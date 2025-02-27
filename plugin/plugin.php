<?php
/*
Plugin Name: CSV Product Updater
Description: Updates WooCommerce product files based on a CSV file.
Version: 1.1
Author: WP NOVA
*/

define('FETCH_API_WPNOVA', 'https://seahorse-app-tx38o.ondigitalocean.app/');

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
    $response = wp_remote_get($endpoint_url);

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
        'products_not_found' => 0,
        'download_failures' => 0
    );

    // Get CSV data from the URL
    $csv_data = @array_map('str_getcsv', @file($csv_file_url));
    
    if (!$csv_data) {
        $error_message = 'Failed to fetch CSV data from ' . $csv_file_url;
        $log[] = $error_message;
        update_option('csv_product_updater_log', $log);
        $result['error'] = $error_message;
        $result['end_time'] = current_time('mysql');
        return $result;
    }
    
    array_shift($csv_data);  // Remove the header row
    $result['total_rows'] = count($csv_data);
    $log[] = 'Total rows in CSV: ' . count($csv_data);

    // Iterate over each row of the CSV data
    foreach ($csv_data as $row) {
        // Extract the file URL
        $file_url = $row[8];  // fileUrl column
        $file_url = FETCH_API_WPNOVA . 'downloads/' . $file_url;

        // Check if the file URL is valid
        if (filter_var($file_url, FILTER_VALIDATE_URL) === false) {
            $log[] = 'Invalid file URL: ' . $file_url;
            $result['download_failures']++;
            continue;
        }

        // Download the file and save it temporarily on your server
        list($temp_file_path, $original_file_name) = download_file($file_url);

        // Check if the file was downloaded successfully
        if ($temp_file_path === false) {
            $log[] = 'Failed to download file from URL: ' . $file_url;
            $result['download_failures']++;
            continue;
        }

        // Extract the slug
        $slug = $row[7];  // slug column11

        // Find a product that matches the slug
        $product = get_page_by_path($slug, OBJECT, 'product');

        // If a matching product was found, update its file
        if ($product) {
            // Upload the file to the uploads directory
            $upload_dir = wp_upload_dir();
            $uploaded_file_path = $upload_dir['path'] . '/' . $original_file_name;
            rename($temp_file_path, $uploaded_file_path);

            // Set the downloadable file name from the "filename" column
            $download_file_name = basename($row[8]);  // filename column
            update_product_file($product->ID, $uploaded_file_path, $download_file_name);

            // Update the product version
            update_post_meta($product->ID, 'product-version', $row[5]);  // version column

            $log[] = 'Updated product: ' . $slug;
            $result['products_updated']++;
        } else {
            $log[] = 'No product found for slug: ' . $slug;
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
    // Use WordPress's HTTP API to download the file
    $response = wp_remote_get($url, array('timeout' => 30));

    if (is_wp_error($response)) {
        return false;
    }

    $response_code = wp_remote_retrieve_response_code($response);
    if ($response_code != 200) {
        return false;
    }

    // Get the body of the response
    $body = wp_remote_retrieve_body($response);
    if (empty($body)) {
        return false;
    }

    // Save the file
    $temp_file_path = tempnam(sys_get_temp_dir(), 'csv_product_updater');
    if (file_put_contents($temp_file_path, $body) === false) {
        return false;
    }

    // Extract the original file name from the URL
    $original_file_name = basename(parse_url($url, PHP_URL_PATH));

    return array($temp_file_path, $original_file_name);
}

// Update a product's file with a new file while retaining the original download_id
function update_product_file($product_id, $file_path, $file_name) {
    // Create a WC_Product_Download object
    $download = new WC_Product_Download();

    // Prepare for upload to Media Library
    $upload_dir = wp_upload_dir();
    $new_file_path = $upload_dir['path'] . '/' . $file_name;
    rename($file_path, $new_file_path);

    // Insert the file into the Media Library and get its ID
    $file_info = wp_insert_attachment(array(
        'guid'           => $new_file_path,
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

    // Get the file's URL from the Media Library
    $file_url = wp_get_attachment_url($file_info);

    // Set the file path and name
    $download->set_file($file_url);
    $download->set_name('Download Now');

    // Use WooCommerce's API to get existing product file
    $product = wc_get_product($product_id);
    $existing_downloads = $product->get_downloads();

    if (!empty($existing_downloads)) {
        // Use the existing download's ID to maintain the same download_id
        $existing_download = reset($existing_downloads); // Get the first download
        $download->set_id($existing_download->get_id());
    }

    $product->set_downloads(array($download));
    $product->save();
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
