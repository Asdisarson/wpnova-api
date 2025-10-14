// Test script for persistent browser session
const { persistentSession } = require('./func/cloudflareBypass');

async function testPersistentSession() {
    try {
        console.log('🧪 Testing persistent browser session...');

        // Test getting browser session
        console.log('📱 Getting browser session...');
        const { browser, page } = await persistentSession.getBrowser();
        console.log('✅ Browser session obtained');

        // Test login functionality (without actually logging in)
        console.log('🔐 Testing login verification...');
        const isLoggedIn = await persistentSession.verifyLogin();
        console.log(`Login status: ${isLoggedIn ? '✅ Logged in' : '❌ Not logged in'}`);

        // Test navigation (to a safe test URL)
        console.log('🧭 Testing navigation...');
        try {
            await persistentSession.navigateWithSession('https://httpbin.org/headers');
            console.log('✅ Navigation successful');
        } catch (error) {
            console.log(`⚠️ Navigation test failed (expected if no internet): ${error.message}`);
        }

        // Test session state
        console.log('📊 Session state:');
        console.log(`- Browser connected: ${browser.isConnected()}`);
        console.log(`- Login status: ${persistentSession.isLoggedIn}`);
        console.log(`- Cookies count: ${persistentSession.loginCookies.length}`);

        // Close session
        console.log('🔒 Closing session...');
        await persistentSession.close();
        console.log('✅ Session closed');

        console.log('🎉 Persistent session test completed successfully!');

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error(error.stack);

        // Ensure cleanup on error
        try {
            await persistentSession.close();
        } catch (closeError) {
            console.error('Error during cleanup:', closeError.message);
        }

        process.exit(1);
    }
}

// Run test if called directly
if (require.main === module) {
    testPersistentSession()
        .then(() => process.exit(0))
        .catch((error) => {
            console.error('Unhandled error:', error);
            process.exit(1);
        });
}

module.exports = testPersistentSession;
