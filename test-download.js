// Simple test script to verify the download functionality
require('dotenv').config();
const { downloadAllFiles } = require('./func/scheduledTaskYesterday');
const SimpleJsonDb = require('simple-json-db');
const path = require('path');
const fs = require('fs');

// Set NODE_ENV to development for testing by default, can be overridden when calling the script
// To test in production mode: NODE_ENV=production node test-download.js
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'development';
}

const mode = process.env.NODE_ENV === 'development' ? 'development' : 'production';
console.log(`Starting test download in ${mode} mode...`);

// Get the date to use, defaulting to today
// Can be overridden by passing a date via command line argument
// Example: node test-download.js "2023-01-15"
let testDate = new Date();
if (process.argv.length > 2) {
  testDate = new Date(process.argv[2]);
  if (isNaN(testDate.getTime())) {
    console.error(`Invalid date format: ${process.argv[2]}`);
    console.error('Please use YYYY-MM-DD format');
    process.exit(1);
  }
}

console.log(`Using date: ${testDate.toLocaleDateString('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
})}`);

if (mode === 'development') {
  console.log('This will download and zip files from up to 2 products');
} else {
  console.log('This will download and zip files from ALL available products');
}

// Check download directory status before starting
const downloadsDir = path.resolve('./public/downloads/');
if (fs.existsSync(downloadsDir)) {
  console.log(`Download directory exists at ${downloadsDir}`);
  const files = fs.readdirSync(downloadsDir)
    .filter(file => fs.statSync(path.join(downloadsDir, file)).isFile());
  console.log(`Found ${files.length} files in download directory before starting`);
} else {
  console.log(`Download directory does not exist, will be created during process`);
}

// Check current download history status
try {
  const dbPath = path.join(__dirname, 'func', 'download_history.json');
  if (fs.existsSync(dbPath)) {
    const downloadHistory = new SimpleJsonDb(dbPath);
    const historyData = downloadHistory.JSON();
    const historyCount = Object.keys(historyData).length;
    console.log(`Current download history contains ${historyCount} items`);
  } else {
    console.log('No download history file exists yet, will be created during process');
  }
} catch (error) {
  console.log(`Error checking download history: ${error.message}`);
}

// Run the download function
console.log('Starting downloadAllFiles function...');
downloadAllFiles(testDate)
  .then((result) => {
    console.log('Download complete!');
    console.log(`Downloaded ${result.downloadedCount} files`);
    console.log(`Skipped ${result.skippedCount} files (already existed)`);
    
    // Check CSV output files
    const dataPath = path.resolve('./public/data.csv');
    const errorPath = path.resolve('./public/error.csv');
    
    if (fs.existsSync(dataPath)) {
      const stats = fs.statSync(dataPath);
      console.log(`Data CSV file created: ${dataPath}`);
      console.log(`File size: ${formatBytes(stats.size)}`);
    }
    
    if (fs.existsSync(errorPath)) {
      const stats = fs.statSync(errorPath);
      console.log(`Error CSV file created: ${errorPath}`);
      console.log(`File size: ${formatBytes(stats.size)}`);
    }
    
    // Check updated download history
    try {
      const dbPath = path.join(__dirname, 'func', 'download_history.json');
      if (fs.existsSync(dbPath)) {
        const downloadHistory = new SimpleJsonDb(dbPath);
        const historyData = downloadHistory.JSON();
        const historyCount = Object.keys(historyData).length;
        console.log(`Updated download history contains ${historyCount} items`);
      }
    } catch (error) {
      console.log(`Error checking updated download history: ${error.message}`);
    }
  })
  .catch((error) => {
    console.error('Test failed with error:', error);
  });

/**
 * Format bytes to a human-readable format
 */
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
} 