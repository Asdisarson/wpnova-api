// Unified changelog downloader module
const { 
    createRegularBrowser,
    createCloudflareBypassBrowser, 
    navigateWithRetry, 
    handleCloudflareChallenge, 
    addHumanLikeBehavior,
    waitForElementReady,
    getCookies,
    closeBrowser,
    randomDelay 
} = require('./cloudflareBypass');
const JSONdb = require('simple-json-db');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const stream = require('stream');
const {promisify} = require('util');
const pipeline = promisify(stream.pipeline);
const convertJsonToCsv = require('./convertJsonToCsv');

// Add a universal delay function
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Ensure directory exists
const ensureDirectoryExistence = (filePath) => {
    const dirname = path.dirname(filePath);
    if (fs.existsSync(dirname)) {
        return true;
    }
    ensureDirectoryExistence(dirname);
    fs.mkdirSync(dirname);
}

// Touch file function
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

/**
 * Main function to download products from changelog
 * @param {Object} options - Configuration options
 * @param {Date} options.date - Date to filter products (default: today)
 * @param {number} options.resultsPerPage - Number of results per page (default: 500)
 * @param {boolean} options.downloadFiles - Whether to download files (default: true)
 * @returns {Promise<Object>} - Results object with download counts and data
 */
async function downloadFromChangelog(options = {}) {
    const {
        date = new Date(),
        resultsPerPage = 500,
        downloadFiles = true
    } = options;
    
    const dbPath = path.join(__dirname, 'files.json');
    ensureDirectoryExistence(dbPath);
    const db = new JSONdb(dbPath);
    db.JSON({});
    
    let list = [];
    let errors = [];
    let browser;
    
    try {
        // Ensure download directory exists
        if (!fs.existsSync('./public/downloads/')) {
            fs.mkdirSync('./public/downloads/', {recursive: true});
            touch('./public/downloads/index.html');
        }
        
        // Pre-check: Test if the website is reachable
        console.log('🔍 Checking website availability...');
        try {
            const testResponse = await axios.get('https://www.realgpl.com', {
                timeout: 10000,
                validateStatus: (status) => status < 500,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
                }
            });
            console.log(`✅ Website is reachable (Status: ${testResponse.status})`);
        } catch (error) {
            console.error(`⚠️  Website pre-check failed: ${error.message}`);
            console.log('Continuing anyway...');
        }
        
        // Try regular browser first, fallback to Browserless if needed
        let browserResult;
        let usedBrowserless = false;
        
        try {
            console.log('🚀 Attempting with regular Puppeteer browser (no Browserless)...');
            browserResult = await createRegularBrowser();
            browser = browserResult.browser;
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
                await closeBrowser(browser);
                throw new Error('Cloudflare challenge detected');
            }
            
            console.log('✅ Regular browser works! Proceeding without Browserless...');
            
        } catch (error) {
            console.log(`❌ Regular browser failed: ${error.message}`);
            console.log('🔄 Falling back to Browserless with Cloudflare bypass...');
            
            if (browser) {
                await closeBrowser(browser);
            }
            
            browserResult = await createCloudflareBypassBrowser();
            browser = browserResult.browser;
            usedBrowserless = true;
        }
        
        const page = browserResult.page;
        console.log(`📊 Using: ${usedBrowserless ? 'Browserless' : 'Regular Puppeteer'}`);
        
        
        // Add human-like behavior
        await addHumanLikeBehavior(page);
        
        // Login to the site
        console.log('🔐 Logging in to RealGPL...');
        await navigateWithRetry(page, 'https://www.realgpl.com/my-account/');
        
        try {
            // Wait for consent block to be ready before clicking
            const consentExists = await waitForElementReady(page, '.fc-button-label', 5000);
            if (consentExists) {
                await page.click('.fc-button-label');
                await delay(1000);
                console.log('Consent block accepted');
            }
        } catch (error) {
            console.log('No Consent block')
        }
        
        const username = process.env.USERNAME;
        const password = process.env.PASSWORD;
        
        if (!username || !password) {
            throw new Error('USERNAME and PASSWORD environment variables are required');
        }
        
        // Wait for login form to be fully loaded
        await waitForElementReady(page, '#username');
        await waitForElementReady(page, '#password');
        
        console.log('Entering credentials...');
        await page.type('#username', username.toString());
        await delay(randomDelay(500, 1000));
        await page.type('#password', password.toString());
        await delay(randomDelay(500, 1000));
        
        // Wait for login button to be ready
        await waitForElementReady(page, '.button.woocommerce-button.woocommerce-form-login__submit');
        
        console.log('Submitting login form...');
        
        // Click the login button and wait for either navigation or DOM changes
        await page.click('.button.woocommerce-button.woocommerce-form-login__submit');
        
        // Wait for login success indicators with a race condition
        try {
            await Promise.race([
                // Option 1: Wait for navigation
                page.waitForNavigation({ timeout: 60000, waitUntil: 'domcontentloaded' }),
                // Option 2: Wait for account navigation menu to appear (indicates successful login)
                page.waitForSelector('.woocommerce-MyAccount-navigation', { timeout: 60000 }),
                // Option 3: Wait for account content
                page.waitForSelector('.woocommerce-account', { timeout: 60000 })
            ]);
            console.log('✅ Successfully logged in');
        } catch (error) {
            // Final verification: check if we're logged in by examining the page
            console.log('⚠️  Login wait timed out, performing final verification...');
            await randomDelay(2000, 3000); // Give page time to settle
            
            const loginStatus = await page.evaluate(() => {
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
            
            console.log('Login status check:', loginStatus);
            
            if (!loginStatus.isLoggedIn) {
                throw new Error(`Login verification failed: ${error.message}`);
            }
            
            console.log('✅ Login verified successfully (URL: ' + loginStatus.currentUrl + ')');
        }
        
        // Navigate to changelog page
        const changelogUrl = `https://www.realgpl.com/changelog/?99936_results_per_page=${resultsPerPage}`;
        console.log(`📋 Navigating to changelog: ${changelogUrl}`);
        await navigateWithRetry(page, changelogUrl);
        
        // Wait for table to be fully loaded and interactive
        console.log('⏳ Waiting for changelog table to load...');
        const tableExists = await waitForElementReady(page, 'table#awcpt-product-table-99936', 30000);
        
        if (!tableExists) {
            throw new Error('Changelog table did not load');
        }
        
        console.log('⏳ Table element found, waiting for data rows to load...');
        
        // IMPORTANT: Wait for table rows to be populated (AJAX/JS loaded content)
        // The table exists but rows are loaded dynamically via JavaScript
        let rowsLoaded = false;
        try {
            rowsLoaded = await waitForElementReady(page, 'table#awcpt-product-table-99936 tbody tr.awcpt-row', 60000);
        } catch (error) {
            // Fallback: Try alternate selectors if tbody structure is different
            console.log('⚠️  Standard row selector failed, trying alternate selector...');
            rowsLoaded = await waitForElementReady(page, 'table#awcpt-product-table-99936 tr.awcpt-row', 30000);
        }
        
        if (!rowsLoaded) {
            throw new Error('Changelog table rows did not load');
        }
        
        // Extra wait to ensure all dynamic content is loaded
        await randomDelay(2000, 3000);
        
        // Verify rows are actually present
        const rowCount = await page.evaluate(() => {
            return document.querySelectorAll('tr.awcpt-row').length;
        });
        
        console.log(`✅ Changelog table data loaded with ${rowCount} total rows`);
        
        // Format date for comparison
        const targetDate = date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
        
        console.log(`📅 Filtering products for date: ${targetDate}`);
        
        // Extract product data from changelog (HTML 4 table structure)
        const data = await page.evaluate((filterDate) => {
            const rows = document.querySelectorAll('tr.awcpt-row');
            const rowDataArray = [];
            
            for (const row of rows) {
                const cells = row.querySelectorAll('td');
                
                // Get date from appropriate cell
                const date = row.querySelector('.awcpt-date')?.innerText || 
                            row.querySelector('td[class*="date"]')?.innerText;
                
                // Filter by date if specified
                if (!filterDate || date === filterDate) {
                    const id = row.getAttribute('data-id') || row.id;
                    
                    // Get product name - try multiple approaches for HTML 4
                    const productName = row.querySelector('.awcpt-title')?.innerText || 
                                       row.querySelector('td[class*="title"]')?.innerText ||
                                       row.querySelector('td strong')?.innerText;
                    
                    // Try multiple selectors for download link (based on actual HTML structure)
                    let downloadLink = null;
                    
                    // Method 1: Main download button with yith-wcmbs-download-button class
                    downloadLink = row.querySelector('.awcpt-shortcode-wrap a.yith-wcmbs-download-button')?.getAttribute('href');
                    
                    // Method 2: Any link in awcpt-shortcode-wrap
                    if (!downloadLink) {
                        downloadLink = row.querySelector('.awcpt-shortcode-wrap a')?.getAttribute('href');
                    }
                    
                    // Method 3: Look for protected_file parameter (unique to download links)
                    if (!downloadLink) {
                        const allLinks = row.querySelectorAll('a');
                        for (const link of allLinks) {
                            const href = link.getAttribute('href') || '';
                            
                            // Check if it's a download link with protected_file parameter
                            if (href.includes('protected_file=') || 
                                href.includes('?add-to-cart=') ||
                                link.classList.contains('yith-wcmbs-download-button')) {
                                downloadLink = href;
                                break;
                            }
                        }
                    }
                    
                    // Method 4: Look in last cell (download column)
                    if (!downloadLink && cells.length > 3) {
                        const downloadCell = cells[3]; // 4th column is download
                        const linkInCell = downloadCell.querySelector('a');
                        if (linkInCell) {
                            downloadLink = linkInCell.getAttribute('href');
                        }
                    }
                    
                    // Get product URL
                    const productURL = row.querySelector('.awcpt-prdTitle-col a')?.getAttribute('href') ||
                                      row.querySelector('td a[href*="product"]')?.getAttribute('href') ||
                                      row.querySelector('td a[href*="realgpl.com"]')?.getAttribute('href');
                    
                    if (id && productName) {
                        // Extract version from product name
                        let version = '';
                        let textWithoutVersion = productName;
                        try {
                            const versionMatch = productName.match(/v\d+(\.\d+){0,3}/);
                            if (versionMatch) {
                                version = versionMatch[0].replace('v', '');
                                textWithoutVersion = productName.replace(/ v\d+(\.\d+){0,3}/, '');
                            }
                        } catch (e) {}
                        
                        // Extract slug from URL
                        let slug = '';
                        let productId = '';
                        if (productURL) {
                            try {
                                const parsedUrl = new URL(productURL);
                                const parts = productURL.split('/');
                                slug = parts[parts.length - 1] || parts[parts.length - 2];
                                productId = parsedUrl.searchParams.get("product_id");
                            } catch (e) {}
                        }
                        
                        rowDataArray.push({
                            id,
                            productName,
                            date,
                            downloadLink,
                            productURL,
                            version,
                            name: textWithoutVersion,
                            slug,
                            productId
                        });
                    }
                }
            }
            
            return rowDataArray;
        }, targetDate);
        
        console.log(`📊 Found ${data.length} products in changelog`);
        
        if (data.length === 0) {
            console.log('⚠️  No products found for the specified date');
            await closeBrowser(browser);
            return { 
                downloadedCount: 0, 
                errorCount: 0, 
                products: [],
                errors: []
            };
        }
        
        // Debug: Check if download links are missing and log HTML structure
        const missingLinks = data.filter(p => !p.downloadLink).length;
        if (missingLinks > 0) {
            console.log(`⚠️  ${missingLinks} products missing download links. Investigating HTML structure...`);
            
            // Get HTML structure of first row for debugging
            const sampleRowHTML = await page.evaluate(() => {
                const firstRow = document.querySelector('tr.awcpt-row');
                if (firstRow) {
                    return {
                        outerHTML: firstRow.outerHTML.substring(0, 1000), // First 1000 chars
                        classList: Array.from(firstRow.classList),
                        allLinks: Array.from(firstRow.querySelectorAll('a')).map(a => ({
                            href: a.getAttribute('href'),
                            text: a.innerText,
                            classes: Array.from(a.classList)
                        }))
                    };
                }
                return null;
            });
            
            console.log('📋 Sample row structure:', JSON.stringify(sampleRowHTML, null, 2));
        }
        
        // Display found products
        console.log('\n📦 Products to process:');
        data.forEach((product, index) => {
            const linkStatus = product.downloadLink ? '✅' : '❌';
            console.log(`${index + 1}. ${product.productName} ${linkStatus}`);
        });
        
        // Download files if enabled
        if (downloadFiles) {
            console.log('\n⬇️  Starting downloads...');
            
            // Get cookies for authenticated downloads
            const cookies = await getCookies(page);
            const formattedCookies = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
            
            let fileCounter = 0;
            let errorCounter = 0;
            
            for (let i = 0; i < data.length; i++) {
                console.log(`\n📥 Downloading file ${i + 1} of ${data.length}...`);
                console.log(`Product: ${data[i].productName}`);
                
                try {
                    // If no direct download link, try to construct it from product URL or ID
                    if (!data[i].downloadLink) {
                        // Try to navigate to the product page and find download link
                        if (data[i].productURL) {
                            console.log(`🔍 No direct download link, checking product page: ${data[i].productURL}`);
                            
                            await page.goto(data[i].productURL, { waitUntil: 'networkidle2', timeout: 30000 });
                            await randomDelay(1000, 2000);
                            
                            // Look for download button/link on product page
                            const downloadLinkFromPage = await page.evaluate(() => {
                                // Try common download button selectors
                                const selectors = [
                                    'a.download-button',
                                    'a[href*="download"]',
                                    '.product-download a',
                                    'a.button[href*="download"]',
                                    '.woocommerce-MyAccount-downloads a'
                                ];
                                
                                for (const selector of selectors) {
                                    const link = document.querySelector(selector);
                                    if (link) {
                                        return link.getAttribute('href');
                                    }
                                }
                                return null;
                            });
                            
                            if (downloadLinkFromPage) {
                                data[i].downloadLink = downloadLinkFromPage;
                                console.log(`✅ Found download link on product page: ${downloadLinkFromPage}`);
                            } else {
                                throw new Error('No download link found on product page');
                            }
                        } else {
                            throw new Error('No download link or product URL available');
                        }
                    }
                    
                    // Download the file
                    const response = await axios({
                        url: data[i].downloadLink,
                        method: 'GET',
                        responseType: 'stream',
                        headers: {
                            Cookie: formattedCookies,
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Referer': 'https://www.realgpl.com/changelog/'
                        },
                        timeout: 60000
                    });
                    
                    // Generate filename
                    let filename = data[i].slug || `product-${data[i].id}`;
                    filename = filename.replace(/-download$/, "").replace(/^download-/, "");
                    filename = `${filename}.zip`;
                    
                    const filePath = path.join('./public/downloads/', filename);
                    
                    // Save file
                    await pipeline(response.data, fs.createWriteStream(filePath));
                    console.log(`✅ Downloaded: ${filename}`);
                    
                    // Update data with file info
                    data[i].filename = filename;
                    data[i].filePath = filePath;
                    data[i].fileUrl = path.join(process.env.DOWNLOAD_URL || '/downloads', filename);
                    
                    list.push(data[i]);
                    fileCounter++;
                    
                } catch (error) {
                    console.error(`❌ Failed to download: ${error.message}`);
                    errors.push({
                        product: data[i].productName,
                        error: error.message
                    });
                    errorCounter++;
                }
                
                // Small delay between downloads
                if (i < data.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
            
            console.log(`\n📊 Download Summary:`);
            console.log(`✅ Successfully downloaded: ${fileCounter} files`);
            console.log(`❌ Failed downloads: ${errorCounter} files`);
        } else {
            // If not downloading, just return the product data
            list = data;
        }
        
        // Save to database
        db.JSON(list);
        db.sync();
        
        // Generate CSV file
        if (list.length > 0) {
            touch('./public/data.csv');
            await new Promise((resolve, reject) => {
                convertJsonToCsv(list, './public/data.csv', (err) => {
                    if (err) {
                        console.error('Error generating CSV:', err);
                        reject(err);
                    } else {
                        console.log('✅ CSV file has been saved');
                        resolve();
                    }
                });
            });
        }
        
        // Close browser
        await closeBrowser(browser);
        console.log('🔒 Browser closed');
        
        return {
            downloadedCount: list.length,
            errorCount: errors.length,
            products: list,
            errors: errors
        };
        
    } catch (error) {
        console.error('❌ Fatal error:', error.message);
        if (browser) {
            await closeBrowser(browser);
        }
        throw error;
    }
}

// Export the main function
module.exports = downloadFromChangelog;
