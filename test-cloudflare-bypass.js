const { 
    createCloudflareBypassBrowser, 
    navigateWithRetry, 
    handleCloudflareChallenge, 
    addHumanLikeBehavior, 
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
        
        // Check for Cloudflare challenge indicators
        const isCloudflareChallenge = await page.evaluate(() => {
            return document.title.includes('Just a moment') || 
                   document.body.innerHTML.includes('Checking your browser') ||
                   document.body.innerHTML.includes('cloudflare');
        });
        
        if (isCloudflareChallenge) {
            console.log('❌ Cloudflare challenge detected - bypass may need improvement');
        } else {
            console.log('✅ Successfully bypassed Cloudflare protection');
        }
        
        // Get some page content to verify it's working
        const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 200));
        console.log(`Page content preview: ${bodyText}...`);
        
    } catch (error) {
        console.error('Test failed:', error.message);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

// Run the test
testCloudflareBypass();
