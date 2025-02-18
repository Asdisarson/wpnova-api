const puppeteer = require('puppeteer');
const JSONdb = require('simple-json-db');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const stream = require('stream');
const {promisify} = require('util');
const pipeline = promisify(stream.pipeline);
const convertJsonToCsv = require('./convertJsonToCsv');
const { extractAndSolveCaptcha } = require('./captcha');
const { performance } = require('perf_hooks');

// Utility functions
const ensureDirectoryExistence = (filePath) => {
    const dirname = path.dirname(filePath);
    if (fs.existsSync(dirname)) return true;
    ensureDirectoryExistence(dirname);
    fs.mkdirSync(dirname);
};

function touch(filename) {
    try {
        if (!fs.existsSync(filename)) {
            fs.writeFileSync(filename, '');
        } else {
            const currentTime = new Date();
            fs.utimesSync(filename, currentTime, currentTime);
        }
    } catch (err) {
        console.error(`Error touching file ${filename}:`, err);
    }
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Add utility functions
const logWithTimestamp = (message) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
};

const measureTime = (startTime, label) => {
    const duration = performance.now() - startTime;
    logWithTimestamp(`${label} took ${duration.toFixed(2)}ms`);
    return duration;
};

/**
 * Enhanced error recovery function
 * @param {Function} operation - Async operation to perform
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} baseDelay - Base delay between retries in ms
 * @param {string} operationName - Name of the operation for logging
 */
async function withRetry(operation, maxRetries = 3, baseDelay = 3000, operationName = 'Operation') {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const startTime = performance.now();
            const result = await operation();
            measureTime(startTime, `${operationName} - Attempt ${attempt}`);
            return result;
        } catch (error) {
            lastError = error;
            if (attempt === maxRetries) {
                logWithTimestamp(`${operationName} failed after ${maxRetries} attempts: ${error.message}`);
                throw error;
            }
            const delay = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff
            logWithTimestamp(`${operationName} attempt ${attempt} failed, retrying in ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

/**
 * Handles the login process with retries
 * @param {import('puppeteer').Page} page - Puppeteer page object
 * @returns {Promise<boolean>} - True if login successful
 */
async function handleLogin(page) {
    console.log('Starting login process...');
    
    try {
        // Go to the login page with full load waiting
        console.log('Navigating to login page...');
        await page.goto('https://www.realgpl.com/my-account/', {
            waitUntil: ['networkidle0', 'domcontentloaded', 'load'],
            timeout: 120000
        });

        // Wait for critical elements to be truly ready
        console.log('Waiting for page to be fully interactive...');
        await Promise.all([
            page.waitForSelector('#username', { visible: true, timeout: 60000 }),
            page.waitForSelector('#password', { visible: true, timeout: 60000 }),
            page.waitForSelector('.aiowps-captcha-equation', { visible: true, timeout: 60000 }),
            page.waitForSelector('.woocommerce-form-login__submit', { visible: true, timeout: 60000 })
        ]);

        // Additional wait to ensure JavaScript is fully loaded
        await page.waitForFunction(() => {
            return document.readyState === 'complete' && 
                   !document.querySelector('.loading') &&
                   window.jQuery !== undefined;
        }, { timeout: 60000 });

        console.log('Page is fully loaded and interactive');
        
        // Handle consent if present
        try {
            const consentButton = await page.$('.fc-button-label');
            if (consentButton) {
                console.log('Handling consent popup...');
                await consentButton.click();
                await delay(2500);
                await page.waitForFunction(() => {
                    const overlay = document.querySelector('.fc-consent-overlay');
                    return !overlay || overlay.style.display === 'none';
                }, { timeout: 10000 });
            }
        } catch (error) {
            console.log('No consent popup found or already handled');
        }
        
        // Try login up to 3 times
        for (let attempt = 1; attempt <= 3; attempt++) {
            console.log(`\nLogin attempt ${attempt} of 3`);
            
            try {
                if (attempt > 1) {
                    console.log('Clearing previous input and reloading...');
                    await page.evaluate(() => {
                        document.querySelector('#username').value = '';
                        document.querySelector('#password').value = '';
                        const captchaInput = document.querySelector('.aiowps-captcha-answer');
                        if (captchaInput) captchaInput.value = '';
                    });
                    
                    await page.reload({ 
                        waitUntil: ['networkidle0', 'domcontentloaded', 'load'],
                        timeout: 60000 
                    });
                    
                    await Promise.all([
                        page.waitForSelector('#username', { visible: true, timeout: 60000 }),
                        page.waitForSelector('#password', { visible: true, timeout: 60000 }),
                        page.waitForSelector('.aiowps-captcha-equation', { visible: true, timeout: 60000 })
                    ]);
                    
                    await delay(3000);
                }
                
                // Get and solve captcha
                const captchaText = await page.$eval('.aiowps-captcha-equation strong', el => el.textContent);
                console.log('Current captcha:', captchaText.trim());
                
                // Fill in credentials
                console.log('Entering credentials...');
                await page.type('#username', process.env.USERNAME);
                await page.type('#password', process.env.PASSWORD);
                
                // Handle captcha
                console.log('Solving captcha...');
                const html = await page.content();
                const captchaSolution = extractAndSolveCaptcha(html);
                console.log('Captcha equation:', captchaSolution.equation);
                console.log('Captcha answer:', captchaSolution.answer);
                
                await page.type('.aiowps-captcha-answer', captchaSolution.answer.toString());
                
                // Submit form and wait for navigation
                console.log('Submitting login form...');
                await Promise.all([
                    page.waitForNavigation({ 
                        waitUntil: ['networkidle0', 'domcontentloaded', 'load'],
                        timeout: 60000 
                    }),
                    page.click('.woocommerce-form-login__submit')
                ]);
                
                await delay(4000);
                
                // Verify login success
                const errorMessage = await page.$('.woocommerce-error');
                if (errorMessage) {
                    const error = await page.$eval('.woocommerce-error', el => el.textContent);
                    console.log('Login failed:', error.trim());
                    if (attempt < 3) await delay(5000);
                    continue;
                }
                
                const loggedInElement = await page.$('.woocommerce-MyAccount-navigation');
                if (loggedInElement) {
                    console.log('Login successful!');
                    return true;
                }
                
                console.log('Login status unclear - no error but not on account page');
                if (attempt < 3) await delay(5000);
                
            } catch (error) {
                console.error(`Error during login attempt ${attempt}:`, error.message);
                if (attempt < 3) {
                    console.log('Waiting before retry...');
                    await delay(3000);
                }
            }
        }
        
        console.log('All login attempts failed');
        return false;
        
    } catch (error) {
        console.error('Fatal error during login process:', error);
        throw error;
    }
}

/**
 * Scrapes changelog data from a specific page
 * @param {import('puppeteer').Page} page - Puppeteer page object
 * @param {string} theDate - Target date string
 * @param {number} pageNum - Page number to scrape
 * @returns {Promise<Array>} - Array of changelog entries
 */
async function scrapeChangelogPage(page, theDate, pageNum) {
    const startTime = performance.now();
    logWithTimestamp(`Scraping changelog page ${pageNum}...`);
    
    const url = `https://www.realgpl.com/changelog/?99936_results_per_page=50&99936_paged=${pageNum}`;
    const baseTimeout = 60000;
    const progressiveTimeout = baseTimeout * (1 + (pageNum > 1 ? Math.min(pageNum * 0.2, 1) : 0));
    
    try {
        // Performance optimization: Enable request interception to block unnecessary resources
        await page.setRequestInterception(true);
        page.on('request', request => {
            const resourceType = request.resourceType();
            if (['image', 'stylesheet', 'font'].includes(resourceType)) {
                request.abort();
            } else {
                request.continue();
            }
        });

        logWithTimestamp(`Navigating to page ${pageNum} with ${progressiveTimeout}ms timeout`);
        await page.goto(url, {
            waitUntil: ['networkidle0', 'domcontentloaded', 'load'],
            timeout: progressiveTimeout
        });
        measureTime(startTime, 'Navigation');

        const loadStartTime = performance.now();
        await page.waitForFunction(() => {
            return document.readyState === 'complete' && 
                   !document.querySelector('.loading');
        }, { timeout: progressiveTimeout });
        measureTime(loadStartTime, 'Page load');

        // Performance optimization: Use CDP to get page content
        const cdpStartTime = performance.now();
        const data = await withRetry(async () => {
            const result = await page.evaluate((theDate) => {
                const rows = document.querySelectorAll('tr.awcpt-row');
                const rowDataArray = [];
                performance.mark('scraping-start');
                
                for (const row of rows) {
                    const date = row.querySelector('.awcpt-date')?.innerText;
                    if (date === theDate) {
                        try {
                            rowDataArray.push({
                                id: row.getAttribute('data-id'),
                                productName: row.querySelector('.awcpt-title')?.innerText,
                                date,
                                downloadLink: row.querySelector('.awcpt-shortcode-wrap a')?.getAttribute('href'),
                                productURL: row.querySelector('.awcpt-prdTitle-col a')?.getAttribute('href'),
                            });
                        } catch (e) {
                            console.error('Error processing row:', e);
                        }
                    }
                }
                
                performance.mark('scraping-end');
                performance.measure('scraping', 'scraping-start', 'scraping-end');
                return rowDataArray;
            }, theDate);
            return result;
        }, 3, 5000, `Page ${pageNum} data extraction`);
        
        measureTime(cdpStartTime, 'Data extraction');
        logWithTimestamp(`Found ${data.length} matching entries on page ${pageNum}`);
        
        // Disable request interception after we're done
        await page.setRequestInterception(false);
        return data;
        
    } catch (error) {
        logWithTimestamp(`Error scraping changelog page ${pageNum}: ${error.message}`);
        // Ensure we disable request interception even on error
        await page.setRequestInterception(false);
        return [];
    } finally {
        measureTime(startTime, `Total page ${pageNum} processing`);
    }
}

const scheduledTask = async (date = new Date()) => {
    const dbPath = path.join(__dirname, 'files.json');
    ensureDirectoryExistence(dbPath);
    const db = new JSONdb(dbPath);
    db.JSON({});
    let list = [];
    let error = [];

    const today = new Date();
    const daysDiff = Math.floor((today - date) / (1000 * 60 * 60 * 24));
    console.log(`Searching for updates from ${daysDiff} days ago`);

    try {
        console.log('Launching browser...');
        const browser = await puppeteer.launch({
            headless: "new",  // Using new headless mode
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1280,800'
            ],
            defaultViewport: {
                width: 1280,
                height: 800
            }
        });

        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(120000);
        
        const loginSuccess = await handleLogin(page);
        if (!loginSuccess) {
            throw new Error('Failed to login after multiple attempts');
        }

        console.log('Starting changelog scraping...');
        let allData = [];
        let currentPage = 1;
        let maxPages = daysDiff > 3 ? 10 : 5;
        let foundEntries = false;
        let consecutiveEmptyPages = 0;
        const MAX_EMPTY_PAGES = 3;

        const theDate = new Date(date).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
        console.log(`Looking for entries from: ${theDate}`);

        while (currentPage <= maxPages) {
            console.log(`Processing page ${currentPage} of ${maxPages}`);
            const pageData = await scrapeChangelogPage(page, theDate, currentPage);
            
            if (pageData.length > 0) {
                console.log(`Found ${pageData.length} entries on page ${currentPage}`);
                allData = allData.concat(pageData);
                foundEntries = true;
                consecutiveEmptyPages = 0;
            } else {
                consecutiveEmptyPages++;
                console.log(`No entries found on page ${currentPage}. Empty pages in a row: ${consecutiveEmptyPages}`);
                
                if (foundEntries && consecutiveEmptyPages >= MAX_EMPTY_PAGES) {
                    console.log(`No entries found in ${MAX_EMPTY_PAGES} consecutive pages, stopping pagination`);
                    break;
                }
            }
            
            currentPage++;
            if (currentPage <= maxPages) {
                const waitTime = 3000 + (currentPage > 5 ? 2000 : 0);
                console.log(`Waiting ${waitTime}ms before next page...`);
                await delay(waitTime);
            }
        }

        console.log(`Total entries found: ${allData.length} across ${currentPage - 1} pages`);
        
        // Process entries
        for (const item of allData) {
            if (/\d/.test(item.productName)) {
                try {
                    const version = item.productName.match(/v\d+(\.\d+){0,3}/)?.[0] || '';
                    const versionWithoutV = version.replace('v', '');
                    const textWithoutVersion = item.productName.replace(/ v\d+(\.\d+){0,3}/, '');
                    
                    const parsedUrl = new URL(item.productURL);
                    const url = item.productURL.replace(/^\/|\/$/g, '');
                    const parts = url.split('/');
                    const slug = parts[parts.length - 1];
                    const productId = parsedUrl.searchParams.get("product_id");

                    item.version = versionWithoutV;
                    item.name = textWithoutVersion;
                    item.slug = slug;
                    item.filename = '';
                    item.filePath = '';
                    item.productId = productId;
                } catch (e) {
                    console.error('Error processing item:', e);
                }
            }
        }
        console.log('Data processing completed.');

        // Download files
        let fileCounter = 0;
        let errorCounter = 0;
        for (const item of allData) {
            const downloadStartTime = performance.now();
            logWithTimestamp(`Starting download for file ${fileCounter + 1} of ${allData.length}`);
            
            try {
                await withRetry(async () => {
                    const cookies = await page.cookies();
                    const formattedCookies = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
                    
                    const response = await axios({
                        url: item.downloadLink,
                        method: 'GET',
                        responseType: 'stream',
                        headers: {
                            Cookie: formattedCookies,
                            'User-Agent': await page.evaluate(() => navigator.userAgent)
                        },
                        timeout: 120000,
                        maxContentLength: Infinity,
                        maxBodyLength: Infinity
                    });

                    const modifiedString = item.slug.replace(/-download$/, "").replace(/download-/, "");
                    const filename = `${modifiedString}.zip`;
                    const filePath = path.join('./public/downloads/', filename);
                    
                    touch(filePath);
                    await pipeline(response.data, fs.createWriteStream(filePath));

                    item.filename = filename;
                    item.filePath = filePath;
                    item.fileUrl = path.join(process.env.DOWNLOAD_URL, filename);
                    
                    fileCounter++;
                    list.push(item);
                    
                    measureTime(downloadStartTime, `Download of ${filename}`);
                    return true;
                }, 3, 5000, `Download of ${item.productName}`);
            } catch (error) {
                errorCounter++;
                logWithTimestamp(`Failed to download ${item.productName}: ${error.message}`);
                error.push(item);
            }
        }

        console.log('Downloaded files:', fileCounter);
        console.log('Errors:', errorCounter);
        await browser.close();
        console.log('Browser closed.');

        // Save results
        try {
            touch('error.csv');
            await new Promise((resolve, reject) => {
                convertJsonToCsv(error, './public/error.csv', (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            console.log('Error CSV saved');
        } catch (err) {
            console.error('Error saving error.csv:', err);
        }

        try {
            db.JSON(list);
            db.sync();
            touch('data.csv');
            await new Promise((resolve, reject) => {
                convertJsonToCsv(list, './public/data.csv', (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            console.log('Data CSV saved');
        } catch (err) {
            console.error('Error saving data.csv:', err);
        }

        return list.length;

    } catch (err) {
        console.error('An error occurred:', err);
        return err;
    }
}

module.exports = scheduledTask;
