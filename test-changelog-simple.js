// Simple test for changelog downloader
require('dotenv').config();
const downloadFromChangelog = require('./func/changelogDownloader');

console.log('Starting changelog downloader test...');
console.log(`Testing with date: ${new Date().toLocaleDateString()}`);

downloadFromChangelog({
    date: new Date(),
    resultsPerPage: 50, // Limit to 50 products for quick test
    downloadFiles: false // Don't actually download, just test navigation and link extraction
})
.then((result) => {
    console.log('\n=== TEST COMPLETE ===');
    console.log(`Total products found: ${result.products.length}`);
    console.log(`Products with download links: ${result.products.filter(p => p.downloadLink).length}`);
    console.log(`Errors: ${result.errorCount}`);
    
    // Show first 5 products and their download status
    console.log('\nFirst 5 products:');
    result.products.slice(0, 5).forEach((product, i) => {
        console.log(`${i + 1}. ${product.productName}`);
        console.log(`   Has download link: ${product.downloadLink ? 'YES ✅' : 'NO ❌'}`);
        if (product.downloadLink) {
            console.log(`   Link: ${product.downloadLink.substring(0, 60)}...`);
        }
    });
})
.catch((error) => {
    console.error('\n=== TEST FAILED ===');
    console.error(error.message);
    process.exit(1);
});

