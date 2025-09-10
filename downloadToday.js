#!/usr/bin/env node

// Script to download today's products from changelog
require('dotenv').config();
const downloadFromChangelog = require('./func/changelogDownloader');

async function downloadTodaysProducts() {
    console.log('========================================');
    console.log('   CHANGELOG DOWNLOADER - TODAY\'S PRODUCTS');
    console.log('========================================\n');
    
    try {
        const result = await downloadFromChangelog({
            date: new Date(),           // Today's date
            resultsPerPage: 500,        // Get up to 500 results
            downloadFiles: true         // Actually download the files
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

// Run if called directly
if (require.main === module) {
    downloadTodaysProducts();
}

module.exports = downloadTodaysProducts;
