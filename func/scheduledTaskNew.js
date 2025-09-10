// New scheduled task using the unified changelog downloader
const downloadFromChangelog = require('./changelogDownloader');

/**
 * Scheduled task to download today's products from changelog
 * This is a simplified version that uses the unified changelog downloader
 */
const scheduledTask = async () => {
    try {
        console.log('=== Starting Scheduled Task ===');
        console.log(`Time: ${new Date().toISOString()}`);
        
        // Download today's products
        const result = await downloadFromChangelog({
            date: new Date(),           // Today's date
            resultsPerPage: 500,        // Get up to 500 results
            downloadFiles: true         // Download the files
        });
        
        console.log('=== Scheduled Task Complete ===');
        console.log(`Downloaded: ${result.downloadedCount} products`);
        console.log(`Errors: ${result.errorCount}`);
        
        // Return the count for compatibility with existing code
        return result.downloadedCount;
        
    } catch (error) {
        console.error('Scheduled task failed:', error);
        throw error;
    }
};

module.exports = scheduledTask;
