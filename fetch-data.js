#!/usr/bin/env node

/**
 * Simple script to run the scheduledTask function with a specific date
 */

const scheduledTask = require('./func/scheduledTaskYesterday.js');
const { downloadAllFiles } = require('./func/scheduledTaskYesterday.js');

// Use today's date by default, or a date provided as argument
const dateArg = process.argv[2]; // e.g., "2023-06-15"
const date = dateArg ? new Date(dateArg) : new Date();

// Check if we should only download files
const downloadOnly = process.argv.includes('--download-only');

// Format date for display
const formattedDate = date.toISOString().split('T')[0];

console.log(`Running fetch for date: ${formattedDate}`);

// Run the task
if (downloadOnly) {
  console.log('Running download only mode...');
  downloadAllFiles(date)
    .then(result => {
      console.log('Download completed successfully:', result);
    })
    .catch(err => {
      console.error('Error:', err);
      process.exit(1);
    });
} else {
  console.log('Running full scheduled task...');
  scheduledTask(date)
    .then(result => {
      console.log('Task completed successfully:', result);
    })
    .catch(err => {
      console.error('Error:', err);
      process.exit(1);
    });
} 