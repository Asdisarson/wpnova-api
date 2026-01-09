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
    randomDelay,
    persistentSession
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
    try {
        fs.mkdirSync(dirname, { recursive: true });
        return true;
    } catch (error) {
        console.error(`Error creating directory ${dirname}:`, error);
        return false;
    }
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
    // Only initialize if database is empty, don't clear existing data
    const existingData = db.JSON();
    if (!existingData || (Array.isArray(existingData) && existingData.length === 0)) {
        db.JSON([]);
    }
    
    let list = [];
    let errors = [];

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

        // Get persistent browser session
        console.log('🚀 Getting persistent browser session...');
        const { browser, page } = await persistentSession.getBrowser();

        // Ensure user is logged in and session is maintained
        console.log('🔐 Ensuring login session is active...');
        await persistentSession.ensureLogin();

        // Navigate to changelog page with session preservation and human-like behavior
        const changelogUrl = `https://www.realgpl.com/changelog/?99936_results_per_page=${resultsPerPage}`;
        console.log(`📋 Navigating to changelog: ${changelogUrl}`);

        // Add human-like delay before navigation
        await delay(randomDelay(1000, 2000));

        await persistentSession.navigateWithSession(changelogUrl);

        // Simulate human reading behavior - scroll down a bit
        await delay(randomDelay(2000, 3000));
        await page.evaluate(() => {
            window.scrollTo({ top: 300, behavior: 'smooth' });
        });
        await delay(randomDelay(1000, 2000));
        
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
        
        // Helper to extract product data from the current changelog page (HTML 4 table structure)
        const extractProductsForDate = async () => {
            return await page.evaluate((filterDate) => {
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
        };
        
        const maxPagesToScan = 20;
        let currentPage = 1;
        let data = [];
        
        while (currentPage <= maxPagesToScan) {
            console.log(`📄 Scanning changelog page ${currentPage}/${maxPagesToScan}...`);
            const pageData = await extractProductsForDate();
            console.log(`➡️  Page ${currentPage} has ${pageData.length} matching products`);
            
            if (pageData.length > 0) {
                data = pageData;
                break;
            }
            
            const nextPageInfo = await page.evaluate(() => {
                const selectors = [
                    '.awcpt-pagination .page-numbers.next',
                    '.awcpt-pagination a.next',
                    '.awcpt-pagination .next'
                ];
                
                for (const selector of selectors) {
                    const btn = document.querySelector(selector);
                    if (!btn) continue;
                    
                    const disabled = btn.classList.contains('disabled') || btn.getAttribute('aria-disabled') === 'true';
                    
                    return {
                        hasNext: !disabled,
                        href: btn.getAttribute('href') || '',
                        selector
                    };
                }
                
                return { hasNext: false, href: '', selector: null };
            });
            
            if (!nextPageInfo.hasNext) {
                console.log('No additional changelog pages available or next button disabled. Stopping pagination.');
                break;
            }
            
            console.log('➡️  Moving to next changelog page...');
            const previousFirstRowId = await page.evaluate(() => document.querySelector('tr.awcpt-row')?.getAttribute('data-id') || null);
            
            if (nextPageInfo.href && nextPageInfo.href !== '#') {
                await delay(randomDelay(500, 1200));
                await persistentSession.navigateWithSession(nextPageInfo.href);
            } else if (nextPageInfo.selector) {
                try {
                    await page.click(nextPageInfo.selector);
                } catch (clickErr) {
                    console.log(`⚠️  Failed to click next page button: ${clickErr.message}`);
                    break;
                }
            } else {
                console.log('No navigation method for next page found.');
                break;
            }
            
            await delay(randomDelay(1500, 2500));
            
            // Re-wait for the table and rows after pagination
            await waitForElementReady(page, 'table#awcpt-product-table-99936', 30000);
            await waitForElementReady(page, 'table#awcpt-product-table-99936 tbody tr.awcpt-row', 60000)
                .catch(async () => {
                    console.log('⚠️  Row selector failed after pagination, trying alternate selector...');
                    await waitForElementReady(page, 'table#awcpt-product-table-99936 tr.awcpt-row', 30000);
                });
            
            await page.waitForFunction((previousId) => {
                const firstRow = document.querySelector('tr.awcpt-row');
                if (!firstRow) return false;
                return firstRow.getAttribute('data-id') !== previousId;
            }, { timeout: 10000 }, previousFirstRowId).catch(() => {});
            
            currentPage++;
        }
        
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

            // Get cookies for authenticated downloads from persistent session
            const cookies = await page.cookies('https://www.realgpl.com/');
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

                            // Use persistent session navigation (maintains login state automatically)
                            await persistentSession.navigateWithSession(data[i].productURL);

                            // Wait for potential download button elements to load
                            await delay(randomDelay(1500, 2500));

                            // Look for download button/link on product page
                            const downloadLinkFromPage = await page.evaluate(() => {
                                // Try common download button selectors
                                const selectors = [
                                    'a.download-button',
                                    'a.yith-wcmbs-download-button',
                                    '.woocommerce-MyAccount-downloads a',
                                    'a[href*="download"]',
                                    '.product-download a',
                                    'a.button[href*="download"]',
                                    '.download-links a',
                                    'a[download]'
                                ];

                                for (const selector of selectors) {
                                    const link = document.querySelector(selector);
                                    if (link && link.href) {
                                        return link.getAttribute('href');
                                    }
                                }
                                return null;
                            });

                            if (downloadLinkFromPage) {
                                data[i].downloadLink = downloadLinkFromPage;
                                console.log(`✅ Found download link on product page: ${downloadLinkFromPage}`);
                            } else {
                                // Debug: Log what we can see on the page
                                const pageDebugInfo = await page.evaluate(() => {
                                    const allLinks = Array.from(document.querySelectorAll('a')).map(a => ({
                                        href: a.href,
                                        text: a.textContent.trim().substring(0, 50),
                                        classes: Array.from(a.classList)
                                    })).filter(link =>
                                        link.text.toLowerCase().includes('download') ||
                                        link.href.toLowerCase().includes('download') ||
                                        link.classes.some(c => c.includes('download'))
                                    );

                                    return {
                                        title: document.title,
                                        url: window.location.href,
                                        hasLogoutLink: document.querySelector('a[href*="customer-logout"]') !== null,
                                        downloadRelatedLinks: allLinks.slice(0, 5)
                                    };
                                });

                                console.log('🔍 Page debug info:', JSON.stringify(pageDebugInfo, null, 2));
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
        
        // Close persistent browser session
        await persistentSession.close();
        console.log('🔒 Persistent browser session closed');

        return {
            downloadedCount: list.length,
            errorCount: errors.length,
            products: list,
            errors: errors
        };

    } catch (error) {
        console.error('❌ Fatal error:', error.message);
        // Close persistent session on error
        try {
            await persistentSession.close();
        } catch (closeError) {
            console.error('Error closing persistent session:', closeError.message);
        }
        throw error;
    }
}

// Export the main function
module.exports = downloadFromChangelog;
