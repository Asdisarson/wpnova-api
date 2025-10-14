// Browserless session manager for maintaining login state across requests
const puppeteer = require('puppeteer-core');
const { createCloudflareBypassBrowser, createRegularBrowser } = require('./cloudflareBypass');

// Session storage
let currentSession = {
    browserWSEndpoint: null,
    browser: null,
    page: null,
    createdAt: null,
    lastUsedAt: null,
    isLoggedIn: false,
    usedBrowserless: false
};

// Session configuration based on Browserless plan
const SESSION_CONFIG = {
    // Reconnection timeout - how long browser stays alive after disconnect
    // Free: 10s, Starter: 60s, Scale: 300s
    reconnectTimeout: parseInt(process.env.BROWSERLESS_RECONNECT_TIMEOUT || '60000'), // 1 minute default
    
    // Session max age - recreate session after this time
    maxSessionAge: parseInt(process.env.SESSION_MAX_AGE || '1800000'), // 30 minutes default
    
    // Session idle timeout - close session after this time of inactivity
    idleTimeout: parseInt(process.env.SESSION_IDLE_TIMEOUT || '300000') // 5 minutes default
};

// Session timeout handler
let sessionIdleTimer = null;

/**
 * Attempt to reconnect to an existing Browserless session
 * @returns {Promise<boolean>}
 */
async function reconnectBrowserSession() {
    if (!currentSession.browserWSEndpoint) {
        return false;
    }

    try {
        console.log('🔄 Attempting to reconnect to existing Browserless session...');
        const browser = await puppeteer.connect({
            browserWSEndpoint: currentSession.browserWSEndpoint,
            defaultViewport: null,
            protocolTimeout: 180000
        });

        currentSession.browser = browser;

        // Try to reuse an existing page, otherwise create a new one
        let page = null;
        try {
            const pages = await browser.pages();
            page = pages.length ? pages[0] : await browser.newPage();
        } catch (pageError) {
            console.log(`⚠️  Page restoration warning: ${pageError.message}`);
            page = await browser.newPage();
        }

        currentSession.page = page;
        currentSession.lastUsedAt = Date.now();
        console.log('✅ Reconnected to Browserless session successfully');
        return true;
    } catch (error) {
        console.log(`⚠️  Browserless reconnection failed: ${error.message}`);
        currentSession.browserWSEndpoint = null;
        currentSession.browser = null;
        currentSession.page = null;
        currentSession.isLoggedIn = false;
        return false;
    }
}

/**
 * Check if current session is still valid and usable
 */
async function isSessionValid() {
    if (!currentSession.browser && currentSession.browserWSEndpoint) {
        const reconnected = await reconnectBrowserSession();
        if (!reconnected) {
            return false;
        }
    }

    if (!currentSession.browser) {
        return false;
    }

    
    // Check if session is too old
    const sessionAge = Date.now() - currentSession.createdAt;
    if (sessionAge > SESSION_CONFIG.maxSessionAge) {
        console.log(`⏰ Session expired (age: ${Math.round(sessionAge / 1000 / 60)} mins, max: ${Math.round(SESSION_CONFIG.maxSessionAge / 1000 / 60)} mins)`);
        return false;
    }
    
    // Try to verify browser is still alive
    try {
        await currentSession.browser.version();
        return true;
    } catch (error) {
        console.log(`❌ Session validation failed: ${error.message}`);
        return false;
    }
}

/**
 * Reset the idle timeout timer
 */
function resetIdleTimer() {
    // Clear existing timer
    if (sessionIdleTimer) {
        clearTimeout(sessionIdleTimer);
    }
    
    // Set new timer to close session after idle period
    sessionIdleTimer = setTimeout(async () => {
        console.log('💤 Session idle timeout reached, closing session...');
        await closeSession();
    }, SESSION_CONFIG.idleTimeout);
}

/**
 * Get or create a browser session
 * @param {boolean} forceNew - Force creation of new session
 * @returns {Promise<{browser, page, isNewSession, usedBrowserless}>}
 */
async function getOrCreateSession(forceNew = false) {
    // Update last used timestamp
    currentSession.lastUsedAt = Date.now();
    resetIdleTimer();
    
    // Try to reconnect to existing session if available and not forcing new
    if (!forceNew && await isSessionValid()) {
        console.log('♻️  Reusing existing browser session');
        
        try {
            // Get existing page or create new one
            const pages = await currentSession.browser.pages();
            let page = pages.find(p => p.url().includes('realgpl.com'));
            
            if (!page) {
                page = await currentSession.browser.newPage();
                console.log('📄 Created new page in existing session');
            }
            
            return {
                browser: currentSession.browser,
                page: page,
                isNewSession: false,
                usedBrowserless: currentSession.usedBrowserless,
                isLoggedIn: currentSession.isLoggedIn
            };
        } catch (error) {
            console.log(`⚠️  Failed to reuse session: ${error.message}`);
            // Fall through to create new session
        }
    }
    
    // Create new session with progressive fallback
    console.log('🆕 Creating new browser session...');
    
    let browserResult;
    let usedBrowserless = false;
    let usedUnblockAPI = false;
    
    try {
        console.log('🚀 Attempting with regular Puppeteer browser (no Browserless)...');
        browserResult = await createRegularBrowser();
        const browser = browserResult.browser;
        const page = browserResult.page;
        
        // Test if we can access the site (check for Cloudflare)
        console.log('Testing website access...');
        await page.goto('https://www.realgpl.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
        
        // Check for Cloudflare challenge
        const hasCloudflare = await page.evaluate(() => {
            return document.title.includes('Just a moment') || 
                   document.body.innerHTML.includes('Checking your browser') ||
                   document.body.innerHTML.includes('cloudflare');
        });
        
        if (hasCloudflare) {
            console.log('⚠️  Cloudflare detected with regular browser, switching to Browserless...');
            await browser.close();
            throw new Error('Cloudflare challenge detected');
        }
        
        console.log('✅ Regular browser works! Proceeding without Browserless...');
        
    } catch (error) {
        console.log(`❌ Regular browser failed: ${error.message}`);
        console.log('🔄 Falling back to Browserless with standard WebSocket...');
        
        try {
            // Try standard Browserless WebSocket connection first
            browserResult = await createCloudflareBypassBrowser(false); // false = don't use Unblock API yet
            usedBrowserless = true;
            console.log('✅ Standard Browserless WebSocket connected');
            
        } catch (browserlessError) {
            console.log(`❌ Standard Browserless failed: ${browserlessError.message}`);
            console.log('🆘 Falling back to Browserless Unblock API (last resort)...');
            
            try {
                // Last resort: Use Unblock API
                browserResult = await createCloudflareBypassBrowser(true); // true = use Unblock API
                usedBrowserless = true;
                usedUnblockAPI = true;
                console.log('✅ Unblock API succeeded!');
                
            } catch (unblockError) {
                console.error(`❌ All browser creation methods failed!`);
                console.error(`Regular: ${error.message}`);
                console.error(`Browserless: ${browserlessError.message}`);
                console.error(`Unblock API: ${unblockError.message}`);
                throw new Error('All browser creation methods exhausted');
            }
        }
    }
    
    const browser = browserResult.browser;
    const page = browserResult.page;
    
    // Enable session reconnection if using Browserless
    let browserWSEndpoint = null;
    if (usedBrowserless) {
        try {
            console.log('🔗 Enabling session reconnection...');
            const cdp = await page.createCDPSession();
            const result = await cdp.send('Browserless.reconnect', {
                timeout: SESSION_CONFIG.reconnectTimeout
            });
            
            if (result.error) {
                console.log(`⚠️  Session reconnection setup failed: ${result.error}`);
            } else {
                browserWSEndpoint = result.browserWSEndpoint;
                console.log(`✅ Session reconnection enabled (timeout: ${SESSION_CONFIG.reconnectTimeout / 1000}s)`);
                console.log(`📍 Reconnection endpoint: ${browserWSEndpoint.substring(0, 50)}...`);
            }
        } catch (error) {
            console.log(`⚠️  Could not enable session reconnection: ${error.message}`);
        }
    }
    
    // Store session info
    currentSession = {
        browserWSEndpoint,
        browser,
        page,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        isLoggedIn: false,
        usedBrowserless
    };
    
    return {
        browser,
        page,
        isNewSession: true,
        usedBrowserless,
        usedUnblockAPI,
        isLoggedIn: false
    };
}

/**
 * Mark the current session as logged in
 */
function markSessionAsLoggedIn() {
    currentSession.isLoggedIn = true;
    console.log('✅ Session marked as logged in');
}

/**
 * Disconnect from session but keep it alive for reconnection
 */
async function disconnectSession() {
    if (!currentSession.browser) {
        return;
    }
    
    try {
        if (currentSession.usedBrowserless && currentSession.browserWSEndpoint) {
            console.log('🔌 Disconnecting from session (keeping alive for reconnection)...');
            await currentSession.browser.disconnect();
            console.log(`⏱️  Session will remain alive for ${SESSION_CONFIG.reconnectTimeout / 1000}s`);
            
            // Keep session metadata but remove browser reference
            currentSession.browser = null;
            currentSession.page = null;
        } else {
            // Regular browser - close it
            console.log('🔌 Closing regular browser session...');
            await currentSession.browser.close();
            currentSession = {
                browserWSEndpoint: null,
                browser: null,
                page: null,
                createdAt: null,
                lastUsedAt: null,
                isLoggedIn: false,
                usedBrowserless: false
            };
        }
    } catch (error) {
        console.log(`⚠️  Disconnect warning: ${error.message}`);
    }
}

/**
 * Close and cleanup the current session completely
 */
async function closeSession() {
    if (sessionIdleTimer) {
        clearTimeout(sessionIdleTimer);
        sessionIdleTimer = null;
    }
    
    if (!currentSession.browser) {
        // Reset session data
        currentSession = {
            browserWSEndpoint: null,
            browser: null,
            page: null,
            createdAt: null,
            lastUsedAt: null,
            isLoggedIn: false,
            usedBrowserless: false
        };
        return;
    }
    
    try {
        console.log('🔒 Closing browser session completely...');
        
        // Clear cookies and storage before closing
        try {
            const pages = await currentSession.browser.pages();
            for (const page of pages) {
                try {
                    await page.evaluate(() => {
                        localStorage.clear();
                        sessionStorage.clear();
                    });
                    
                    const cookies = await page.cookies();
                    if (cookies.length > 0) {
                        await page.deleteCookie(...cookies);
                    }
                } catch (err) {
                    // Ignore errors during cleanup
                }
            }
        } catch (err) {
            console.log('⚠️  Cookie cleanup warning:', err.message);
        }
        
        await currentSession.browser.close();
        console.log('✅ Session closed successfully');
    } catch (error) {
        console.log(`⚠️  Close warning: ${error.message}`);
    }
    
    // Reset session data
    currentSession = {
        browserWSEndpoint: null,
        browser: null,
        page: null,
        createdAt: null,
        lastUsedAt: null,
        isLoggedIn: false,
        usedBrowserless: false
    };
}

/**
 * Get current session info
 */
function getSessionInfo() {
    return {
        active: currentSession.browser !== null,
        isLoggedIn: currentSession.isLoggedIn,
        usedBrowserless: currentSession.usedBrowserless,
        age: currentSession.createdAt ? Date.now() - currentSession.createdAt : 0,
        idleSince: currentSession.lastUsedAt ? Date.now() - currentSession.lastUsedAt : 0
    };
}

module.exports = {
    getOrCreateSession,
    markSessionAsLoggedIn,
    disconnectSession,
    closeSession,
    getSessionInfo,
    SESSION_CONFIG
};
