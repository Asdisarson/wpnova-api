// Test downloading a single product to check session persistence
require('dotenv').config();
const downloadFromChangelog = require('./func/changelogDownloader');

console.log('Testing single product download with session verification...\n');

downloadFromChangelog({
    date: new Date(),
    resultsPerPage: 10, // Get just 10 products
    downloadFiles: true // Actually try to download
})
.then((result) => {
    console.log('\n=== TEST COMPLETE ===');
    console.log(`Downloaded: ${result.downloadedCount} files`);
    console.log(`Errors: ${result.errorCount}`);
    process.exit(0);
})
.catch((error) => {
    console.error('\n=== TEST FAILED ===');
    console.error(error);
    process.exit(1);
});

