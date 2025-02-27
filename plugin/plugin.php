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

    // Get CSV data from the URL
    $csv_data = array_map('str_getcsv', file($csv_file_url));
    array_shift($csv_data);  // Remove the header row

    $log[] = 'Total rows in CSV: ' . count($csv_data);

    // Iterate over each row of the CSV data
    foreach ($csv_data as $row) {
        // Extract the file URL
        $file_url = $row[8];  // fileUrl column
        $file_url = FETCH_API_WPNOVA . 'downloads/' . $file_url;

        // Check if the file URL is valid
        if (filter_var($file_url, FILTER_VALIDATE_URL) === false) {
            $log[] = 'Invalid file URL: ' . $file_url;
            continue;
        }

        // Download the file and save it temporarily on your server
        list($temp_file_path, $original_file_name) = download_file($file_url);

        // Check if the file was downloaded successfully
        if ($temp_file_path === false) {
            $log[] = 'Failed to download file from URL: ' . $file_url;
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
        } else {
            $log[] = 'No product found for slug: ' . $slug;
        }
    }

    // Store the log data in an option instead of a transient so it persists until the next update
    update_option('csv_product_updater_log', $log);
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

    // Print the existing update button with nonce field for security
    echo '<form method="post">';
    wp_nonce_field('csv_product_updater_nonce', 'csv_product_updater_nonce_field');
    echo '<input type="submit" name="csv_product_updater_update" value="Update Products" />';
    echo '<p>Last updated on: ' . get_option('csv_product_updater_last_updated_date', 'Never') . '</p>';
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
