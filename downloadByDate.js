#!/usr/bin/env node

// Script to download products from changelog for a specific date
require('dotenv').config();
const downloadFromChangelog = require('./func/changelogDownloader');

async function downloadByDate(dateString) {
    console.log('========================================');
    console.log('   CHANGELOG DOWNLOADER - BY DATE');
    console.log('========================================\n');
    
    // Parse the date
    let targetDate;
    if (dateString) {
        targetDate = new Date(dateString);
        if (isNaN(targetDate.getTime())) {
            console.error('❌ Invalid date format. Please use YYYY-MM-DD format');
            process.exit(1);
        }
    } else {
        targetDate = new Date();
    }
    
    const formattedDate = targetDate.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });
    
    console.log(`📅 Downloading products for: ${formattedDate}\n`);
    
    try {
        const result = await downloadFromChangelog({
            date: targetDate,
            resultsPerPage: 500,
            downloadFiles: true
        });
        
        console.log('\n========================================');
        console.log('   DOWNLOAD COMPLETE');
        console.log('========================================');
        console.log(`✅ Downloaded: ${result.downloadedCount} products`);
        console.log(`❌ Errors: ${result.errorCount}`);
        
        if (result.errors.length > 0) {
            console.log('\n⚠️  Failed downloads:');
            result.errors.forEach(err => {
                console.log(`  - ${err.product}: ${err.error}`);
            });
        }
        
        process.exit(0);
    } catch (error) {
        console.error('\n❌ Fatal error:', error.message);
        process.exit(1);
    }
}

// Parse command line arguments
const args = process.argv.slice(2);
const dateArg = args[0];

if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node downloadByDate.js [date]');
    console.log('');
    console.log('Examples:');
    console.log('  node downloadByDate.js                  # Download today\'s products');
    console.log('  node downloadByDate.js 2025-09-10       # Download products from September 10, 2025');
    console.log('  node downloadByDate.js "September 10, 2025"');
    process.exit(0);
}

// Run if called directly
if (require.main === module) {
    downloadByDate(dateArg);
}

module.exports = downloadByDate;
