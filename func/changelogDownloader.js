// Unified changelog downloader module using Browserless
const { 
    createCloudflareBypassBrowser, 
    navigateWithRetry, 
    handleCloudflareChallenge, 
    addHumanLikeBehavior, 
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
        
        // Launch Browserless browser with Cloudflare bypass
        console.log('🚀 Launching Browserless browser with Cloudflare bypass...');
        const browserResult = await createCloudflareBypassBrowser();
        browser = browserResult.browser;
        const page = browserResult.page;
        
        // Add human-like behavior
        await addHumanLikeBehavior(page);
        
        // Login to the site
        console.log('🔐 Logging in to RealGPL...');
        await navigateWithRetry(page, 'https://www.realgpl.com/my-account/');
        
        const username = process.env.USERNAME;
        const password = process.env.PASSWORD;
        
        if (!username || !password) {
            throw new Error('USERNAME and PASSWORD environment variables are required');
        }
        
        console.log('Entering credentials...');
        await page.type('#username', username.toString());
        await page.type('#password', password.toString());
        
        console.log('Submitting login form...');
        
        // Use a more robust approach with a race condition to handle both navigation and DOM changes
        try {
            await Promise.all([
                page.waitForNavigation({ timeout: 60000 }), // Increased timeout to 60 seconds
                page.click('.button.woocommerce-button.woocommerce-form-login__submit'),
            ]);
        } catch (error) {
            // If navigation times out, check if we're still logged in by looking for account elements
            console.log('Navigation wait failed, verifying login status...');
            const isLoggedIn = await page.evaluate(() => {
                return document.querySelector('.woocommerce-MyAccount-navigation') !== null ||
                       document.querySelector('.woocommerce-account') !== null ||
                       !document.querySelector('#username');
            });
            
            if (!isLoggedIn) {
                throw new Error('Login failed: ' + error.message);
            }
            console.log('✅ Login verified despite navigation timeout');
        }
        
        console.log('✅ Successfully logged in');
        
        // Navigate to changelog page
        const changelogUrl = `https://www.realgpl.com/changelog/?99936_results_per_page=${resultsPerPage}`;
        console.log(`📋 Navigating to changelog: ${changelogUrl}`);
        await navigateWithRetry(page, changelogUrl);
        
        // Wait for table to load
        await page.waitForSelector('table#awcpt-product-table-99936', { timeout: 30000 });
        console.log('✅ Changelog table loaded');
        
        // Format date for comparison
        const targetDate = date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
        
        console.log(`📅 Filtering products for date: ${targetDate}`);
        
        // Extract product data from changelog
        const data = await page.evaluate((filterDate) => {
            const rows = document.querySelectorAll('tr.awcpt-row');
            const rowDataArray = [];
            
            for (const row of rows) {
                const date = row.querySelector('.awcpt-date')?.innerText;
                
                // Filter by date if specified
                if (!filterDate || date === filterDate) {
                    const id = row.getAttribute('data-id');
                    const productName = row.querySelector('.awcpt-title')?.innerText;
                    const downloadLink = row.querySelector('.awcpt-shortcode-wrap a')?.getAttribute('href');
                    const productURL = row.querySelector('.awcpt-prdTitle-col a')?.getAttribute('href');
                    
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
        
        // Display found products
        console.log('\n📦 Products to process:');
        data.forEach((product, index) => {
            console.log(`${index + 1}. ${product.productName}`);
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
                    if (!data[i].downloadLink) {
                        throw new Error('No download link available');
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
