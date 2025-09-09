const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

// Add stealth plugin
puppeteer.use(StealthPlugin());

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

// Enhanced browser launch with Cloudflare bypass
const createCloudflareBypassBrowser = async () => {
    const userAgent = getRandomUserAgent();
    const viewport = getRandomViewport();
    
    console.log(`Using user agent: ${userAgent}`);
    console.log(`Using viewport: ${viewport.width}x${viewport.height}`);
    
    const browser = await puppeteer.launch({
        headless: 'new', // Use new headless mode
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-features=TranslateUI',
            '--disable-ipc-flooding-protection',
            '--disable-extensions',
            '--disable-plugins',
            '--disable-default-apps',
            '--disable-sync',
            '--disable-translate',
            '--hide-scrollbars',
            '--mute-audio',
            '--no-default-browser-check',
            '--no-pings',
            '--password-store=basic',
            '--use-mock-keychain',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=VizDisplayCompositor',
            '--disable-web-security',
            '--disable-features=site-per-process',
            '--disable-hang-monitor',
            '--disable-prompt-on-repost',
            '--disable-domain-reliability',
            '--disable-component-extensions-with-background-pages',
            '--disable-background-networking',
            '--disable-sync-preferences',
            '--disable-client-side-phishing-detection',
            '--disable-component-update',
            '--disable-default-apps',
            '--disable-domain-reliability',
            '--disable-features=AudioServiceOutOfProcess',
            '--disable-hang-monitor',
            '--disable-ipc-flooding-protection',
            '--disable-popup-blocking',
            '--disable-prompt-on-repost',
            '--disable-renderer-backgrounding',
            '--disable-sync',
            '--force-color-profile=srgb',
            '--metrics-recording-only',
            '--no-first-run',
            '--safebrowsing-disable-auto-update',
            '--enable-automation',
            '--password-store=basic',
            '--use-mock-keychain',
            `--user-agent=${userAgent}`,
            `--window-size=${viewport.width},${viewport.height}`
        ],
        defaultViewport: null,
        userDataDir: path.join(process.cwd(), 'temp_user_data_' + Date.now())
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
                waitUntil: 'networkidle2',
                timeout: 30000 
            });
            
            // Handle Cloudflare challenge
            await handleCloudflareChallenge(page);
            
            // Check if we got a successful response
            if (response && response.status() < 400) {
                console.log(`Successfully navigated to ${url}`);
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

module.exports = {
    createCloudflareBypassBrowser,
    navigateWithRetry,
    handleCloudflareChallenge,
    addHumanLikeBehavior,
    randomDelay,
    getRandomUserAgent,
    getRandomViewport
};
