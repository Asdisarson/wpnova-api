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

// Create Browserless browser instance with Cloudflare bypass (standard method)
const createCloudflareBypassBrowser = async (useUnblockAPI = false) => {
    const userAgent = getRandomUserAgent();
    const viewport = getRandomViewport();
    
    console.log(`Using user agent: ${userAgent}`);
    console.log(`Using viewport: ${viewport.width}x${viewport.height}`);
    
    try {
        // Check if API token is available
        if (!process.env.BROWSERLESS_API_TOKEN) {
            throw new Error('BROWSERLESS_API_TOKEN not found in environment variables');
        }

        // If useUnblockAPI flag is set, use the Unblock API (last resort)
        if (useUnblockAPI) {
            console.log('🆘 Using Browserless Unblock API (last resort method)...');
            return await createUnblockAPIBrowser(userAgent, viewport);
        }

        // Standard Browserless WebSocket connection (default method)
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
        
        // Connect to the Browserless WebSocket endpoint with increased timeout
        const browser = await puppeteer.connect({
            browserWSEndpoint: response.data.browserWSEndpoint,
            defaultViewport: null,
            protocolTimeout: 180000 // 3 minutes timeout for protocol operations
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

// Function to get cookies from Browserless page with timeout handling
const getCookies = async (page, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            // Set a reasonable timeout for cookie operations
            const cookies = await Promise.race([
                page.cookies(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Cookie operation timeout')), 30000)
                )
            ]);
            return cookies;
        } catch (error) {
            console.warn(`Cookie retrieval attempt ${i + 1}/${retries} failed:`, error.message);
            if (i === retries - 1) {
                console.error('All cookie retrieval attempts failed:', error);
                return [];
            }
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    return [];
};

// Persistent cookie management for Browserless sessions
const COOKIE_FILE_PATH = path.join(__dirname, 'session_cookies.json');

// Save cookies to disk
const saveCookiesToDisk = async (cookies) => {
    try {
        // Only save valid cookies with required properties
        const validCookies = cookies.filter(cookie => 
            cookie.name && cookie.value && cookie.domain && 
            cookie.domain.includes('realgpl.com')
        );
        
        const cookieData = {
            timestamp: Date.now(),
            cookies: validCookies
        };
        
        await fs.promises.writeFile(COOKIE_FILE_PATH, JSON.stringify(cookieData, null, 2));
        console.log(`💾 Saved ${validCookies.length} cookies to disk`);
        return validCookies;
    } catch (error) {
        console.error('Failed to save cookies to disk:', error);
        return [];
    }
};

// Load cookies from disk
const loadCookiesFromDisk = async () => {
    try {
        if (!fs.existsSync(COOKIE_FILE_PATH)) {
            console.log('🍪 No saved cookies found');
            return [];
        }
        
        const cookieData = JSON.parse(await fs.promises.readFile(COOKIE_FILE_PATH, 'utf8'));
        const cookieAge = Date.now() - cookieData.timestamp;
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours
        
        if (cookieAge > maxAge) {
            console.log('🍪 Saved cookies are too old, ignoring');
            return [];
        }
        
        console.log(`🍪 Loaded ${cookieData.cookies.length} cookies from disk (age: ${Math.round(cookieAge / 1000 / 60)} mins)`);
        return cookieData.cookies;
    } catch (error) {
        console.error('Failed to load cookies from disk:', error);
        return [];
    }
};

// Apply cookies to page with better error handling and timeouts
const applyCookiesToPage = async (page, cookies, retries = 3) => {
    if (!cookies || cookies.length === 0) {
        console.log('🍪 No cookies to apply');
        return false;
    }
    
    for (let i = 0; i < retries; i++) {
        try {
            // Clear existing cookies first with timeout
            const currentCookies = await Promise.race([
                page.cookies(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Get cookies timeout')), 15000)
                )
            ]);
            
            if (currentCookies.length > 0) {
                await Promise.race([
                    page.deleteCookie(...currentCookies),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Delete cookies timeout')), 15000)
                    )
                ]);
            }
            
            // Apply saved cookies with timeout
            await Promise.race([
                page.setCookie(...cookies),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Set cookies timeout')), 15000)
                )
            ]);
            
            console.log(`✅ Applied ${cookies.length} cookies to page`);
            return true;
            
        } catch (error) {
            console.warn(`Cookie application attempt ${i + 1}/${retries} failed:`, error.message);
            if (i === retries - 1) {
                console.error('All cookie application attempts failed:', error.message);
                return false;
            }
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    
    return false;
};

// Create browser using Browserless Unblock API (last resort method)
const createUnblockAPIBrowser = async (userAgent, viewport) => {
    const axios = require('axios');
    const targetUrl = 'https://www.realgpl.com/changelog/';
    const token = process.env.BROWSERLESS_API_TOKEN;
    
    console.log('📍 Target URL for unblocking:', targetUrl);
    
    const unblockURL = 'https://production-sfo.browserless.io/chromium/unblock';
    
    const options = {
        url: targetUrl,
        browserWSEndpoint: true,  // Get endpoint for continued automation
        cookies: true,             // Get cookies
        ttl: 60000,               // Keep alive for 60 seconds
    };
    
    try {
        console.log('🔓 Calling Unblock API to bypass anti-bot protection...');
        const response = await axios.post(unblockURL, options, {
            params: { token },
            headers: { 'Content-Type': 'application/json' },
            timeout: 120000 // 2 minutes
        });
        
        if (!response.data.browserWSEndpoint) {
            throw new Error('No browserWSEndpoint in Unblock API response');
        }
        
        const browserWSEndpoint = response.data.browserWSEndpoint;
        console.log('✅ Unblock API successful! Got browser endpoint');
        console.log('📍 Reconnection endpoint:', browserWSEndpoint.substring(0, 50) + '...');
        
        // Connect to the pre-unblocked browser
        const browser = await puppeteer.connect({
            browserWSEndpoint: `${browserWSEndpoint}?token=${token}`,
            defaultViewport: null,
            protocolTimeout: 180000
        });
        
        console.log('🔗 Connected to unblocked browser');
        
        // Find the page that was already loaded by the Unblock API
        const pages = await browser.pages();
        let page = pages.find(p => p.url().includes('realgpl.com'));
        
        if (!page) {
            console.log('📄 Creating new page in unblocked browser...');
            page = await browser.newPage();
        } else {
            console.log('✅ Found pre-loaded page from Unblock API');
        }
        
        // Apply our custom settings
        await page.setViewport(viewport);
        await page.setUserAgent(userAgent);
        
        console.log('✅ Unblock API browser ready');
        
        return { browser, page };
        
    } catch (error) {
        console.error('❌ Unblock API failed:', error.message);
        throw new Error(`Unblock API failed: ${error.message}`);
    }
};

// Function to close Browserless browser
const closeBrowser = async (browser) => {
    try {
        await browser.close();
    } catch (error) {
        console.error('Failed to close browser:', error);
    }
};

// Session health management
let currentBrowserSession = null;
let sessionCreateTime = null;
const MAX_SESSION_AGE = 30 * 60 * 1000; // 30 minutes

// Check if current browser session is still healthy
const isSessionHealthy = async () => {
    if (!currentBrowserSession || !sessionCreateTime) {
        return false;
    }
    
    // Check session age
    const sessionAge = Date.now() - sessionCreateTime;
    if (sessionAge > MAX_SESSION_AGE) {
        console.log('🕒 Browser session too old, needs refresh');
        return false;
    }
    
    try {
        // Try to get browser version - if this fails, session is dead
        const browser = currentBrowserSession.browser;
        await browser.version();
        console.log(`✅ Browser session healthy (age: ${Math.round(sessionAge / 1000 / 60)} mins)`);
        return true;
    } catch (error) {
        console.log(`❌ Browser session unhealthy: ${error.message}`);
        currentBrowserSession = null;
        sessionCreateTime = null;
        return false;
    }
};

// Get or create a browser session with session reuse
const getBrowserSession = async () => {
    // Try to reuse existing session if healthy
    if (currentBrowserSession && await isSessionHealthy()) {
        console.log('♻️  Reusing existing browser session');
        return currentBrowserSession;
    }
    
    // Clean up old session
    if (currentBrowserSession) {
        try {
            await closeBrowser(currentBrowserSession.browser);
        } catch (error) {
            console.log('Session cleanup warning:', error.message);
        }
        currentBrowserSession = null;
    }
    
    // Create new session
    console.log('🆕 Creating new browser session...');
    const browserResult = await createCloudflareBypassBrowser();
    currentBrowserSession = browserResult;
    sessionCreateTime = Date.now();
    
    return browserResult;
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
    saveCookiesToDisk,
    loadCookiesFromDisk,
    applyCookiesToPage,
    getBrowserSession,
    isSessionHealthy
};