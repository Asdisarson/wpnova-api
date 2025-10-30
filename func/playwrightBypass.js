const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Enhanced user agent list with more recent versions
const getRandomUserAgent = () => {
    const userAgents = [
        // Chrome on Windows
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        
        // Chrome on macOS
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        
        // Firefox on Windows
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
        
        // Firefox on macOS
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
        
        // Safari on macOS
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
        
        // Edge on Windows
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
    ];
    
    return userAgents[Math.floor(Math.random() * userAgents.length)];
};

// Random viewport sizes
const getRandomViewport = () => {
    const viewports = [
        { width: 1920, height: 1080 },
        { width: 1366, height: 768 },
        { width: 1440, height: 900 },
        { width: 1536, height: 864 },
        { width: 1280, height: 720 },
        { width: 1600, height: 900 },
        { width: 2560, height: 1440 }
    ];
    
    return viewports[Math.floor(Math.random() * viewports.length)];
};

// Random delays to mimic human behavior
const randomDelay = (min = 1000, max = 3000) => {
    return Math.floor(Math.random() * (max - min + 1)) + min;
};

// Create Playwright browser instance
const createPlaywrightBrowser = async () => {
    const userAgent = getRandomUserAgent();
    const viewport = getRandomViewport();
    
    console.log(`🎭 Using Playwright with user agent: ${userAgent}`);
    console.log(`Using viewport: ${viewport.width}x${viewport.height}`);
    
    try {
        const browser = await chromium.launch({
            headless: false, // Show browser window
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=' + viewport.width + ',' + viewport.height,
            ]
        });

        const context = await browser.newContext({
            userAgent: userAgent,
            viewport: viewport,
            extraHTTPHeaders: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
            }
        });

        const page = await context.newPage();

        // Set timeouts
        page.setDefaultTimeout(30000);
        page.setDefaultNavigationTimeout(30000);

        return { browser, context, page };
    } catch (error) {
        console.error('Failed to create Playwright browser:', error.message);
        throw error;
    }
};

// Function to handle Cloudflare challenges
const handleCloudflareChallenge = async (page) => {
    try {
        // Wait for potential Cloudflare challenge
        await page.waitForSelector('body', { timeout: 10000 });
        
        // Check if we're on a Cloudflare challenge page
        const isCloudflareChallenge = await page.evaluate(() => {
            return document.title.includes('Just a moment') || 
                   document.body.innerHTML.includes('Checking your browser') ||
                   document.body.innerHTML.includes('cloudflare');
        });

        if (isCloudflareChallenge) {
            console.log('Cloudflare challenge detected, waiting for it to complete...');
            
            // Wait for the challenge to complete (usually 5-10 seconds)
            await page.waitForFunction(() => {
                return !document.title.includes('Just a moment') && 
                       !document.body.innerHTML.includes('Checking your browser');
            }, { timeout: 30000 });
            
            console.log('Cloudflare challenge completed');
        }
        
        return true;
    } catch (error) {
        console.log('No Cloudflare challenge detected or challenge handling failed:', error.message);
        return false;
    }
};

// Enhanced page navigation with retry logic
const navigateWithRetry = async (page, url, maxRetries = 3) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`Navigation attempt ${attempt} to: ${url}`);
            
            // Add random delay before navigation
            await new Promise(resolve => setTimeout(resolve, randomDelay(1000, 3000)));
            
            const response = await page.goto(url, { 
                // Playwright expects a single waitUntil value, not an array
                waitUntil: 'domcontentloaded',
                timeout: 60000 
            });
            
            // Handle Cloudflare challenge
            await handleCloudflareChallenge(page);
            
            // Additional wait to ensure page is fully loaded and JavaScript has executed
            console.log('Waiting for page to fully load...');
            await page.waitForFunction(() => {
                return document.readyState === 'complete';
            }, { timeout: 10000 }).catch(() => {});
            
            // Additional delay for any dynamic content
            await new Promise(resolve => setTimeout(resolve, randomDelay(2000, 4000)));
            
            // Check if we got a successful response
            if (response && response.status() < 400) {
                console.log(`Successfully navigated to ${url} and page is fully loaded`);
                return response;
            } else {
                throw new Error(`HTTP ${response ? response.status() : 'unknown'} error`);
            }
            
        } catch (error) {
            console.log(`Navigation attempt ${attempt} failed:`, error.message);
            
            if (attempt === maxRetries) {
                throw new Error(`Failed to navigate to ${url} after ${maxRetries} attempts: ${error.message}`);
            }
            
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, randomDelay(2000, 5000)));
        }
    }
};

// Function to wait for element to be ready before interaction
const waitForElementReady = async (page, selector, timeout = 30000) => {
    try {
        console.log(`Waiting for element: ${selector}`);
        
        // Wait for element to exist in DOM
        await page.waitForSelector(selector, { 
            state: 'visible',
            timeout: timeout 
        });
        
        // Additional wait to ensure element is interactive
        await page.waitForFunction(
            (sel) => {
                const element = document.querySelector(sel);
                if (!element) return false;
                
                // Check if element is visible and not disabled
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && 
                       style.visibility !== 'hidden' && 
                       style.opacity !== '0' &&
                       !element.disabled;
            },
            { timeout: 10000 },
            selector
        ).catch(() => {});
        
        // Small delay for stability
        await new Promise(resolve => setTimeout(resolve, randomDelay(500, 1000)));
        
        console.log(`Element ${selector} is ready for interaction`);
        return true;
    } catch (error) {
        console.log(`Element ${selector} not found or not ready: ${error.message}`);
        return false;
    }
};

// Global persistent browser session manager using Playwright
class PlaywrightBrowserSession {
    constructor() {
        this.browser = null;
        this.context = null;
        this.page = null;
        this.isLoggedIn = false;
        this.sessionStartTime = null;
    }

    // Create or reuse persistent browser session
    async getBrowser() {
        if (this.browser && !this.browser.isConnected()) {
            console.log('🔄 Browser disconnected, creating new session...');
            this.browser = null;
            this.context = null;
            this.page = null;
            this.isLoggedIn = false;
        }

        if (!this.browser) {
            await this.createPersistentBrowser();
        }

        return { browser: this.browser, context: this.context, page: this.page };
    }

    // Create persistent browser session
    async createPersistentBrowser() {
        console.log(`🚀 Creating persistent Playwright browser session`);

        try {
            const browserResult = await createPlaywrightBrowser();
            this.browser = browserResult.browser;
            this.context = browserResult.context;
            this.page = browserResult.page;
            this.sessionStartTime = new Date();

            console.log('✅ Persistent Playwright browser session created');
            return { browser: this.browser, context: this.context, page: this.page };

        } catch (error) {
            console.error('❌ Failed to create persistent Playwright browser:', error);
            throw error;
        }
    }

    // Perform login and maintain session
    async ensureLogin() {
        if (this.isLoggedIn && await this.verifyLogin()) {
            console.log('✅ Already logged in and session valid');
            return true;
        }

        console.log('🔐 Performing login with Playwright...');
        const username = process.env.USERNAME;
        const password = process.env.PASSWORD;

        if (!username || !password) {
            throw new Error('USERNAME and PASSWORD environment variables are required');
        }

        // Navigate to login page
        await navigateWithRetry(this.page, 'https://www.realgpl.com/my-account/');

        // Handle consent if present
        try {
            const consentExists = await waitForElementReady(this.page, '.fc-button-label', 5000);
            if (consentExists) {
                await this.page.click('.fc-button-label');
                await new Promise(resolve => setTimeout(resolve, 1000));
                console.log('✅ Consent block accepted');
            }
        } catch (error) {
            console.log('ℹ️ No consent block found');
        }

        // Wait for login form
        await waitForElementReady(this.page, '#username');
        await waitForElementReady(this.page, '#password');

        console.log('📝 Entering credentials...');
        await this.page.fill('#username', username.toString());
        await new Promise(resolve => setTimeout(resolve, randomDelay(500, 1000)));
        await this.page.fill('#password', password.toString());
        await new Promise(resolve => setTimeout(resolve, randomDelay(500, 1000)));

        // Submit login
        await waitForElementReady(this.page, '.button.woocommerce-button.woocommerce-form-login__submit');
        await this.page.click('.button.woocommerce-button.woocommerce-form-login__submit');

        // Wait for login success
        try {
            await Promise.race([
                this.page.waitForNavigation({ timeout: 60000, waitUntil: 'domcontentloaded' }),
                this.page.waitForSelector('.woocommerce-MyAccount-navigation', { timeout: 60000 }),
                this.page.waitForSelector('.woocommerce-account', { timeout: 60000 })
            ]);
            console.log('✅ Successfully logged in');
        } catch (error) {
            console.log('⚠️ Login wait timed out, performing final verification...');
            await new Promise(resolve => setTimeout(resolve, randomDelay(2000, 3000)));

            const loginStatus = await this.page.evaluate(() => {
                const hasAccountNav = document.querySelector('.woocommerce-MyAccount-navigation') !== null;
                const hasAccountContent = document.querySelector('.woocommerce-account') !== null;
                const noLoginForm = document.querySelector('#username') === null;
                const hasLogoutLink = document.querySelector('a[href*="customer-logout"]') !== null;
                const currentUrl = window.location.href;

                return {
                    hasAccountNav,
                    hasAccountContent,
                    noLoginForm,
                    hasLogoutLink,
                    currentUrl,
                    isLoggedIn: hasAccountNav || hasAccountContent || (noLoginForm && hasLogoutLink)
                };
            });

            if (!loginStatus.isLoggedIn) {
                throw new Error(`Login verification failed: ${error.message}`);
            }

            console.log('✅ Login verified successfully (URL: ' + loginStatus.currentUrl + ')');
        }

        this.isLoggedIn = true;
        return true;
    }

    // Verify if still logged in
    async verifyLogin() {
        if (!this.page || !this.isLoggedIn) {
            return false;
        }

        try {
            const loginStatus = await this.page.evaluate(() => {
                const hasLoginForm = document.querySelector('form.login, form.woocommerce-form-login, #username') !== null;
                const hasLogoutLink = document.querySelector('a[href*="customer-logout"]') !== null;
                const hasAccountMenu = document.querySelector('.account-menu, .my-account-menu, .user-menu') !== null;

                if (hasLoginForm && !hasLogoutLink) return { isLoggedIn: false, reason: 'Login form present' };
                if (hasLogoutLink || hasAccountMenu) return { isLoggedIn: true, reason: 'Found logged-in indicators' };

                return { isLoggedIn: true, reason: 'No clear indicators, assuming logged in' };
            });

            return loginStatus.isLoggedIn;
        } catch (error) {
            console.log(`Login verification error: ${error.message}`);
            return false;
        }
    }

    // Navigate with session preservation
    async navigateWithSession(url) {
        console.log(`🧭 Navigating to: ${url}`);

        // Ensure we're logged in before navigation
        if (!await this.verifyLogin()) {
            console.log('🔄 Session expired, re-authenticating...');
            await this.ensureLogin();
        }

        await navigateWithRetry(this.page, url);
        return true;
    }

    // Close persistent browser session
    async close() {
        if (this.browser) {
            try {
                await this.browser.close();
                console.log('🔒 Persistent Playwright browser session closed');
            } catch (error) {
                console.error('Failed to close persistent Playwright browser:', error);
            }
        }
        this.browser = null;
        this.context = null;
        this.page = null;
        this.isLoggedIn = false;
    }
}

// Global persistent session instance
const playwrightSession = new PlaywrightBrowserSession();

// Function to close Playwright browser (legacy compatibility)
const closeBrowser = async (browser) => {
    try {
        await browser.close();
    } catch (error) {
        console.error('Failed to close Playwright browser:', error);
    }
};

module.exports = {
    createPlaywrightBrowser,
    navigateWithRetry,
    handleCloudflareChallenge,
    waitForElementReady,
    closeBrowser,
    randomDelay,
    getRandomUserAgent,
    getRandomViewport,
    PlaywrightBrowserSession,
    playwrightSession
};



