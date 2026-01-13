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

// Absolute paths (avoid relying on process.cwd(), which differs in Docker/PM2)
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DOWNLOADS_DIR = path.join(PUBLIC_DIR, 'downloads');
const DATA_CSV_PATH = path.join(PUBLIC_DIR, 'data.csv');

// Add a universal delay function
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Build a stable URL/path for the downloadable file
const joinUrlPath = (base, filename) => {
    const safeBase = (base || '/downloads').toString().trim();
    const safeName = (filename || '').toString().trim();
    if (!safeName) return safeBase || '/downloads';

    // Absolute URL base
    if (/^https?:\/\//i.test(safeBase)) {
        try {
            const u = new URL(safeBase.endsWith('/') ? safeBase : `${safeBase}/`);
            u.pathname = path.posix.join(u.pathname, safeName);
            return u.toString();
        } catch (_) {
            // fall through to string join
        }
    }

    // Relative base (URL path)
    const trimmed = safeBase.replace(/\/+$/g, '');
    return `${trimmed || ''}/${safeName}`.replace(/\/{2,}/g, '/');
};

// Notify WordPress that data.csv is ready (optional)
const notifyWordPressDataReady = async ({ downloadedCount = 0, errorCount = 0, forceUpdate = false } = {}) => {
    const webhookUrl = process.env.WORDPRESS_DATA_READY_URL;
    const secret = process.env.WPNOVA_WEBHOOK_SECRET;

    if (!webhookUrl) {
        log('webhook', 'WORDPRESS_DATA_READY_URL not set; skipping WordPress notification');
        return { ok: false, skipped: true, reason: 'missing WORDPRESS_DATA_READY_URL' };
    }
    if (!secret) {
        log('webhook', 'WPNOVA_WEBHOOK_SECRET not set; skipping WordPress notification');
        return { ok: false, skipped: true, reason: 'missing WPNOVA_WEBHOOK_SECRET' };
    }

    try {
        log('webhook', `Notifying WordPress data-ready: ${webhookUrl}`);
        const response = await axios.post(
            webhookUrl,
            {
                force_update: !!forceUpdate,
                downloadedCount,
                errorCount,
                timestamp: Date.now()
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-WPNOVA-Secret': secret
                },
                timeout: 30000
            }
        );
        log('webhook', `WordPress notified successfully (status ${response.status})`);
        return { ok: true, status: response.status, data: response.data };
    } catch (error) {
        const status = error?.response?.status;
        const data = error?.response?.data;
        log('webhook', `Failed to notify WordPress: ${status || ''} ${error.message}`);
        if (status) log('webhook', `Response status: ${status}`);
        if (data) log('webhook', `Response data: ${JSON.stringify(data).slice(0, 2000)}`);
        // Don't throw; webhook failure shouldn't fail the entire run
        return { ok: false, error: error.message, status, data };
    }
};

// Tuning knobs
const MAX_DOWNLOAD_RETRIES = 2;
const DOWNLOAD_RETRY_BASE_DELAY_MS = 1500;
const DOWNLOAD_TIMEOUT_MS = 60000;

// Lightweight contextual logger
const log = (scope, message) => {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${scope}] ${message}`);
};

// Ensure safe filename for filesystem and URLs
const sanitizeFilename = (raw, fallback = 'file') => {
    const base = (raw || fallback).toString()
        .replace(/[^\w.-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 150);
    return base || fallback;
};

// Retryable file download wrapper
const downloadWithRetry = async (item, formattedCookies) => {
    const baseName = sanitizeFilename(
        (item.slug || item.id || item.productName || 'product')
            .toString()
            .replace(/-download$/, '')
            .replace(/^download-/, ''),
        'product'
    );
    const filename = `${baseName}.zip`;
    const fileWritePath = path.join(DOWNLOADS_DIR, filename);
    const publicFilePath = path.posix.join('public', 'downloads', filename);
    const fileUrl = joinUrlPath(process.env.DOWNLOAD_URL || '/downloads', filename);

    let lastError;
    for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
        try {
            ensureDirectoryExistence(fileWritePath);
            const response = await axios({
                url: item.downloadLink,
                method: 'GET',
                responseType: 'stream',
                headers: {
                    Cookie: formattedCookies,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': 'https://www.realgpl.com/changelog/'
                },
                timeout: DOWNLOAD_TIMEOUT_MS
            });

            await pipeline(response.data, fs.createWriteStream(fileWritePath));
            return { filename, filePath: publicFilePath, fileUrl };
        } catch (error) {
            lastError = error;
            const waitMs = DOWNLOAD_RETRY_BASE_DELAY_MS * attempt;
            if (attempt >= MAX_DOWNLOAD_RETRIES) {
                break;
            }
            log('download', `Attempt ${attempt}/${MAX_DOWNLOAD_RETRIES} failed for ${item.productName || item.id}: ${error.message}. Retrying in ${waitMs}ms`);
            await delay(waitMs);
        }
    }

    throw lastError;
};

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
        downloadFiles = true,
        fetchProductDetails = true,
        forceUpdateWebhook = false
    } = options;
    
    // Persist the latest run output at repo root so the API endpoint `/lastUpdate` returns fresh data
    const dbPath = path.join(__dirname, '..', 'files.json');
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
        // Ensure download directory exists (absolute)
        if (!fs.existsSync(DOWNLOADS_DIR)) {
            fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
        }
        touch(path.join(DOWNLOADS_DIR, 'index.html'));

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
        await delay(randomDelay(500, 1000));

        await persistentSession.navigateWithSession(changelogUrl);

        // Simulate human reading behavior - scroll down a bit
        await delay(randomDelay(1000, 1500));
        await page.evaluate(() => {
            window.scrollTo({ top: 300, behavior: 'smooth' });
        });
        await delay(randomDelay(500, 1000));
        
        // Wait for table to be fully loaded and interactive
        console.log('⏳ Waiting for changelog table to load...');
        const changelogTableSelector = 'table[id^="awcpt-product-table-"]';
        const changelogRowSelector = `${changelogTableSelector} tr.awcpt-row`;

        const tableExists = await waitForElementReady(page, changelogTableSelector, 30000);
        
        if (!tableExists) {
            throw new Error('Changelog table did not load');
        }
        
        console.log('⏳ Table element found, waiting for data rows to load...');
        
        // IMPORTANT: Wait for table rows to be populated (AJAX/JS loaded content)
        // The table exists but rows are loaded dynamically via JavaScript
        let rowsLoaded = false;
        try {
            rowsLoaded = await waitForElementReady(page, changelogRowSelector, 60000);
        } catch (error) {
            // Fallback: Try alternate selectors if tbody structure is different
            console.log('⚠️  Standard row selector failed, trying alternate selector...');
            rowsLoaded = await waitForElementReady(page, changelogRowSelector, 30000);
        }
        
        if (!rowsLoaded) {
            throw new Error('Changelog table rows did not load');
        }
        
        // Extra wait to ensure all dynamic content is loaded
        await randomDelay(1000, 1500);
        
        // Verify rows are actually present
        const rowCount = await page.evaluate(() => {
            return document.querySelectorAll('tr.awcpt-row').length;
        });
        
        console.log(`✅ Changelog table data loaded with ${rowCount} total rows`);
        
        // Normalize start date (midnight) and build a max-5-day window (or up to today)
        const DAY_MS = 24 * 60 * 60 * 1000;
        const MAX_DAYS_PER_RUN = 1;
        const startDate = new Date(date);
        const startTimestamp = new Date(
            startDate.getFullYear(),
            startDate.getMonth(),
            startDate.getDate()
        ).getTime();
        const startDateLabel = startDate.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
        const today = new Date();
        const endOfTodayTimestamp = new Date(
            today.getFullYear(),
            today.getMonth(),
            today.getDate() + 1
        ).getTime();
        const maxWindowEndTimestamp = startTimestamp + (MAX_DAYS_PER_RUN * DAY_MS);
        const endTimestampExclusive = Math.min(maxWindowEndTimestamp, endOfTodayTimestamp);
        const endDateLabel = new Date(endTimestampExclusive - 1).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
        console.log(`📅 Collecting products from ${startDateLabel} through ${endDateLabel} (max ${MAX_DAYS_PER_RUN} days)`);
        
        // Helper to extract product data from the current changelog page (HTML 4 table structure)
        // Returns items within [startTs, endTsExclusive) and whether older dates were encountered (so we can stop paginating)
        const extractProductsSince = async () => {
            return await page.evaluate((startTs, endTsExclusive) => {
            const rows = document.querySelectorAll('tr.awcpt-row');
            const rowDataArray = [];
            let reachedOlder = false;
            
            for (const row of rows) {
                const cells = row.querySelectorAll('td');
                
                // Get date from appropriate cell
                const date = (row.querySelector('.awcpt-date')?.innerText || 
                            row.querySelector('td[class*="date"]')?.innerText || '').trim();
                
                // Parse date and decide whether to include
                let rowTime = null;
                if (date) {
                    rowTime = Date.parse(date);
                    if (!rowTime && typeof date === 'string') {
                        try {
                            rowTime = new Date(date).getTime();
                        } catch (_) {}
                    }
                }
                if (rowTime && rowTime < startTs) {
                    reachedOlder = true;
                    continue;
                }
                if (rowTime && rowTime >= endTsExclusive) {
                    // Too new for this window
                    continue;
                }
                
                if (rowTime && rowTime >= startTs && rowTime < endTsExclusive) {
                
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
                            // Support versions like "v6.2.0.0" and also "4.1.2" (no leading v)
                            const versionMatch =
                                productName.match(/\bv\d+(?:\.\d+){0,4}\b/i) ||
                                productName.match(/\b\d+\.\d+(?:\.\d+){0,3}\b/) ||
                                // Also allow single-number versions like "Product Name 4" (only if at end)
                                productName.match(/\b\d{1,4}\b(?=\s*[\)\]]?\s*$)/);
                            if (versionMatch) {
                                version = versionMatch[0].replace(/^v/i, '');
                                textWithoutVersion = productName
                                    .replace(versionMatch[0], '')
                                    .replace(/\s+/g, ' ')
                                    .trim();
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
                } // end include branch
            }
            
            return { items: rowDataArray, reachedOlder };
        }, startTimestamp, endTimestampExclusive);
        };
        
        const maxPagesToScan = 5;
        let currentPage = 1;
        let data = [];
        
        while (currentPage <= maxPagesToScan) {
            console.log(`📄 Scanning changelog page ${currentPage}/${maxPagesToScan}...`);
            const { items: pageData, reachedOlder } = await extractProductsSince();
            console.log(`➡️  Page ${currentPage} has ${pageData.length} matching products (on/after start date)`);
            data.push(...pageData);
            
            if (reachedOlder) {
                console.log('⏹️  Encountered entries older than start date; stopping pagination.');
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
                await delay(randomDelay(250, 600));
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
            
            await delay(randomDelay(750, 1250));
            
            // Re-wait for the table and rows after pagination
            await waitForElementReady(page, changelogTableSelector, 30000);
            await waitForElementReady(page, changelogRowSelector, 60000)
                .catch(async () => {
                    console.log('⚠️  Row selector failed after pagination, trying alternate selector...');
                    await waitForElementReady(page, changelogRowSelector, 30000);
                });
            
            await page.waitForFunction((previousId) => {
                const firstRow = document.querySelector('tr.awcpt-row');
                if (!firstRow) return false;
                return firstRow.getAttribute('data-id') !== previousId;
            }, { timeout: 10000 }, previousFirstRowId).catch(() => {});
            
            currentPage++;
        }
        
        console.log(`📊 Found ${data.length} products in changelog`);
        
        // Deduplicate to avoid redundant downloads/work
        const deduped = [];
        const seen = new Set();
        data.forEach(item => {
            const key = [item.id, item.slug, item.productURL, item.productName].filter(Boolean).join('|');
            if (!key) return;
            if (seen.has(key)) {
                log('dedupe', `Skipping duplicate entry: ${item.productName || item.id}`);
                return;
            }
            seen.add(key);
            deduped.push(item);
        });
        data = deduped;
        log('dedupe', `Remaining after dedupe: ${data.length}`);
        
        // Skip products that mention "lifetime" in the name
        const containsLifetime = (productName = '') => productName.toLowerCase().includes('lifetime');
        const lifetimeSkipped = data.filter(item => containsLifetime(item.productName));
        if (lifetimeSkipped.length) {
            console.log(`🚫 Skipping ${lifetimeSkipped.length} product(s) containing "lifetime":`);
            lifetimeSkipped.forEach(item => console.log(`   - ${item.productName}`));
        }
        data = data.filter(item => !containsLifetime(item.productName));
        console.log(`📊 Products after "lifetime" filter: ${data.length}`);
        
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

        // Build a cache from the previous run to avoid re-scraping unchanged products
        const previousRecords = Array.isArray(existingData) ? existingData : [];
        const previousByProductURL = new Map();
        const previousBySlug = new Map();
        for (const rec of previousRecords) {
            if (!rec || typeof rec !== 'object') continue;
            if (rec.productURL) previousByProductURL.set(rec.productURL, rec);
            if (rec.slug) previousBySlug.set(rec.slug, rec);
        }

        // In-run cache to prevent duplicate single-page fetches
        const detailsCache = new Map();

        const normalizeText = (value) => {
            return (value ?? '')
                .toString()
                .replace(/\s+/g, ' ')
                .trim();
        };

        const normalizeTextArray = (value) => {
            if (!Array.isArray(value)) return [];
            const cleaned = value.map(v => normalizeText(v)).filter(Boolean);
            // Deduplicate while preserving order
            const seen = new Set();
            const out = [];
            for (const v of cleaned) {
                if (seen.has(v)) continue;
                seen.add(v);
                out.push(v);
            }
            return out;
        };

        const applyDetails = (item, details) => {
            if (!details || typeof details !== 'object') return;
            // Assign even empty values (so we don't keep re-fetching optional fields forever)
            if ('description' in details) item.description = normalizeText(details.description);
            if ('shortDescription' in details) item.shortDescription = normalizeText(details.shortDescription);
            if ('featuredImageUrl' in details) item.featuredImageUrl = normalizeText(details.featuredImageUrl);
            if ('categories' in details) item.categories = normalizeTextArray(details.categories);
            if ('brand' in details) item.brand = normalizeText(details.brand);
            if ('demoUrl' in details) item.demoUrl = normalizeText(details.demoUrl);
        };

        const getPreviousDetailsForItem = (item) => {
            if (!item || typeof item !== 'object') return null;
            const prev = (item.productURL && previousByProductURL.get(item.productURL)) || (item.slug && previousBySlug.get(item.slug));
            if (!prev) return null;
            if (item.version && prev.version && String(item.version) !== String(prev.version)) return null;

            const hasAny =
                ('description' in prev) ||
                ('shortDescription' in prev) ||
                ('featuredImageUrl' in prev) ||
                ('categories' in prev) ||
                ('brand' in prev) ||
                ('demoUrl' in prev);
            if (!hasAny) return null;

            const details = {
                description: normalizeText(prev.description),
                shortDescription: normalizeText(prev.shortDescription),
                featuredImageUrl: normalizeText(prev.featuredImageUrl),
                categories: normalizeTextArray(prev.categories),
                brand: normalizeText(prev.brand),
                demoUrl: normalizeText(prev.demoUrl)
            };
            return details;
        };

        const extractProductDetailsFromCurrentPage = async () => {
            return await page.evaluate(() => {
                const normalize = (s) => (s || '').toString().replace(/\s+/g, ' ').trim();
                const getMeta = (selector) => {
                    const el = document.querySelector(selector);
                    return el ? (el.getAttribute('content') || '').trim() : '';
                };
                const abs = (u) => {
                    const raw = (u || '').toString().trim();
                    if (!raw) return '';
                    try { return new URL(raw, window.location.href).href; } catch (_) { return raw; }
                };
                const pickImgUrl = () => {
                    const img =
                        document.querySelector('figure.woocommerce-product-gallery__wrapper img') ||
                        document.querySelector('.woocommerce-product-gallery__image img') ||
                        document.querySelector('.woocommerce-product-gallery img') ||
                        document.querySelector('img.wp-post-image') ||
                        document.querySelector('img.attachment-shop_single') ||
                        document.querySelector('img.attachment-woocommerce_single');
                    if (img) {
                        const url =
                            img.getAttribute('data-large_image') ||
                            img.getAttribute('data-src') ||
                            img.getAttribute('data-lazy-src') ||
                            img.getAttribute('data-original') ||
                            img.currentSrc ||
                            img.getAttribute('src') ||
                            '';
                        if (url) return url;
                    }
                    return getMeta('meta[property="og:image"]') || getMeta('meta[name="twitter:image"]') || '';
                };

                const shortEl =
                    document.querySelector('.woocommerce-product-details__short-description') ||
                    document.querySelector('.summary .woocommerce-product-details__short-description') ||
                    document.querySelector('.product-short-description') ||
                    document.querySelector('.summary .product-short-description');
                let shortDescription = normalize(shortEl ? shortEl.textContent : '');
                if (!shortDescription) {
                    shortDescription = normalize(getMeta('meta[property="og:description"]') || getMeta('meta[name="description"]'));
                }

                const descEl =
                    document.querySelector('#tab-description') ||
                    document.querySelector('.woocommerce-Tabs-panel--description') ||
                    document.querySelector('.woocommerce-tabs #tab-description') ||
                    document.querySelector('div#tab-description') ||
                    document.querySelector('.product .woocommerce-Tabs-panel');
                const description = normalize(descEl ? descEl.textContent : '');

                const featuredImageUrl = abs(pickImgUrl());

                // Categories (scoped to product meta/summary to avoid nav menus)
                const metaRoot =
                    document.querySelector('.product_meta') ||
                    document.querySelector('.summary') ||
                    document.querySelector('.single-product-summary') ||
                    document.querySelector('.product') ||
                    document.body;

                const uniq = (arr) => {
                    const out = [];
                    const seen = new Set();
                    for (const raw of arr) {
                        const v = normalize(raw);
                        if (!v) continue;
                        if (seen.has(v)) continue;
                        seen.add(v);
                        out.push(v);
                    }
                    return out;
                };

                let categories = [];
                const postedIn = metaRoot.querySelector('.posted_in') || metaRoot.querySelector('span.posted_in');
                if (postedIn) {
                    const links = Array.from(postedIn.querySelectorAll('a'));
                    categories = uniq(links.map(a => a.textContent));
                    if (!categories.length) {
                        const m = (postedIn.textContent || '').match(/categories:\s*(.+)$/i);
                        if (m && m[1]) {
                            categories = uniq(m[1].split(','));
                        }
                    }
                }

                // Brand (from additional information table or from metaRoot text like "Brand: X")
                let brand = '';
                const attributeTables = Array.from(document.querySelectorAll('table.woocommerce-product-attributes, table.shop_attributes'));
                for (const table of attributeTables) {
                    const rows = Array.from(table.querySelectorAll('tr'));
                    for (const row of rows) {
                        const label = normalize(row.querySelector('th')?.textContent || row.querySelector('.woocommerce-product-attributes-item__label')?.textContent);
                        if (!label) continue;
                        if (!/brand/i.test(label)) continue;
                        const value = normalize(row.querySelector('td')?.textContent || row.querySelector('.woocommerce-product-attributes-item__value')?.textContent);
                        if (value) {
                            brand = value;
                            break;
                        }
                    }
                    if (brand) break;
                }
                if (!brand) {
                    const m = (metaRoot.textContent || '').match(/brand:\s*([^\n\r]+?)(?:\s{2,}|$)/i);
                    if (m && m[1]) {
                        // If categories + brand are on the same line, trim at next label if present
                        brand = normalize(m[1]).replace(/license:.*$/i, '').trim();
                    }
                }

                // Developer Live Preview URL
                let demoUrl = '';
                const demoLink = Array.from(metaRoot.querySelectorAll('a')).find(a => /developer\s+live\s+preview/i.test(a.textContent || ''));
                if (demoLink) {
                    demoUrl = demoLink.getAttribute('href') || '';
                }
                demoUrl = abs(demoUrl);

                return { description, shortDescription, featuredImageUrl, categories, brand, demoUrl };
            });
        };

        const ensureProductDetails = async (item) => {
            if (!fetchProductDetails) return { ok: false, usedCache: false, navigated: false };
            if (!item || typeof item !== 'object' || !item.productURL) return { ok: false, usedCache: false, navigated: false };

            // Check undefined to avoid repeatedly re-fetching optional fields that may legitimately be empty
            const needsDetails = () =>
                item.description === undefined ||
                item.shortDescription === undefined ||
                item.featuredImageUrl === undefined ||
                item.categories === undefined ||
                item.brand === undefined ||
                item.demoUrl === undefined;
            if (!needsDetails()) return { ok: true, usedCache: true, navigated: false };

            let usedCache = false;

            // In-run cache
            if (detailsCache.has(item.productURL)) {
                applyDetails(item, detailsCache.get(item.productURL));
                usedCache = true;
                if (!needsDetails()) return { ok: true, usedCache: true, navigated: false };
            }

            // Previous run cache (only if version is unchanged)
            const prevDetails = getPreviousDetailsForItem(item);
            if (prevDetails) {
                detailsCache.set(item.productURL, prevDetails);
                applyDetails(item, prevDetails);
                usedCache = true;
                if (!needsDetails()) return { ok: true, usedCache: true, navigated: false };
            }

            await persistentSession.navigateWithSession(item.productURL);
            await delay(randomDelay(750, 1250));

            // Try to open the description tab (some themes lazy-load panels)
            try {
                const descTabSelector = 'li.description_tab a, a[href="#tab-description"]';
                await page.waitForSelector(descTabSelector, { timeout: 2000 });
                await page.click(descTabSelector);
                await delay(randomDelay(250, 450));
            } catch (_) {}

            const raw = await extractProductDetailsFromCurrentPage();
            const cleaned = {
                description: normalizeText(raw?.description),
                shortDescription: normalizeText(raw?.shortDescription),
                featuredImageUrl: normalizeText(raw?.featuredImageUrl),
                categories: normalizeTextArray(raw?.categories),
                brand: normalizeText(raw?.brand),
                demoUrl: normalizeText(raw?.demoUrl)
            };
            detailsCache.set(item.productURL, cleaned);
            applyDetails(item, cleaned);

            return { ok: true, usedCache, navigated: true };
        };
        
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
                    let onProductPage = false;

                    // Fetch single-product details (description, short description, featured image)
                    if (fetchProductDetails && data[i].productURL) {
                        try {
                            console.log(`🧾 Fetching product details: ${data[i].productURL}`);
                            const detailResult = await ensureProductDetails(data[i]);
                            onProductPage = Boolean(detailResult && detailResult.navigated);
                        } catch (detailError) {
                            console.log(`⚠️  Failed to fetch product details for ${data[i].productName}: ${detailError.message}`);
                            data[i].productDetailsError = detailError.message;
                        }
                    }

                    // If no direct download link, try to construct it from product URL or ID
                    if (!data[i].downloadLink) {
                        // Try to navigate to the product page and find download link
                        if (data[i].productURL) {
                            console.log(`🔍 No direct download link, checking product page: ${data[i].productURL}`);

                            // Use persistent session navigation (maintains login state automatically)
                            if (!onProductPage) {
                                await persistentSession.navigateWithSession(data[i].productURL);
                                onProductPage = true;
                                // Wait for potential download button elements to load
                                await delay(randomDelay(750, 1250));
                            }

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
                    
                    const fileInfo = await downloadWithRetry(data[i], formattedCookies);
                    console.log(`✅ Downloaded: ${fileInfo.filename}`);
                    
                    data[i].filename = fileInfo.filename;
                    data[i].filePath = fileInfo.filePath;
                    data[i].fileUrl = fileInfo.fileUrl;
                    
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
            // If not downloading, optionally enrich with details and return the product data
            if (fetchProductDetails) {
                console.log('\n🧾 Fetching product details from single pages...');
                for (let i = 0; i < data.length; i++) {
                    if (!data[i]?.productURL) continue;
                    try {
                        console.log(`🧾 [${i + 1}/${data.length}] ${data[i].productName}`);
                        await ensureProductDetails(data[i]);
                    } catch (detailError) {
                        console.log(`⚠️  Failed to fetch product details for ${data[i].productName}: ${detailError.message}`);
                        data[i].productDetailsError = detailError.message;
                    }
                    await delay(randomDelay(350, 650));
                }
            }
            list = data;
        }
        
        // Save to database
        db.JSON(list);
        db.sync();
        
        // Generate CSV file
        if (list.length > 0) {
            touch(DATA_CSV_PATH);
            await new Promise((resolve, reject) => {
                convertJsonToCsv(list, DATA_CSV_PATH, (err) => {
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

        // Notify WordPress that data.csv is ready so it can auto-start updating products
        await notifyWordPressDataReady({
            downloadedCount: list.length,
            errorCount: errors.length,
            forceUpdate: forceUpdateWebhook
        });
        
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

// Prevent concurrent runs in a single Node process (avoids shared `persistentSession` race conditions)
let _runQueue = Promise.resolve();
let _runId = 0;

const downloadFromChangelogQueued = async (options = {}) => {
    const runId = ++_runId;
    const dateLabel = (() => {
        try {
            const d = options?.date ? new Date(options.date) : new Date();
            return isNaN(d.getTime()) ? 'invalid-date' : d.toISOString().slice(0, 10);
        } catch (_) {
            return 'unknown-date';
        }
    })();

    const task = async () => {
        console.log(`🧵 [queue] Starting changelog run #${runId} (date=${dateLabel})`);
        return downloadFromChangelog(options);
    };

    const queued = _runQueue.then(task, task);
    // Keep the queue alive even if this run fails
    _runQueue = queued.catch(() => {});
    return queued;
};

module.exports = downloadFromChangelogQueued;
