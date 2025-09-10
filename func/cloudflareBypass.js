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
        let retries = 3;
        
        while (retries > 0) {
            try {
                console.log(`Attempting to get Browserless WebSocket endpoint (${4 - retries}/3)...`);
                
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
                    timeout: 60000 // 60 second timeout
                });

                if (response.data.browserWSEndpoint) {
                    break; // Success, exit retry loop
                } else {
                    throw new Error('No browserWSEndpoint in response');
                }
            } catch (error) {
                retries--;
                if (retries === 0) {
                    throw error;
                }
                console.log(`Browserless API call failed, retrying in 5 seconds... (${retries} retries left)`);
                await new Promise(resolve => setTimeout(resolve, 5000));
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

// Function to get cookies from Browserless page
const getCookies = async (page) => {
    try {
        return await page.cookies();
    } catch (error) {
        console.error('Failed to get cookies:', error);
        return [];
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

module.exports = {
    createCloudflareBypassBrowser,
    navigateWithRetry,
    handleCloudflareChallenge,
    addHumanLikeBehavior,
    getCookies,
    closeBrowser,
    randomDelay,
    getRandomUserAgent,
    getRandomViewport
};