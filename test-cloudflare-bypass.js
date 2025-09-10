// Load environment variables
require('dotenv').config();

const { 
    createCloudflareBypassBrowser, 
    navigateWithRetry, 
    handleCloudflareChallenge, 
    addHumanLikeBehavior, 
    closeBrowser,
    randomDelay 
} = require('./func/cloudflareBypass');

async function testCloudflareBypass() {
    let browser;
    
    try {
        console.log('Testing Cloudflare bypass...');
        
        // Create browser with bypass
        const { browser: testBrowser, page } = await createCloudflareBypassBrowser();
        browser = testBrowser;
        
        // Add human-like behavior
        await addHumanLikeBehavior(page);
        
        // Test with a Cloudflare-protected site (you can change this to your target site)
        const testUrl = 'https://www.realgpl.com/';
        console.log(`Testing navigation to: ${testUrl}`);
        
        // Navigate with retry logic
        const response = await navigateWithRetry(page, testUrl);
        
        console.log(`Response status: ${response ? response.status() : 'unknown'}`);
        
        // Check if we successfully bypassed Cloudflare
        const pageTitle = await page.title();
        console.log(`Page title: ${pageTitle}`);
        
        // Check if we got actual content (not blocked)
        const hasActualContent = await page.evaluate(() => {
            return document.body.innerText.length > 100 && 
                   !document.body.innerText.includes('Just a moment') &&
                   !document.body.innerText.includes('Checking your browser');
        });
        
        // Check for Cloudflare challenge indicators (current state) - be more specific
        const isCurrentlyBlocked = await page.evaluate(() => {
            const title = document.title.toLowerCase();
            const bodyText = document.body.innerText.toLowerCase();
            return title.includes('just a moment') || 
                   bodyText.includes('checking your browser') ||
                   bodyText.includes('please wait while we check your browser') ||
                   bodyText.includes('one moment please');
        });
        
        if (isCurrentlyBlocked) {
            console.log('❌ Cloudflare challenge still active - bypass may need improvement');
        } else if (hasActualContent) {
            console.log('✅ Successfully bypassed Cloudflare protection and loaded actual content');
        } else {
            console.log('⚠️  Page loaded but content may be limited');
        }
        
        // Get some page content to verify it's working
        const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 200));
        console.log(`Page content preview: ${bodyText}...`);
        
    } catch (error) {
        console.error('Test failed:', error.message);
    } finally {
        if (browser) {
            await closeBrowser(browser);
        }
    }
}

// Run the test
testCloudflareBypass();
