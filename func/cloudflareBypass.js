const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

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

// Create regular Puppeteer browser (no Browserless)
const createRegularBrowser = async () => {
    const userAgent = getRandomUserAgent();
    const viewport = getRandomViewport();
    
    console.log(`Using user agent: ${userAgent}`);
    console.log(`Using viewport: ${viewport.width}x${viewport.height}`);
    
    try {
        // Try to launch local/regular browser (no Browserless)
        const browser = await puppeteer.launch({
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=' + viewport.width + ',' + viewport.height,
            ]
        });

        const page = await browser.newPage();
        
        // Set viewport
        await page.setViewport(viewport);
        
        // Set user agent
        await page.setUserAgent(userAgent);
        
        // Set additional headers
        await page.setExtraHTTPHeaders({
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
        });

        // Override navigator properties
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });
        });

        // Set timeouts
        page.setDefaultTimeout(30000);
        page.setDefaultNavigationTimeout(30000);

        return { browser, page };
    } catch (error) {
        console.error('Failed to create regular browser:', error.message);
        throw error;
    }
};

// Create Browserless browser instance with Cloudflare bypass
const createCloudflareBypassBrowser = async () => {
    const userAgent = getRandomUserAgent();
    const viewport = getRandomViewport();
    
    console.log(`Using user agent: ${userAgent}`);
    console.log(`Using viewport: ${viewport.width}x${viewport.height}`);
    
    try {
        // Check if API token is available
        if (!process.env.BROWSERLESS_API_TOKEN) {
            throw new Error('BROWSERLESS_API_TOKEN not found in environment variables');
        }

        // Retry logic for Browserless API calls
        let response;
        let retries = 5; // Increased from 3 to 5
        
        while (retries > 0) {
            try {
                console.log(`Attempting to get Browserless WebSocket endpoint (${6 - retries}/5)...`);
                
                // Use Browserless cloud service to get a WebSocket endpoint
                const browserlessUrl = 'https://production-sfo.browserless.io/unblock';
                response = await axios.post(browserlessUrl, {
                    url: 'https://httpbin.org/headers', // Initial URL to test
                    browserWSEndpoint: true
                }, {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    params: {
                        token: process.env.BROWSERLESS_API_TOKEN
                    },
                    timeout: 90000 // Increased to 90 seconds
                });

                if (response.data.browserWSEndpoint) {
                    console.log('✅ Successfully obtained Browserless WebSocket endpoint');
                    break; // Success, exit retry loop
                } else {
                    throw new Error('No browserWSEndpoint in response');
                }
            } catch (error) {
                retries--;
                if (retries === 0) {
                    console.error(`❌ Failed to get Browserless endpoint after all retries: ${error.message}`);
                    throw error;
                }
                const waitTime = retries > 2 ? 5000 : 10000; // Wait longer after first 2 failures
                console.log(`⚠️  Browserless API call failed: ${error.message}`);
                console.log(`Retrying in ${waitTime/1000} seconds... (${retries} retries left)`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }

        if (!response.data.browserWSEndpoint) {
            throw new Error('Failed to get browser WebSocket endpoint from Browserless');
        }

        console.log('Connecting to Browserless WebSocket endpoint...');
        
        // Connect to the Browserless WebSocket endpoint
        const browser = await puppeteer.connect({
            browserWSEndpoint: response.data.browserWSEndpoint,
            defaultViewport: null
        });

        const page = await browser.newPage();
        
        // Set viewport
        await page.setViewport(viewport);
        
        // Set user agent
        await page.setUserAgent(userAgent);
        
        // Set additional headers to look more like a real browser
        await page.setExtraHTTPHeaders({
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Cache-Control': 'max-age=0'
        });

        // Override navigator properties to avoid detection
        await page.evaluateOnNewDocument(() => {
            // Remove webdriver property
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });

            // Mock plugins
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
            });

            // Mock languages
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en'],
            });

            // Mock permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
            );

            // Mock chrome object
            window.chrome = {
                runtime: {},
                loadTimes: function() {},
                csi: function() {},
                app: {}
            };

            // Override the `plugins` property to use a custom getter
            Object.defineProperty(navigator, 'plugins', {
                get: function() {
                    return [1, 2, 3, 4, 5];
                },
            });

            // Override the `languages` property to use a custom getter
            Object.defineProperty(navigator, 'languages', {
                get: function() {
                    return ['en-US', 'en'];
                },
            });

            // Override the `permissions` property to use a custom getter
            Object.defineProperty(navigator, 'permissions', {
                get: function() {
                    return {
                        query: function() {
                            return Promise.resolve({ state: 'granted' });
                        }
                    };
                },
            });
        });

        // Set a realistic timeout
        page.setDefaultTimeout(30000);
        page.setDefaultNavigationTimeout(30000);

        return { browser, page };
    } catch (error) {
        console.error('Failed to create Browserless browser:', error);
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
                waitUntil: ['load', 'domcontentloaded', 'networkidle0'],
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
            visible: true,
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

// Function to add human-like mouse movements
const addHumanLikeBehavior = async (page) => {
    await page.evaluateOnNewDocument(() => {
        // Add random mouse movements
        let mouseX = 0;
        let mouseY = 0;
        
        document.addEventListener('mousemove', (e) => {
            mouseX = e.clientX;
            mouseY = e.clientY;
        });
        
        // Simulate random mouse movements
        setInterval(() => {
            if (Math.random() < 0.1) { // 10% chance every interval
                const event = new MouseEvent('mousemove', {
                    clientX: mouseX + (Math.random() - 0.5) * 10,
                    clientY: mouseY + (Math.random() - 0.5) * 10
                });
                document.dispatchEvent(event);
            }
        }, 1000);
    });
};

// Function to get cookies from Browserless page
const getCookies = async (page) => {
    try {
        return await page.cookies();
    } catch (error) {
        console.error('Failed to get cookies:', error);
        return [];
    }
};

// Global persistent browser session manager
class PersistentBrowserSession {
    constructor() {
        this.browser = null;
        this.page = null;
        this.isLoggedIn = false;
        this.loginCookies = [];
        this.sessionStartTime = null;
    }

    // Create or reuse persistent browser session
    async getBrowser() {
        if (this.browser && !this.browser.isConnected()) {
            console.log('🔄 Browser disconnected, creating new session...');
            this.browser = null;
            this.page = null;
            this.isLoggedIn = false;
        }

        if (!this.browser) {
            await this.createPersistentBrowser();
        }

        return { browser: this.browser, page: this.page };
    }

    // Create persistent browser session
    async createPersistentBrowser() {
        const userAgent = getRandomUserAgent();
        const viewport = getRandomViewport();

        console.log(`🚀 Creating persistent browser session`);
        console.log(`Using user agent: ${userAgent}`);
        console.log(`Using viewport: ${viewport.width}x${viewport.height}`);

        try {
            // Try regular browser first, fallback to Browserless if needed
            let browserResult;

            try {
                console.log('🔍 Attempting regular Puppeteer browser...');
                browserResult = await createRegularBrowser();
                console.log('✅ Regular browser created successfully');
            } catch (regularError) {
                console.log(`❌ Regular browser failed: ${regularError.message}`);
                console.log('🔄 Falling back to Browserless...');
                browserResult = await createCloudflareBypassBrowser();
            }

            this.browser = browserResult.browser;
            this.page = browserResult.page;
            this.sessionStartTime = new Date();

            // Add human-like behavior
            await addHumanLikeBehavior(this.page);

            console.log('✅ Persistent browser session created');
            return { browser: this.browser, page: this.page };

        } catch (error) {
            console.error('❌ Failed to create persistent browser:', error);
            throw error;
        }
    }

    // Perform login and maintain session
    async ensureLogin() {
        if (this.isLoggedIn && await this.verifyLogin()) {
            console.log('✅ Already logged in and session valid');
            return true;
        }

        console.log('🔐 Performing login...');
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
        await this.page.type('#username', username.toString());
        await new Promise(resolve => setTimeout(resolve, randomDelay(500, 1000)));
        await this.page.type('#password', password.toString());
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

        // Save login cookies
        this.loginCookies = await this.page.cookies('https://www.realgpl.com/');
        this.isLoggedIn = true;
        console.log(`💾 Saved ${this.loginCookies.length} session cookies`);

        return true;
    }

    // Verify if still logged in
    async verifyLogin() {
        if (!this.page || !this.isLoggedIn) {
            return false;
        }

        try {
            const hasWpLoginCookie = (await this.page.cookies('https://www.realgpl.com/'))
                .some(c => c.name && c.name.startsWith('wordpress_logged_in'));

            const loginStatus = await this.page.evaluate((hasCookie) => {
                const hasLoginForm = document.querySelector('form.login, form.woocommerce-form-login, #username') !== null;
                const hasLogoutLink = document.querySelector('a[href*="customer-logout"]') !== null;
                const hasAccountMenu = document.querySelector('.account-menu, .my-account-menu, .user-menu') !== null;

                if (hasCookie) return { isLoggedIn: true, reason: 'WordPress cookie present' };
                if (hasLoginForm && !hasLogoutLink) return { isLoggedIn: false, reason: 'Login form present' };
                if (hasLogoutLink || hasAccountMenu) return { isLoggedIn: true, reason: 'Found logged-in indicators' };

                return { isLoggedIn: true, reason: 'No clear indicators, assuming logged in' };
            }, hasWpLoginCookie);

            return loginStatus.isLoggedIn;
        } catch (error) {
            console.log(`Login verification error: ${error.message}`);
            return false;
        }
    }

    // Restore session cookies
    async restoreSession() {
        if (this.loginCookies.length === 0) {
            console.log('⚠️ No saved cookies to restore');
            return false;
        }

        try {
            const validCookies = this.loginCookies.filter(cookie =>
                cookie.domain && cookie.domain.includes('realgpl.com')
            );

            if (validCookies.length > 0) {
                console.log(`🔄 Restoring ${validCookies.length} session cookies`);
                await this.page.setCookie(...validCookies);
                this.isLoggedIn = await this.verifyLogin();
                return this.isLoggedIn;
            } else {
                console.log('⚠️ No valid cookies to restore');
                return false;
            }
        } catch (error) {
            console.log(`Cookie restoration error: ${error.message}`);
            return false;
        }
    }

    // Navigate with session preservation
    async navigateWithSession(url) {
        console.log(`🧭 Navigating to: ${url}`);

        // Ensure we're logged in before navigation
        if (!await this.verifyLogin()) {
            console.log('🔄 Session expired, restoring login...');
            if (!await this.restoreSession()) {
                await this.ensureLogin();
            }
        }

        await navigateWithRetry(this.page, url);
        return true;
    }

    // Close persistent browser session
    async close() {
        if (this.browser) {
            try {
                await this.browser.close();
                console.log('🔒 Persistent browser session closed');
            } catch (error) {
                console.error('Failed to close persistent browser:', error);
            }
        }
        this.browser = null;
        this.page = null;
        this.isLoggedIn = false;
        this.loginCookies = [];
    }
}

// Global persistent session instance
const persistentSession = new PersistentBrowserSession();

// Function to close Browserless browser (legacy compatibility)
const closeBrowser = async (browser) => {
    try {
        await browser.close();
    } catch (error) {
        console.error('Failed to close browser:', error);
    }
};

module.exports = {
    createRegularBrowser,
    createCloudflareBypassBrowser,
    navigateWithRetry,
    handleCloudflareChallenge,
    addHumanLikeBehavior,
    waitForElementReady,
    getCookies,
    closeBrowser,
    randomDelay,
    getRandomUserAgent,
    getRandomViewport,
    PersistentBrowserSession,
    persistentSession
};