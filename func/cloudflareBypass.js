const puppeteer = require('puppeteer');
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

// Resolve a viable Chrome/Chromium executable path
const resolveExecutablePath = () => {
    const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (envPath && fs.existsSync(envPath)) return envPath;
    const linuxPath = '/usr/bin/google-chrome-stable';
    if (process.platform !== 'darwin' && fs.existsSync(linuxPath)) return linuxPath;
    // On platforms where a system Chrome isn't present, let Puppeteer use its bundled Chromium
    return null;
};

// Create regular Puppeteer browser (no Browserless)
const createRegularBrowser = async () => {
    const userAgent = getRandomUserAgent();
    const viewport = getRandomViewport();
    
    console.log(`Using user agent: ${userAgent}`);
    console.log(`Using viewport: ${viewport.width}x${viewport.height}`);
    
    try {
        // Try to launch local/regular browser (no Browserless)
        const execPath = resolveExecutablePath();
        // Default to headless in server/containers; allow override with PUPPETEER_HEADLESS=false for local debugging
        const headlessSetting = (process.env.PUPPETEER_HEADLESS === 'false') ? false : 'new';
        const launchOptions = {
            headless: headlessSetting,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--no-zygote',
                '--single-process',
                '--window-size=' + viewport.width + ',' + viewport.height,
            ]
        };
        if (execPath) launchOptions.executablePath = execPath;
        const browser = await puppeteer.launch(launchOptions);

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
            'Connection': 'keep-alive'
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
            
            // Cloudflare handling disabled per requirement to avoid Cloudflare-specific flows
            
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

// Human-like typing into an input selector
const typeLikeHuman = async (page, selector, text) => {
    await waitForElementReady(page, selector);
    try {
        // Move mouse toward the element and click to focus
        const element = await page.$(selector);
        if (element) {
            const box = await element.boundingBox();
            if (box) {
                const startX = Math.random() * box.width + box.x;
                const startY = Math.random() * box.height + box.y;
                await page.mouse.move(startX, startY, { steps: 12 + Math.floor(Math.random() * 8) });
            }
            await element.click({ delay: 30 });
        }
    } catch (_) {}

    // Clear existing value using DOM for reliability
    try {
        await page.$eval(selector, (el) => { el.focus(); el.value = ''; });
    } catch (_) {}

    // Type one character at a time with random delays and occasional pauses/corrections
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        await page.type(selector, ch, { delay: 40 + Math.floor(Math.random() * 90) });
        if (Math.random() < 0.12) {
            await new Promise(r => setTimeout(r, 150 + Math.floor(Math.random() * 250)));
        }
        if (Math.random() < 0.06) {
            // Simulate a minor correction
            await page.keyboard.press('Backspace');
            await new Promise(r => setTimeout(r, 80 + Math.floor(Math.random() * 140)));
            await page.type(selector, ch, { delay: 40 + Math.floor(Math.random() * 90) });
        }
    }

    // Brief pause and blur
    await new Promise(r => setTimeout(r, 150 + Math.floor(Math.random() * 250)));
    try { await page.$eval(selector, (el) => el.blur && el.blur()); } catch (_) {}
};

// Human-like hover then click
const hoverAndClickHuman = async (page, selector) => {
    await waitForElementReady(page, selector);
    try {
        const el = await page.$(selector);
        if (el) {
            await page.$eval(selector, (btn) => btn.scrollIntoView({ behavior: 'instant', block: 'center' }));
            const box = await el.boundingBox();
            if (box) {
                const hoverX = box.x + Math.min(box.width - 2, 4 + Math.random() * Math.max(6, box.width / 3));
                const hoverY = box.y + Math.min(box.height - 2, 4 + Math.random() * Math.max(6, box.height / 3));
                await page.mouse.move(hoverX, hoverY, { steps: 10 + Math.floor(Math.random() * 10) });
                await new Promise(r => setTimeout(r, 120 + Math.floor(Math.random() * 240)));
            }
            await el.click({ delay: 40 });
        } else {
            await page.click(selector, { delay: 40 });
        }
    } catch (e) {
        // Fallback to simple click
        try { await page.click(selector); } catch (_) {}
    }
};

// Robust form submit helper: tries button click, event dispatch, requestSubmit, and submit
const robustSubmit = async (page, submitSelectorList, inputSelectorForEnter = '#password') => {
    // Find first available submit selector
    let submitSel = null;
    for (const s of submitSelectorList) {
        if (await waitForElementReady(page, s, 2000)) { submitSel = s; break; }
    }

    if (submitSel) {
        // Ensure enabled
        try {
            await page.$eval(submitSel, (btn) => {
                btn.disabled = false;
                const cls = btn.classList;
                if (cls && cls.contains('disabled')) cls.remove('disabled');
            });
        } catch (_) {}

        // Try hover + click
        await hoverAndClickHuman(page, submitSel).catch(() => {});
        await new Promise(r => setTimeout(r, 150 + Math.floor(Math.random() * 250)));

        // If no navigation/change, dispatch a native click event
        try {
            await page.$eval(submitSel, (btn) => {
                btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
        } catch (_) {}

        // Try submitting the nearest form
        try {
            await page.$eval(submitSel, (btn) => {
                const form = btn.closest('form');
                if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
                else if (form) form.submit();
            });
        } catch (_) {}
    }

    // Try pressing Enter inside password field
    try { await page.focus(inputSelectorForEnter); await page.keyboard.press('Enter'); } catch (_) {}

    // Last resort: find visible login form and submit
    try {
        await page.evaluate(() => {
            const visible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).visibility !== 'hidden';
            };
            const forms = Array.from(document.querySelectorAll('form.login, form.woocommerce-form-login, form#loginform'));
            const form = forms.find(f => visible(f));
            if (form) {
                if (typeof form.requestSubmit === 'function') form.requestSubmit();
                else form.submit();
            }
        });
    } catch (_) {}
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
        this.waitingForVerification = false;
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

            // Always use regular Puppeteer (no Browserless / Cloudflare bypass)
            console.log('🔍 Launching regular Puppeteer browser...');
            browserResult = await createRegularBrowser();
            console.log('✅ Regular browser created successfully');

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

        // Attempt sidebar login on homepage, fallback to my-account form
        await navigateWithRetry(this.page, 'https://www.realgpl.com/');

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

        // Try to open sidebar/menu that contains login
        const sidebarToggles = [
            // Site/theme-specific (Woodmart)
            '.login-side-opener',
            '.wd-header-my-account',
            '.wd-tools-element.login-side-opener',
            'a[title="My account"]',
            // Generic menu/sidebar toggles
            '.ast-mobile-menu-trigger',
            '.menu-toggle',
            'button[aria-label*="menu" i]',
            '.elementor-menu-toggle',
            '.eicon-menu-bar',
            '.navbar-toggler',
            '.toggle-navigation',
            '.header__burger'
        ];

        for (const sel of sidebarToggles) {
            try {
                if (await waitForElementReady(this.page, sel, 3000)) {
                    await this.page.click(sel);
                    await new Promise(resolve => setTimeout(resolve, randomDelay(500, 1200)));
                    break;
                }
            } catch (_) {}
        }

        // If sidebar doesn't expose form, try clicking a Login/My Account link
        try {
            const linkHandle = await this.page.evaluateHandle(() => {
                const anchors = Array.from(document.querySelectorAll('a'));
                return anchors.find(a => a.matches('a[title="My account"]') || /login|my\s*account/i.test(a.textContent || '')) || null;
            });
            if (linkHandle) {
                await (await linkHandle.asElement()).click();
                await new Promise(resolve => setTimeout(resolve, randomDelay(800, 1500)));
            }
        } catch (_) {}

        // After attempting openers, wait briefly for inline login form to appear
        try {
            await Promise.race([
                this.page.waitForSelector('#username', { timeout: 3000 }),
                this.page.waitForSelector('form.login', { timeout: 3000 }),
                this.page.waitForSelector('form.woocommerce-form-login', { timeout: 3000 })
            ]);
        } catch (_) {}

        // If username field still not present, fallback to account page
        const hasInlineForm = await waitForElementReady(this.page, '#username', 5000);
        if (!hasInlineForm) {
            await navigateWithRetry(this.page, 'https://www.realgpl.com/my-account/');
        }

        // Ensure form fields are available
        await waitForElementReady(this.page, '#username');
        await waitForElementReady(this.page, '#password');

        // Up to 2 attempts; each attempt clicks submit N times (1,2)
        let success = false;
        for (let attempt = 1; attempt <= 2 && !success; attempt++) {
            console.log(`📝 Filling credentials (attempt ${attempt})...`);
            try {
                // Clear and fill fields each attempt
                await this.page.evaluate(() => {
                    const u = document.querySelector('#username');
                    const p = document.querySelector('#password');
                    if (u) u.value = '';
                    if (p) p.value = '';
                });
                await typeLikeHuman(this.page, '#username', username.toString());
                await new Promise(resolve => setTimeout(resolve, randomDelay(300, 700)));
                await typeLikeHuman(this.page, '#password', password.toString());
                await new Promise(resolve => setTimeout(resolve, randomDelay(400, 900)));

                // Remember me if present
                try {
                    const rememberSelector = 'input[name="rememberme"], .woocommerce-form__input.woocommerce-form__input-checkbox[name="rememberme"]';
                    const hasRemember = await this.page.$(rememberSelector);
                    if (hasRemember) {
                        const isChecked = await this.page.$eval(rememberSelector, el => el.checked);
                        if (!isChecked) {
                            await this.page.click(rememberSelector);
                        }
                    }
                } catch (_) {}

                // Submit button selectors
                const submitSelectors = [
                    // WooCommerce default
                    '.button.woocommerce-button.woocommerce-form-login__submit',
                    'button[name="login"]',
                    'form.login button[type="submit"]',
                    'form.woocommerce-form-login button[type="submit"]',
                    '.woocommerce-form-login__submit',
                    // Woodmart / theme variations
                    '.wd-woo-login .button[type="submit"]',
                    '.wd-woo-login button[type="submit"]',
                    '.wd-woo-login .woocommerce-form-login__submit',
                    '.wd-popup-login .button[type="submit"]',
                    // Generic fallbacks
                    'button[type="submit"].button',
                    'button[type="submit"]',
                    'input[type="submit"]'
                ];

                // Click/submit with increasing attempts using robust strategies
                for (let c = 0; c < attempt; c++) {
                    await robustSubmit(this.page, submitSelectors, '#password');
                    await new Promise(resolve => setTimeout(resolve, randomDelay(300, 800)));
                }

                // Also try Enter key on password field once per attempt
                try {
                    await this.page.focus('#password');
                    await this.page.keyboard.press('Enter');
                } catch (_) {}

                // Wait briefly for navigation or account indicators
                try {
                    await Promise.race([
                        this.page.waitForNavigation({ timeout: 20000, waitUntil: 'domcontentloaded' }),
                        this.page.waitForSelector('.woocommerce-MyAccount-navigation', { timeout: 20000 }),
                        this.page.waitForSelector('a[href*="customer-logout"]', { timeout: 20000 })
                    ]);
                } catch (_) {}

                // Poll for logged-in cookie and check page indicators
                for (let t = 0; t < 5 && !success; t++) {
                    success = await this.verifyLogin();
                    if (success) break;
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                if (!success) {
                    // Capture any WooCommerce error messages to help diagnose
                    try {
                        const errorText = await this.page.evaluate(() => {
                            const err = document.querySelector('ul.woocommerce-error');
                            return err ? err.innerText.trim() : '';
                        });
                        if (errorText) {
                            console.log('⚠️  WooCommerce error:', errorText);
                            if (/verification required/i.test(errorText)) {
                                this.waitingForVerification = true;
                                throw new Error('VERIFICATION_REQUIRED');
                            }
                        }
                    } catch (e) {
                        if (e && e.message === 'VERIFICATION_REQUIRED') throw e;
                    }
                    console.log(`Login not confirmed after attempt ${attempt}`);
                    await new Promise(resolve => setTimeout(resolve, randomDelay(1200, 2000)));
                }
            } catch (e) {
                console.log(`Attempt ${attempt} error: ${e.message}`);
                if (e && e.message === 'VERIFICATION_REQUIRED') throw e;
            }
        }

        if (!success) {
            console.log('🔁 Sidebar login failed. Trying my-account page fallback (2 attempts)...');
            try {
                await navigateWithRetry(this.page, 'https://www.realgpl.com/my-account/');

                for (let attempt = 1; attempt <= 2 && !success; attempt++) {
                    await waitForElementReady(this.page, '#username');
                    await waitForElementReady(this.page, '#password');

                    await this.page.evaluate(() => {
                        const u = document.querySelector('#username');
                        const p = document.querySelector('#password');
                        if (u) u.value = '';
                        if (p) p.value = '';
                    });
                    await typeLikeHuman(this.page, '#username', username.toString());
                    await new Promise(resolve => setTimeout(resolve, randomDelay(300, 700)));
                    await typeLikeHuman(this.page, '#password', password.toString());

                    // Remember me if present
                    try {
                        const rememberSelector = 'input[name="rememberme"], .woocommerce-form__input.woocommerce-form__input-checkbox[name="rememberme"]';
                        const hasRemember = await this.page.$(rememberSelector);
                        if (hasRemember) {
                            const isChecked = await this.page.$eval(rememberSelector, el => el.checked);
                            if (!isChecked) await this.page.click(rememberSelector);
                        }
                    } catch (_) {}

                    // Submit
                    const submitSelectors = [
                        '.button.woocommerce-button.woocommerce-form-login__submit',
                        'button[name="login"]',
                        'form.login button[type="submit"]',
                        'form.woocommerce-form-login button[type="submit"]',
                        '.woocommerce-form-login__submit',
                        'button[type="submit"].button',
                        'button[type="submit"]',
                        'input[type="submit"]'
                    ];

                    await robustSubmit(this.page, submitSelectors, '#password');

                    try {
                        await Promise.race([
                            this.page.waitForNavigation({ timeout: 20000, waitUntil: 'domcontentloaded' }),
                            this.page.waitForSelector('.woocommerce-MyAccount-navigation', { timeout: 20000 }),
                            this.page.waitForSelector('a[href*="customer-logout"]', { timeout: 20000 })
                        ]);
                    } catch (_) {}

                    for (let t = 0; t < 5 && !success; t++) {
                        success = await this.verifyLogin();
                        if (success) break;
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                    // Check for verification-required error on this page as well
                    try {
                        const errorText = await this.page.evaluate(() => {
                            const err = document.querySelector('ul.woocommerce-error');
                            return err ? err.innerText.trim() : '';
                        });
                        if (errorText) {
                            console.log('⚠️  WooCommerce error:', errorText);
                            if (/verification required/i.test(errorText)) {
                                this.waitingForVerification = true;
                                throw new Error('VERIFICATION_REQUIRED');
                            }
                        }
                    } catch (e) {
                        if (e && e.message === 'VERIFICATION_REQUIRED') throw e;
                    }
                }
            } catch (e) {
                console.log(`My-account fallback error: ${e.message}`);
                if (e && e.message === 'VERIFICATION_REQUIRED') {
                    // Stop further login attempts and propagate
                    throw e;
                }
            }

            if (!success && !this.waitingForVerification) {
                throw new Error('Login failed after sidebar and my-account fallback attempts');
            }
        }
        console.log('✅ Successfully logged in');

        // Save login cookies for both apex and www domains
        const wwwCookies = await this.page.cookies('https://www.realgpl.com/');
        // Some installations set cookies on apex domain; fetch those as well
        let apexCookies = [];
        try {
            apexCookies = await this.page.cookies('https://realgpl.com/');
        } catch (_) { apexCookies = []; }

        // Merge and de-duplicate by name+domain+path
        const merged = [...wwwCookies, ...apexCookies];
        const seen = new Set();
        this.loginCookies = merged.filter(c => {
            const key = `${c.name}|${c.domain}|${c.path}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        this.isLoggedIn = true;
        console.log(`💾 Saved ${this.loginCookies.length} session cookies`);

        return true;
    }

    // Verify if still logged in
    async verifyLogin() {
        if (!this.page) {
            return false;
        }

        try {
            // Check cookie jar directly first (works even off-domain)
            const jarCookies = [
                ...(await this.page.cookies('https://www.realgpl.com/')),
                ...(await this.page.cookies('https://realgpl.com/')).catch(() => []) || []
            ];
            const hasWpLoginCookie = jarCookies.some(c => c.name && c.name.startsWith('wordpress_logged_in'));

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
                // Ensure cookies cover both apex and www domains
                const dualDomainCookies = [];
                for (const c of validCookies) {
                    dualDomainCookies.push(c);
                    try {
                        // If cookie is scoped only to one, create a sibling for the other
                        if (c.domain && c.domain.includes('www.realgpl.com')) {
                            dualDomainCookies.push({ ...c, domain: 'realgpl.com' });
                        } else if (c.domain && c.domain === 'realgpl.com') {
                            dualDomainCookies.push({ ...c, domain: 'www.realgpl.com' });
                        }
                    } catch (_) {}
                }

                console.log(`🔄 Restoring ${dualDomainCookies.length} session cookies`);
                await this.page.setCookie(...dualDomainCookies);
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

// Process a verification link by navigating to it and confirming login
const processVerificationLink = async (verificationUrl) => {
    if (!verificationUrl || !/^https?:\/\//i.test(verificationUrl)) {
        throw new Error('Invalid verification URL');
    }

    console.log(`🔗 Processing verification link: ${verificationUrl}`);
    const { page } = await persistentSession.getBrowser();
    await navigateWithRetry(page, verificationUrl);

    // Wait briefly for any redirects and finalize
    try { await page.waitForNavigation({ timeout: 15000, waitUntil: 'domcontentloaded' }); } catch (_) {}

    // After visiting the link, mark session as logged in if indicators present
    const verified = await persistentSession.verifyLogin();
    if (!verified) {
        // Try my-account to solidify state
        try { await navigateWithRetry(page, 'https://www.realgpl.com/my-account/'); } catch (_) {}
    }

    const finalStatus = await persistentSession.verifyLogin();
    if (finalStatus) {
        persistentSession.isLoggedIn = true;
        persistentSession.loginCookies = await page.cookies('https://www.realgpl.com/').catch(() => []);
        persistentSession.waitingForVerification = false;
        console.log('✅ Verification link processed. Session is now logged in.');
        return true;
    }
    throw new Error('Verification link did not result in a logged-in session');
};

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
    typeLikeHuman,
    hoverAndClickHuman,
    robustSubmit,
    waitForElementReady,
    getCookies,
    closeBrowser,
    randomDelay,
    getRandomUserAgent,
    getRandomViewport,
    PersistentBrowserSession,
    persistentSession,
    processVerificationLink
};