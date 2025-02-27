# CSV Data & WordPress Product Update System

This documentation explains the automatic update system between the Node.js application that generates CSV data and the WordPress plugin that processes this data.

## Overview

The system consists of two main components:

1. **Node.js Application**: Fetches data from external sources, generates CSV files, and automatically triggers WordPress product updates.
2. **WordPress Plugin**: Receives the update trigger and silently processes the CSV data to update product information without admin notification.

## How It Works

1. The Node.js application runs on a schedule to fetch and process data.
2. When processing is complete and the CSV files are generated, it sends an update trigger to the WordPress plugin.
3. The WordPress plugin immediately processes the CSV data and updates the products without requiring admin notification or intervention.

## Node.js Application Configuration

The Node.js application is configured to send an update trigger after successfully generating the CSV files. 

### Environment Variables

- `WORDPRESS_PLUGIN_URL`: The URL to the WordPress plugin.php file (e.g., `https://your-wordpress-site.com/wp-content/plugins/wpnova/plugin.php`)
- `PLUGIN_URL`: Fallback URL (for backward compatibility)

### How to Set Environment Variables

```bash
# For production
export WORDPRESS_PLUGIN_URL=https://your-wordpress-site.com/wp-content/plugins/wpnova/plugin.php

# For development
export WORDPRESS_PLUGIN_URL=http://localhost/wp-content/plugins/wpnova/plugin.php
```

## WordPress Plugin Configuration

The WordPress plugin is configured to receive and process update triggers through two methods:

1. **WordPress REST API**: Endpoint at `/wp-json/wpnova/v1/data-ready`
2. **Direct Access**: Direct POST requests to the plugin.php file

No additional configuration is needed for the WordPress plugin, as it is set up to handle update triggers automatically.

## Testing the Update System

### Testing from Node.js to WordPress

```bash
# Run the Node.js application with the proper environment variable
WORDPRESS_PLUGIN_URL=https://your-wordpress-site.com/wp-content/plugins/wpnova/plugin.php node index.js
```

### Manual Testing

You can manually test the update system using curl:

```bash
# Test the WordPress REST API endpoint
curl -X POST \
  https://your-wordpress-site.com/wp-json/wpnova/v1/data-ready \
  -H 'Content-Type: application/json' \
  -d '{"action":"data_ready"}'

# Test direct access to plugin.php
curl -X POST \
  https://your-wordpress-site.com/wp-content/plugins/wpnova/plugin.php \
  -H 'Content-Type: application/json' \
  -d '{"action":"data_ready"}'
```

## Logs and Debugging

### Node.js Logs

The Node.js application logs update trigger attempts and results to the console. Look for messages like:

```
Triggering product update via WordPress plugin...
Sending update trigger to: https://your-wordpress-site.com/wp-content/plugins/wpnova/plugin.php
Update triggered successfully with status: 200
```

### WordPress Logs

The WordPress plugin logs update operations in:

1. **Admin Dashboard**: Under Settings > CSV Product Updater in the update log section
2. **Direct Access Log**: A file named `api_update_log.txt` in the plugin directory

## Troubleshooting

### Common Issues

1. **Connection Refused**: Verify that the WordPress site is accessible and that the plugin URL is correct.
2. **Authentication Failed**: Ensure that the WordPress site allows unauthenticated REST API access or implement proper authentication.
3. **Timeout**: Check network connectivity and increase the timeout value in the Node.js application if needed.

### Solutions

- Verify environment variables are correctly set
- Check network connectivity between the Node.js server and WordPress site
- Ensure the WordPress plugin is active and properly installed
- Check server firewall settings to allow communication between servers 