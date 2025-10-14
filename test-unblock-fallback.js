#!/usr/bin/env node

/**
 * Test script to demonstrate the browser creation fallback hierarchy:
 * 1. Regular Puppeteer (fastest, cheapest)
 * 2. Browserless WebSocket (when Cloudflare blocks regular browser)
 * 3. Browserless Unblock API (last resort when all else fails)
 */

const { getOrCreateSession, closeSession } = require('./func/sessionManager');

async function testBrowserFallback() {
    console.log('🧪 Testing browser creation fallback hierarchy...\n');
    
    try {
        const session = await getOrCreateSession();
        
        console.log('\n📊 Session Details:');
        console.log(`- New Session: ${session.isNewSession}`);
        console.log(`- Used Browserless: ${session.usedBrowserless}`);
        console.log(`- Used Unblock API: ${session.usedUnblockAPI || false}`);
        console.log(`- Already Logged In: ${session.isLoggedIn}`);
        
        if (session.usedUnblockAPI) {
            console.log('\n🆘 Unblock API was used - this indicates:');
            console.log('   - Regular Puppeteer failed (likely Cloudflare)');
            console.log('   - Standard Browserless WebSocket also failed');
            console.log('   - Unblock API succeeded as last resort');
        } else if (session.usedBrowserless) {
            console.log('\n🔄 Browserless WebSocket was used - this indicates:');
            console.log('   - Regular Puppeteer failed (likely Cloudflare)');
            console.log('   - Standard Browserless WebSocket succeeded');
        } else {
            console.log('\n✅ Regular Puppeteer was used - this indicates:');
            console.log('   - No Cloudflare protection detected');
            console.log('   - Fastest and most cost-effective method');
        }
        
        // Test basic page functionality
        console.log('\n🔍 Testing page functionality...');
        await session.page.goto('https://www.realgpl.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
        const title = await session.page.title();
        console.log(`✅ Page loaded successfully: "${title}"`);
        
    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
    } finally {
        console.log('\n🧹 Cleaning up...');
        await closeSession();
        console.log('✅ Test completed');
    }
}

// Run the test
testBrowserFallback().catch(console.error);
