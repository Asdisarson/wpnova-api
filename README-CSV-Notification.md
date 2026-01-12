# CSV Data & WordPress Product Update System

This documentation explains the automatic update system between the Node.js application that generates CSV data and the WordPress plugin that processes this data.

## Overview

The system consists of two main components:

1. **Node.js Application**: Fetches data from external sources, generates CSV files, and automatically triggers WordPress product updates.
2. **WordPress Plugin**: Receives the update trigger and silently processes the CSV data to update product information without admin notification.

## How It Works

1. The Node.js application runs on a schedule to fetch and process data.
2. When processing is complete and the CSV files are generated, it sends an update trigger to the WordPress plugin.
3. The WordPress plugin queues a **background batch update job** (so it won’t time out), and you can watch progress in the admin UI (Settings → CSV Product Updater).

## Node.js Application Configuration

The Node.js application is configured to send an update trigger after successfully generating the CSV files. 

### Environment Variables

- `WORDPRESS_DATA_READY_URL`: The WordPress REST webhook URL (e.g. `https://your-wordpress-site.com/wp-json/wpnova/v1/data-ready`)
- `WPNOVA_WEBHOOK_SECRET`: Shared secret used to authenticate the webhook (must match WordPress `WPNOVA_WEBHOOK_SECRET`)

Legacy (only used by older scripts):

- `WORDPRESS_PLUGIN_URL`: Legacy direct URL to plugin.php (not recommended)
- `PLUGIN_URL`: Legacy fallback for `WORDPRESS_PLUGIN_URL`

### How to Set Environment Variables

```bash
# For production
export WORDPRESS_DATA_READY_URL=https://wpnova.io/wp-json/wpnova/v1/data-ready
export WPNOVA_WEBHOOK_SECRET='replace-with-a-long-random-secret'

# For development
export WORDPRESS_DATA_READY_URL=http://localhost/wp-json/wpnova/v1/data-ready
export WPNOVA_WEBHOOK_SECRET='replace-with-a-long-random-secret'
```

## WordPress Plugin Configuration

The WordPress plugin is configured to receive and process update triggers through two methods:

1. **WordPress REST API**: Endpoint at `/wp-json/wpnova/v1/data-ready`
2. **Direct Access**: Direct POST requests to the plugin.php file (legacy; does not run updates because WordPress isn’t loaded)

### Shared secret (required)

Add this to your `wp-config.php`:

```php
define('WPNOVA_WEBHOOK_SECRET', 'replace-with-a-long-random-secret');
```

## Testing the Update System

### Testing from Node.js to WordPress

```bash
# Run the Node.js application with the webhook URL + secret
WORDPRESS_DATA_READY_URL=https://wpnova.io/wp-json/wpnova/v1/data-ready \
WPNOVA_WEBHOOK_SECRET='replace-with-a-long-random-secret' \
npm start
```

### Manual Testing

You can manually test the update system using curl:

```bash
# Test the WordPress REST API endpoint
curl -X POST \
  https://wpnova.io/wp-json/wpnova/v1/data-ready \
  -H 'Content-Type: application/json' \
  -H 'X-WPNOVA-Secret: replace-with-a-long-random-secret' \
  -d '{"force_update":false,"timestamp":123}'

# Test direct access to plugin.php
curl -X POST \
  https://wpnova.io/wp-content/plugins/wpnova/plugin.php \
  -H 'Content-Type: application/json' \
  -d '{"action":"data_ready"}'
```

## Logs and Debugging

### Node.js Logs

The Node.js application logs update trigger attempts and results to the console. Look for messages like:

```
[webhook] Notifying WordPress data-ready: https://wpnova.io/wp-json/wpnova/v1/data-ready
[webhook] WordPress notified successfully (status 200)
```

### WordPress Logs

The WordPress plugin logs update operations in:

1. **Admin Dashboard**: Under Settings > CSV Product Updater in the update log section
2. **Direct Access Log**: A file named `api_update_log.txt` in the plugin directory

## Troubleshooting

### Common Issues

1. **Connection Refused**: Verify that the WordPress site is accessible and that the plugin URL is correct.
2. **Authentication Failed**: Ensure `WPNOVA_WEBHOOK_SECRET` is set in WordPress and the Node env var matches it.
3. **Timeout**: Check network connectivity and increase the timeout value in the Node.js application if needed.

### Solutions

- Verify environment variables are correctly set
- Check network connectivity between the Node.js server and WordPress site
- Ensure the WordPress plugin is active and properly installed
- Check server firewall settings to allow communication between servers 