const puppeteer = require('puppeteer');
const JSONdb = require('simple-json-db');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const stream = require('stream');
const {promisify} = require('util');
const pipeline = promisify(stream.pipeline);
const convertJsonToCsv = require('./convertJsonToCsv');
const disk = require('diskusage');
const os = require('os');

// Near the top of the file, add a constant for the download URL with proper path normalization
// This ensures we don't get duplicate /downloads segments
const DOWNLOAD_URL = process.env.DOWNLOAD_URL ? 
    '/' + process.env.DOWNLOAD_URL.replace(/^\/+|\/+$/g, '') : // Remove leading and trailing slashes, then add a single leading slash
    '/downloads';

// Add a universal delay function that works with any Puppeteer version
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Create a download history database to prevent duplicates
const downloadHistoryPath = path.join(__dirname, 'download_history.json');
// Ensure the file exists
if (!fs.existsSync(downloadHistoryPath)) {
    fs.writeFileSync(downloadHistoryPath, JSON.stringify({}));
}
const downloadHistory = new JSONdb(downloadHistoryPath);

// Format bytes to human-readable format (replacement for pretty-bytes)
const formatBytes = (bytes, decimals = 2) => {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

const ensureDirectoryExistence = (filePath) => {
    const dirname = path.dirname(filePath);
    if (fs.existsSync(dirname)) {
        return true;
    }
    ensureDirectoryExistence(dirname);
    fs.mkdirSync(dirname);
}

function touch(filename) {
    try {
        // Check if file exists
        if (!fs.existsSync(filename)) {
            // If not, create an empty file
            fs.writeFileSync(filename, '');
        } else {
            // If it does, update its modification time
            const currentTime = new Date();
            fs.utimesSync(filename, currentTime, currentTime);
        }
    } catch (err) {
        console.error(`Error touching file ${filename}:`, err);
    }
}

// Helper function to watch for new files in a directory
const watchForNewFile = (directoryPath, timeout = 120000) => {
    return new Promise((resolve) => {
        // Get initial file list with timestamps
        const initialFiles = new Map();
        fs.readdirSync(directoryPath).forEach(file => {
            try {
                const filePath = path.join(directoryPath, file);
                if (fs.statSync(filePath).isFile()) {
                    initialFiles.set(file, fs.statSync(filePath).mtimeMs);
                }
            } catch (err) {
                console.error(`Error reading file ${file}:`, err);
            }
        });
        
        console.log(`Watching for new files in: ${directoryPath}`);
        console.log(`Initial file count: ${initialFiles.size}`);
        
        // Track .crdownload files
        const crdownloadFiles = new Set();
        // Track which files we've already logged to prevent duplicate messages
        const loggedFiles = new Set();
        
        // Set up watcher
        const watcher = fs.watch(directoryPath, (eventType, filename) => {
            if (!filename) return;
            
            const fullPath = path.join(directoryPath, filename);
            
            // Check if this is a Chrome temporary download file
            if (filename.endsWith('.crdownload')) {
                // Only log if we haven't seen this file before
                if (!loggedFiles.has(filename)) {
                    console.log(`Chrome download started: ${filename}`);
                    loggedFiles.add(filename);
                    
                    crdownloadFiles.add({
                        tempPath: fullPath,
                        expectedFinalPath: path.join(directoryPath, filename.replace('.crdownload', ''))
                    });
                }
                // Don't resolve yet, wait for the final file
                return;
            }
            
            // For non-crdownload files, check if it's new or modified
            if (eventType === 'rename' || eventType === 'change') {
                try {
                    // Make sure file exists
                    if (!fs.existsSync(fullPath)) return;
                    
                    const stats = fs.statSync(fullPath);
                    if (!stats.isFile()) return;
                    
                    // A file is considered new if:
                    // 1. It wasn't in our initial list
                    // 2. Or it was updated after we started watching
                    const isNew = !initialFiles.has(filename) || 
                                  stats.mtimeMs > initialFiles.get(filename);
                    
                    if (isNew) {
                        console.log(`New/updated file detected: ${filename}`);
                        watcher.close();
                        resolve({ path: fullPath, filename });
                    }
                    
                    // Also check if this is the final file for any .crdownload we've seen
                    for (const crdownload of crdownloadFiles) {
                        if (fullPath === crdownload.expectedFinalPath) {
                            console.log(`Chrome download completed: ${filename}`);
                            watcher.close();
                            resolve({ 
                                path: crdownload.expectedFinalPath, 
                                filename: filename 
                            });
                            return;
                        }
                    }
                } catch (err) {
                    console.error(`Error processing file event for ${filename}:`, err);
                }
            }
        });
        
        // Set timeout in case no file appears
        const timeoutId = setTimeout(() => {
            watcher.close();
            
            // Check if any previously seen .crdownload files completed
            for (const crdownload of crdownloadFiles) {
                if (fs.existsSync(crdownload.expectedFinalPath)) {
                    const finalFilename = path.basename(crdownload.expectedFinalPath);
                    console.log(`Found completed download: ${finalFilename}`);
                    resolve({ 
                        path: crdownload.expectedFinalPath, 
                        filename: finalFilename 
                    });
                    return;
                }
            }
            
            // Do a final check for any new files by comparing against initial list
            try {
                const currentFiles = new Set();
                fs.readdirSync(directoryPath).forEach(file => {
                    try {
                        const filePath = path.join(directoryPath, file);
                        if (fs.statSync(filePath).isFile() && 
                            !file.endsWith('.crdownload') && 
                            !file.endsWith('.tmp') && 
                            !initialFiles.has(file)) {
                            
                            currentFiles.add(file);
                        }
                    } catch (err) {
                        console.error(`Error in final check for ${file}:`, err);
                    }
                });
                
                if (currentFiles.size === 1) {
                    // If exactly one new file, assume it's our download
                    const newFile = [...currentFiles][0];
                    const fullPath = path.join(directoryPath, newFile);
                    console.log(`Found one new file in final check: ${newFile}`);
                    resolve({ path: fullPath, filename: newFile });
                    return;
                } else if (currentFiles.size > 1) {
                    // If multiple new files, log but we can't determine which is ours
                    console.log(`Found ${currentFiles.size} new files in final check, can't determine which is the target`);
                    // Pick the newest file by modification time
                    let newestFile = null;
                    let newestTime = 0;
                    
                    for (const file of currentFiles) {
                        const filePath = path.join(directoryPath, file);
                        try {
                            const stats = fs.statSync(filePath);
                            if (stats.mtimeMs > newestTime) {
                                newestTime = stats.mtimeMs;
                                newestFile = file;
                            }
                        } catch (err) {
                            console.error(`Error checking modification time for ${file}:`, err);
                        }
                    }
                    
                    if (newestFile) {
                        const fullPath = path.join(directoryPath, newestFile);
                        console.log(`Using newest file as download: ${newestFile}`);
                        resolve({ path: fullPath, filename: newestFile });
                        return;
                    }
                }
            } catch (err) {
                console.error(`Error in final file check: ${err.message}`);
            }
            
            console.log(`No new files detected within ${timeout}ms`);
            resolve(null);
        }, timeout);
    });
};

// Helper function to wait for a file to finish downloading
const waitForFileToFinish = async (filePath, checkInterval = 100, timeout = 60000) => {
    return new Promise((resolve) => {
        let lastSize = 0;
        let unchangedCount = 0;
        let startTime = Date.now();
        let lastCheckTime = startTime;
        let speed = 0;
        let totalTime = 0;
        
        const checkFile = setInterval(() => {
            try {
                // Check if file exists before attempting to stat it
                if (!fs.existsSync(filePath)) {
                    console.log(`File no longer exists at path: ${filePath}`);
                    clearInterval(checkFile);
                    resolve(false);
                    return;
                }
                
                const stats = fs.statSync(filePath);
                const currentTime = Date.now();
                const timeDiff = (currentTime - lastCheckTime) / 1000; // in seconds
                const sizeDiff = stats.size - lastSize;
                
                if (timeDiff > 0) {
                    speed = sizeDiff / timeDiff;
                }
                
                totalTime = (currentTime - startTime) / 1000;
                
                // Calculate estimated time remaining if we have a speed
                let eta = 'calculating...';
                if (speed > 0) {
                    const bytesRemaining = 0; // We don't know the total size
                    const timeRemaining = bytesRemaining / speed;
                    if (timeRemaining > 0) {
                        eta = formatTime(timeRemaining);
                    }
                }
                
                console.log(`File: ${path.basename(filePath)}`);
                console.log(`Size: ${formatBytes(stats.size)}`);
                console.log(`Speed: ${formatSpeed(speed)}`);
                console.log(`Time elapsed: ${formatTime(totalTime)}`);
                
                lastCheckTime = currentTime;
                
                if (stats.size === lastSize) {
                    unchangedCount++;
                    
                    // If size hasn't changed for 3 checks, assume download is complete
                    if (unchangedCount >= 3) {
                        clearInterval(checkFile);
                        console.log(`Download complete: ${path.basename(filePath)}`);
                        console.log(`Final size: ${formatBytes(stats.size)}`);
                        console.log(`Total time: ${formatTime(totalTime)}`);
                        console.log(`Average speed: ${formatSpeed(stats.size / totalTime)}`);
                        resolve(true);
                    }
                } else {
                    // Reset counter if size has changed
                    unchangedCount = 0;
                    lastSize = stats.size;
                }
            } catch (err) {
                console.log(`Error checking file: ${err.message}`);
                // If we can't access the file several times, abort
                unchangedCount++;
                if (unchangedCount >= 5) {
                    clearInterval(checkFile);
                    console.log(`Too many errors checking file, assuming download failed`);
                    resolve(false);
                }
            }
        }, checkInterval);
        
        // Set a timeout in case the file size check gets stuck
        setTimeout(() => {
            clearInterval(checkFile);
            console.log(`Timeout reached, assuming download is complete`);
            resolve(false);
        }, timeout);
    });
};

const scheduledTask = async (date = new Date()) => {
    const dbPath = path.join(__dirname, 'files.json');
    ensureDirectoryExistence(dbPath);
    const db = new JSONdb(dbPath);
    db.JSON({});
    let list = [];
    let error = [];
    try {
        // Ensure download directory exists
        const downloadPath = path.resolve('./public/downloads/');
        if (!fs.existsSync(downloadPath)) {
            fs.mkdirSync(downloadPath, { recursive: true });
            touch('index.html');
        }

        // Launch Puppeteer browser
        console.log('Launching Puppeteer browser...');
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            defaultViewport: null,
            // Explicitly set download preferences to prevent using system Downloads folder
            userDataDir: path.join(process.cwd(), 'temp_user_data')
        });

        // Create a new page
        const page = await browser.newPage();
        page.setDefaultTimeout(0);

        // Set download behavior using CDP (Chrome DevTools Protocol)
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: path.resolve('./public/downloads/')
        });

        // Also set download preferences via page.evaluateOnNewDocument
        await page.evaluateOnNewDocument((downloadPath) => {
            // This runs in the browser context
            Object.defineProperty(navigator, 'plugins', {
                get: function() {
                    return {
                        length: 0,
                        refresh: function() {}
                    };
                }
            });
            
            // Try to override Chrome's download settings
            if (window.chrome && chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage({
                    type: 'DOWNLOAD_SETTINGS',
                    downloadPath: downloadPath,
                    prompt: false
                });
            }
        }, path.resolve('./public/downloads/'));

        try {
            // Go to the login page
            console.log('Going to the login page...');
            await page.goto('https://www.realgpl.com/my-account/');

            try {
                //consent label
                await Promise.all([
                    page.click('.fc-button-label'),
                ]);
            } catch (error) {
                console.log('No Consent block')
            }

            var username =  process.env.USERNAME;
            var password = process.env.PASSWORD;
            // Fill in the login credentials
            console.log('Typing username...');

            await page.type('#username',username.toString());

            console.log('Typing password...');
            await page.type('#password',password.toString());

            console.log('Clicking the login button...');
               await Promise.all([
                   page.waitForNavigation(),
                   page.click('.button.woocommerce-button.woocommerce-form-login__submit'),
               ]);

            // Go to the changelog page
            console.log('Going to the changelog page...');
            await page.goto('https://www.realgpl.com/changelog/?99936_results_per_page=250', { waitUntil: 'networkidle2' });
                console.log(date)
            console.log('Changelog page...');

            // Flag to track if we're on the changelog page
            let isOnChangelogPage = true;

            var theDate = new Date(date).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
            });
            console.log(theDate);
            const data = await page.evaluate((theDate) => {
                const rows = document.querySelectorAll('tr.awcpt-row');
                const rowDataArray = [];

                for (const row of rows) {
                    var date = row.querySelector('.awcpt-date').innerText;
                    // This determines date of the update
                    if (theDate === date) {
                        try {
                            // Basic row information
                            const id = row.getAttribute('data-id');
                            const cartIn = row.getAttribute('data-cart-in') || '0';
                            const productName = row.querySelector('.awcpt-title').innerText;
                            const productURL = row.querySelector('.awcpt-prdTitle-col a').getAttribute('href');
                            
                            // Download button information
                            let downloadLink = '';
                            let downloadButtonClass = '';
                            let buttonKey = '';
                            let buttonName = '';
                            let isLocked = true;
                            let isUnlocked = false;
                            
                            // Get download button if available
                            const downloadButton = row.querySelector('.awcpt-shortcode-wrap a.yith-wcmbs-download-button');
                            if (downloadButton) {
                                downloadLink = downloadButton.getAttribute('href') || '';
                                downloadButtonClass = downloadButton.className || '';
                                buttonKey = downloadButton.getAttribute('data-key') || '';
                                buttonName = downloadButton.querySelector('.yith-wcmbs-download-button__name')?.innerText || '';
                                isLocked = downloadButtonClass.includes('locked');
                                isUnlocked = downloadButtonClass.includes('unlocked');
                            }
                            
                            // Check for "not enough credits" message
                            const lockedMessage = row.querySelector('.yith-wcmbs-product-download-box__non-sufficient-credits');
                            const hasInsufficientCredits = !!lockedMessage;

                            // Create an object with the extracted data for each row
                            const rowData = {
                                id,
                                cartIn,
                                productName,
                                date,
                                downloadLink,
                                downloadButtonClass,
                                buttonKey,
                                buttonName,
                                productURL,
                                isLocked,
                                isUnlocked,
                                hasInsufficientCredits,
                                // Initialize these fields to ensure they're always present in the CSV
                                version: '',
                                slug: '',
                                fileUrl: '',
                                filename: '',
                                filePath: ''
                            };

                            rowDataArray.push(rowData);
                        } catch (e) {
                            console.error(e);
                        }
                    }
                }
                return rowDataArray;
            }, theDate);

            console.log('Changelog entries for ', theDate);
            console.log(data);

            // Process each title and extract relevant information
            for (let i = 0; i < data.length; i++) {
                let text = data[i].productName;

                // Extract version
                if (/\d/.test(text)) {
                    let url = '';
                    let versionWithoutV = '';
                    let textWithoutVersion = '';
                    let slug = '';
                    let productId = '';
                    try {
                        // Match version pattern: v1.2.3 or v1.2 or v1
                        let versionMatch = text.match(/v\d+(\.\d+){0,3}/);
                        if (versionMatch) {
                            let version = versionMatch[0];
                            
                            // Remove 'v' from version
                            versionWithoutV = version.replace('v', '');
                            // Remove version from title
                            textWithoutVersion = text.replace(/ v\d+(\.\d+){0,3}/, '');
                        } else {
                            // No version found in the pattern v1.2.3, try looking for numbers
                            let numberMatch = text.match(/\s\d+(\.\d+){0,3}/);
                            if (numberMatch) {
                                versionWithoutV = numberMatch[0].trim();
                                textWithoutVersion = text.replace(numberMatch[0], '');
                            } else {
                                // No version pattern found
                                versionWithoutV = '';
                                textWithoutVersion = text;
                            }
                        }
                    } catch (e) {
                        console.log(`Error extracting version: ${e.message}`);
                        versionWithoutV = '';
                        textWithoutVersion = text;
                    }
                    
                    url = data[i].productURL;
                    try {
                        if (url) {
                            let parsedUrl = new URL(url);
                            url = url.replace(/^\/|\/$/g, '');

                            // Get the last part of the URL after the last slash
                            let parts = url.split('/');
                            slug = parts[parts.length - 1];// Extract the slug from the URL
                            
                            // Clean up the slug - keep only the actual product slug from the Real GPL URL
                            // Remove any query parameters
                            slug = slug.split('?')[0];
                            // Keep the full slug as is, including "download-" prefix - don't modify the product identifier
                            
                            productId = parsedUrl.searchParams.get("product_id");
                        }
                    } catch (e) {
                        console.log(`Error extracting slug: ${e.message}`);
                        // If we can't extract from URL, try to get it from productURL directly
                        if (data[i].productURL) {
                            try {
                                const urlObj = new URL(data[i].productURL);
                                const pathParts = urlObj.pathname.split('/').filter(part => part);
                                if (pathParts.length > 0) {
                                    // Get the last part of the path
                                    slug = pathParts[pathParts.length - 1];
                                    // Clean up the slug - only remove query params, keep the full slug including prefixes
                                    slug = slug.split('?')[0];
                                    // Don't remove "download-" prefix as it's part of the actual slug
                                }
                            } catch (urlErr) {
                                console.log(`Error extracting slug from productURL: ${urlErr.message}`);
                                // Fallback to filename
                                if (data[i].filename) {
                                    slug = data[i].filename.replace(/\.zip$/, '');
                                    console.log(`Using filename-based slug: ${slug}`);
                                } else {
                                    slug = '';
                                }
                            }
                        } else {
                            // As a fallback, create from product name
                            slug = textWithoutVersion.toLowerCase()
                                .replace(/[^\w\s-]/g, '')
                                .replace(/\s+/g, '-')
                                .replace(/-+/g, '-')
                                .replace(/^-+|-+$/g, '');
                        }
                    }
                    
                    // Always set these fields
                    data[i].version = versionWithoutV;
                    data[i].name = textWithoutVersion;
                    data[i].slug = slug;
                    data[i].filename = '';
                    data[i].filePath = '';
                    data[i].fileUrl = '';
                    data[i].productId = productId || '';
                } else {
                    // No version number found, set defaults
                    data[i].version = '';
                    data[i].name = text;
                    
                    // Create a slug from the product name
                    data[i].slug = text.toLowerCase()
                        .replace(/[^\w\s-]/g, '')
                        .replace(/\s+/g, '-')
                        .replace(/-+/g, '-')
                        .replace(/^-+|-+$/g, '');
                        
                    data[i].filename = '';
                    data[i].filePath = '';
                    data[i].fileUrl = '';
                    data[i].productId = '';
                }
            }
            console.log('Data processing completed.');

            // Process each title and download the files
            let fileCounter = 0;
            let errorCounter = 0;
            let skippedFromHistory = 0;
            let totalDownloadedFiles = 0; // Track total downloaded files
            
            // Ensure download directory exists
            const downloadPath = path.resolve('./public/downloads/');
            if (!fs.existsSync(downloadPath)) {
                fs.mkdirSync(downloadPath, { recursive: true });
            }
            
            for (let i = 0; i < data.length; i++) {
                console.log(`Processing download ${i + 1} of ${data.length}: ${data[i].productName}...`);
                try {
                    // Extract the slug for filename
                    var modifiedString = data[i].slug.replace(/-download$/, "");
                    modifiedString = modifiedString.replace(/download-/, "");
                    var filename = `${modifiedString}.zip`;
                    const filePath = path.join('./public/downloads/', filename);
                    
                    // Check if file already exists (to avoid redownloading)
                    if (fs.existsSync(filePath)) {
                        console.log(`File ${filename} already exists, skipping download`);
                        data[i].filename = filename;
                        data[i].filePath = filePath;
                        data[i].fileUrl = `${DOWNLOAD_URL}/${filename}`;
                        fileCounter++;
                        list.push(data[i]);
                        continue;
                    }

                    // Only navigate to changelog page if we're not already there
                    if (!isOnChangelogPage) {
                        console.log(`Navigating to changelog page to find download buttons...`);
                        await page.goto('https://www.realgpl.com/changelog/?99936_results_per_page=250', { waitUntil: 'networkidle2' });
                        isOnChangelogPage = true;
                    } else {
                        console.log(`Already on changelog page, looking for download buttons...`);
                    }
                    
                    // Start watching for new files before clicking the download button
                    const fileWatcherPromise = watchForNewFile(downloadPath);
                    
                    // Find the specific row with the product
                    console.log(`Looking for row with product ID: ${data[i].id}...`);
                    
                    // Click the download button in the specific row
                    const downloadSuccess = await page.evaluate(async (productId) => {
                        // Find the row with the specific data-id
                        const row = document.querySelector(`tr.awcpt-row[data-id="${productId}"]`);
                        if (!row) {
                            return { success: false, error: 'Row not found' };
                        }
                        
                        // Try to find the download button in this row
                        const downloadBtn = row.querySelector('.awcpt-shortcode-wrap a.yith-wcmbs-download-button');
                        if (!downloadBtn) {
                            return { success: false, error: 'Download button not found in row' };
                        }
                        
                        // Check if it's locked or unlocked
                        const isLocked = downloadBtn.classList.contains('locked');
                        const isUnlocked = downloadBtn.classList.contains('unlocked');
                        
                        console.log(`Found button for product ${productId}: Locked: ${isLocked}, Unlocked: ${isUnlocked}`);
                        
                        // Click the button
                        downloadBtn.click();
                        
                        return { 
                            success: true, 
                            locked: isLocked, 
                            unlocked: isUnlocked,
                            href: downloadBtn.getAttribute('href')
                        };
                    }, data[i].id);
                    
                    if (!downloadSuccess || !downloadSuccess.success) {
                        console.error(`Failed to find or click download button: ${downloadSuccess?.error || 'Unknown error'}`);
                        
                        // Try alternate method - direct navigation
                        if (downloadSuccess?.href) {
                            console.log(`Trying direct navigation to: ${downloadSuccess.href}`);
                            await page.goto(downloadSuccess.href, { waitUntil: 'networkidle2' });
                            isOnChangelogPage = false; // We're no longer on the changelog page
                        } else {
                            throw new Error('Download button not found and no href available');
                        }
                    } else {
                        console.log(`Download button clicked successfully. Locked: ${downloadSuccess.locked}, Unlocked: ${downloadSuccess.unlocked}`);
                        isOnChangelogPage = false; // We're no longer on the changelog page after clicking
                        
                        // If it's a locked button, we might need additional steps
                        if (downloadSuccess.locked) {
                            console.log('Processing locked download...');
                            // Wait for any navigation or dialogs that might appear for locked downloads
                            await page.waitForNavigation({ timeout: 100 }).catch(() => {
                                console.log('No navigation occurred after clicking locked button');
                            });
                            
                            // Check for any unlock buttons or forms that might appear
                            const unlockElement = await page.$('button.unlock, a.unlock, input[type="submit"][value*="unlock"]')
                                .catch(() => null);
                            
                            if (unlockElement) {
                                console.log('Found unlock element, clicking it...');
                                await unlockElement.click();
                                await page.waitForNavigation({ timeout: 100 }).catch(() => {});
                            }
                        }
                    }
                    
                    // Wait for a new file to appear in the downloads directory
                    console.log(`Waiting for download to start...`);
                    const newFile = await fileWatcherPromise;
                    
                    if (newFile) {
                        console.log(`Download detected: ${newFile.filename}`);
                        
                        // Get file stats before waiting
                        const beforeStats = fs.statSync(newFile.path);
                        const downloadStartTime = Date.now();
                        
                        // Wait for the download to complete
                        console.log(`Waiting for download to complete...`);
                        await waitForFileToFinish(newFile.path);
                        
                        // Get file stats after download is complete
                        const afterStats = fs.statSync(newFile.path);
                        const downloadEndTime = Date.now();
                        const downloadTime = (downloadEndTime - downloadStartTime) / 1000; // in seconds
                        const downloadSpeed = afterStats.size / downloadTime;
                        
                        console.log(`Download completed in ${formatTime(downloadTime)}`);
                        console.log(`Average download speed: ${formatSpeed(downloadSpeed)}`);
                        
                        // Update download statistics
                        fileCounter++;
                        list.push(data[i]);
                    } else {
                        console.log(`No download detected for ${data[i].productName}`);
                        
                        // Try one more approach - check if there's a direct download link
                        try {
                            console.log(`Looking for direct download link...`);
                            const downloadLink = await page.evaluate(() => {
                                // Try to find a download link
                                const links = Array.from(document.querySelectorAll('a[href*=".zip"], a[href*=".rar"], a[href*=".tar"], a[href*=".gz"]'));
                                return links.length > 0 ? links[0].href : null;
                            });
                            
                            if (downloadLink) {
                                console.log(`Found direct download link: ${downloadLink}`);
                                
                                // Download using Node.js
                                const response = await axios({
                                    url: downloadLink,
                                    method: 'GET',
                                    responseType: 'stream',
                                    headers: {
                                        'User-Agent': await page.evaluate(() => navigator.userAgent)
                                    }
                                });
                                
                                // Create write stream for the file
                                const writer = fs.createWriteStream(filePath);
                                
                                // Pipe download to file and wait for completion
                                await new Promise((resolve, reject) => {
                                    response.data.pipe(writer);
                                    writer.on('finish', resolve);
                                    writer.on('error', reject);
                                });
                                
                                console.log(`Direct download successful: ${data[i].productName}`);
                                
                                // Update the data with file info
                                data[i].filename = filename;
                                data[i].filePath = filePath;
                                // Properly format the download URL to avoid double paths
                                const formattedDownloadUrl = DOWNLOAD_URL.startsWith('/') ? DOWNLOAD_URL : `/${DOWNLOAD_URL}`;
                                data[i].fileUrl = `${formattedDownloadUrl}/${filename}`.replace(/\/+/g, '/');
                                
                                fileCounter++;
                                list.push(data[i]);

                                // We're still not on the changelog page after direct download
                                isOnChangelogPage = false;
                            } else {
                                throw new Error('No direct download link found');
                            }
                        } catch (directErr) {
                            console.error(`Direct download approach failed: ${directErr.message}`);
                            throw new Error('Download not detected and direct download failed');
                        }
                    }
                    
                    // Wait for download to complete
                    await delay(100); // Use universal delay function
                } catch (e) {
                    errorCounter++;
                    console.error(`Failed to download: ${data[i].productName}`);
                    console.error(e);
                    error.push(data[i]);
                    
                    // If we encountered an error, we may not know what page we're on
                    // To be safe, assume we need to navigate back to changelog page
                    isOnChangelogPage = false;
                }
            }

            console.log('Downloaded files:', fileCounter);
            console.log('Errors:', errorCounter);
            // Close the Puppeteer browser
            await browser.close();

            console.log('Browser closed.');
            try{
                touch('error.csv');
                convertJsonToCsv(error, './public/error.csv', (err, errorSummary) => {
                    if (err) {
                        console.error('Error:', err);
                    } else {
                        console.log('Error CSV file has been saved:', errorSummary);
                    }
                });

            }
            catch (err) {
                console.error('An error occurred:');
                console.error(err);
                return err;
            }
            try{
                // Verify all required fields are present
                console.log('Verifying all required fields before CSV generation...');
                list.forEach((item, index) => {
                    // Ensure version is in column 6 (index 5)
                    if (typeof item.version === 'undefined') {
                        console.log(`Adding missing version field for item ${index}`);
                        item.version = '';
                    }
                    
                    // Ensure slug is in column 8 (index 7)
                    if (typeof item.slug === 'undefined' || item.slug === '') {
                        console.log(`Adding missing slug field for item ${index}`);
                        if (item.productURL) {
                            try {
                                // Try to extract slug from product URL
                                const urlObj = new URL(item.productURL);
                                const pathParts = urlObj.pathname.split('/').filter(part => part);
                                if (pathParts.length > 0) {
                                    // Get the last part of the path
                                    slug = pathParts[pathParts.length - 1];
                                    // Clean up the slug - only remove query params, keep the full slug including prefixes
                                    slug = slug.split('?')[0];
                                    // Don't remove "download-" prefix as it's part of the actual slug
                                }
                            } catch (urlErr) {
                                console.log(`Error extracting slug from productURL: ${urlErr.message}`);
                                // Fallback to filename
                                if (item.filename) {
                                    item.slug = item.filename.replace(/\.zip$/, '');
                                    console.log(`Using filename-based slug: ${item.slug}`);
                                } else {
                                    item.slug = '';
                                }
                            }
                        } else if (item.filename) {
                            item.slug = item.filename.replace(/\.zip$/, '');
                            console.log(`Using filename-based slug: ${item.slug}`);
                        } else {
                            item.slug = '';
                        }
                    }
                    
                    // Ensure fileUrl is in column 9 (index 8)
                    if (typeof item.fileUrl === 'undefined') {
                        console.log(`Adding missing fileUrl field for item ${index}`);
                        if (item.filename) {
                            // Properly format the download URL to avoid double paths
                            const formattedDownloadUrl = DOWNLOAD_URL.startsWith('/') ? DOWNLOAD_URL : `/${DOWNLOAD_URL}`;
                            item.fileUrl = `${formattedDownloadUrl}/${item.filename}`.replace(/\/+/g, '/');
                        } else {
                            item.fileUrl = '';
                        }
                    }
                });
                
                db.JSON(list);
                db.sync();
                touch('data.csv');
                convertJsonToCsv(list, './public/data.csv', (err, dataSummary) => {
                    if (err) {
                        console.error('Error:', err);
                    } else {
                        console.log('Data CSV file has been saved:', dataSummary);
                        
                        // Notify plugin.php that the data is ready
                        notifyPluginDataReady(fileCounter, error.length)
                            .then(response => console.log('Plugin notification sent successfully:', response))
                            .catch(err => console.error('Failed to notify plugin:', err));
                    }
                });

            }
            catch (err) {
                console.error('An error occurred:');
                console.error(err);
                return err;
            }
            return list.length

        } catch (err) {
            console.error('An error occurred:');
            console.error(err);
            return err;
        }
    } catch (err) {
        console.error('An error occurred:');
        console.error(err);
        return err;
    }
}

/**
 * Scans the download directory and reports existing files
 * Checks if files exist in the download history
 */
const scanDownloadDirectory = () => {
  const downloadsDir = path.resolve('./public/downloads/');
  
  if (!fs.existsSync(downloadsDir)) {
    console.log('Downloads directory does not exist, creating...');
    fs.mkdirSync(downloadsDir, { recursive: true });
    return { fileCount: 0, totalSize: 0, files: [] };
  }
  
  // Get all files in the directory
  const files = fs.readdirSync(downloadsDir)
    .filter(file => {
      const filePath = path.join(downloadsDir, file);
      // Filter out directories and temp files
      return fs.statSync(filePath).isFile() && 
        !file.startsWith('.') && 
        !file.endsWith('.tmp') &&
        !file.endsWith('.crdownload');
    });
  
  console.log(`Found ${files.length} files in downloads directory`);
  
  if (files.length === 0) {
    return { fileCount: 0, totalSize: 0, files: [] };
  }
  
  let totalSize = 0;
  const fileDetails = [];
  
  // Process each file
  files.forEach(file => {
    const filePath = path.join(downloadsDir, file);
    const stats = fs.statSync(filePath);
    const fileSizeBytes = stats.size;
    totalSize += fileSizeBytes;
    
    // Check if this file is in download history
    const entries = downloadHistory.JSON();
    const matchingEntries = Object.values(entries).filter(entry => 
      entry.filePath === filePath || entry.filename === file
    );
    
    const inHistory = matchingEntries.length > 0;
    const historyInfo = inHistory ? matchingEntries[0] : null;
    
    fileDetails.push({
      filename: file,
      filePath,
      sizeBytes: fileSizeBytes,
      sizeFormatted: formatBytes(fileSizeBytes),
      created: stats.birthtime,
      modified: stats.mtime,
      inHistory,
      historyInfo
    });
  });
  
  // Sort files by size (largest first)
  fileDetails.sort((a, b) => b.sizeBytes - a.sizeBytes);
  
  console.log(`Total size of ${files.length} files: ${formatBytes(totalSize)}`);
  console.log('Files by size (largest first):');
  
  fileDetails.forEach(file => {
    console.log(`${file.filename} (${file.sizeFormatted}) - Created: ${file.created.toISOString()}, Modified: ${file.modified.toISOString()}`);
    console.log(`  In history: ${file.inHistory ? 'Yes' : 'No'}`);
    if (file.inHistory && file.historyInfo) {
      console.log(`  Product: ${file.historyInfo.productName}`);
      console.log(`  Downloaded: ${new Date(file.historyInfo.downloadDate).toISOString()}`);
    }
  });
  
  console.log('--------------------------------------------------');
  
  return { 
    fileCount: files.length, 
    totalSize, 
    totalSizeFormatted: formatBytes(totalSize),
    files: fileDetails
  };
};

/**
 * Clears all files from the downloads directory
 */
const clearDownloadsDirectory = () => {
  const downloadsDir = path.resolve('./public/downloads/');
  
  if (!fs.existsSync(downloadsDir)) {
    console.log('Downloads directory does not exist, creating...');
    fs.mkdirSync(downloadsDir, { recursive: true });
    return;
  }
  
  console.log('Clearing downloads directory...');
  
  // Get all files in the directory
  const files = fs.readdirSync(downloadsDir)
    .filter(file => {
      const filePath = path.join(downloadsDir, file);
      // Filter out directories, system files, and temp files
      return fs.statSync(filePath).isFile() && 
        !file.startsWith('.') && 
        !file.endsWith('.crdownload') &&
        file !== 'index.html'; // Keep index.html
    });
  
  if (files.length === 0) {
    console.log('No files to clear in downloads directory');
    return;
  }
  
  console.log(`Found ${files.length} files to clear from downloads directory`);
  
  // Delete each file
  let deletedCount = 0;
  let errorCount = 0;
  
  files.forEach(file => {
    try {
      const filePath = path.join(downloadsDir, file);
      fs.unlinkSync(filePath);
      console.log(`Deleted: ${file}`);
      deletedCount++;
    } catch (err) {
      console.error(`Error deleting file ${file}:`, err.message);
      errorCount++;
    }
  });
  
  console.log(`Cleared ${deletedCount} files from downloads directory`);
  if (errorCount > 0) {
    console.warn(`Failed to delete ${errorCount} files`);
  }
};

// New function to download all files from the changelog page
const downloadAllFiles = async (date = new Date()) => {
    const dbPath = path.join(__dirname, 'files.json');
    ensureDirectoryExistence(dbPath);
    const db = new JSONdb(dbPath);
    db.JSON({});
    let list = [];
    let error = [];
    let skippedFromHistory = 0;
    let totalDownloadedFiles = 0; // Track total downloaded files
    
    try {
        // Ensure download directory exists
        const downloadPath = path.resolve('./public/downloads/');
        if (!fs.existsSync(downloadPath)) {
            fs.mkdirSync(downloadPath, { recursive: true });
            // Create an index.html file to ensure the directory is browsable
            const indexPath = path.join(downloadPath, 'index.html');
            if (!fs.existsSync(indexPath)) {
                fs.writeFileSync(indexPath, '<html><body><h1>Downloads Directory</h1></body></html>');
            }
        }
        
        // Clear downloads directory at startup
        clearDownloadsDirectory();
        
        // Scan existing files in download directory
        console.log('Scanning download directory for existing files...');
        const directoryReport = scanDownloadDirectory();
        console.log(`Scan complete: Found ${directoryReport.fileCount} files with total size of ${directoryReport.totalSizeFormatted || '0 Bytes'}`);
        
        // Check if we're in development mode
        const isDevelopment = process.env.NODE_ENV === 'development';
        console.log(`Running in ${isDevelopment ? 'DEVELOPMENT' : 'PRODUCTION'} mode`);
        
        // Launch Puppeteer browser
        console.log('Launching Puppeteer browser...');
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            defaultViewport: null,
            // Explicitly set download preferences to prevent using system Downloads folder
            userDataDir: path.join(process.cwd(), 'temp_user_data')
        });
        
        // Create a new page
        const page = await browser.newPage();
        page.setDefaultTimeout(0);
        
        // Set download behavior using CDP (Chrome DevTools Protocol)
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: path.resolve('./public/downloads/')
        });
        
        // Also set download preferences via page.evaluateOnNewDocument
        await page.evaluateOnNewDocument((downloadPath) => {
            // This runs in the browser context
            Object.defineProperty(navigator, 'plugins', {
                get: function() {
                    return {
                        length: 0,
                        refresh: function() {}
                    };
                }
            });
            
            // Try to override Chrome's download settings
            if (window.chrome && chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage({
                    type: 'DOWNLOAD_SETTINGS',
                    downloadPath: downloadPath,
                    prompt: false
                });
            }
        }, path.resolve('./public/downloads/'));
        
        try {
            // Go to the login page
            console.log('Going to the login page...');
            await page.goto('https://www.realgpl.com/my-account/');
            
            try {
                // consent label
                await Promise.all([
                    page.click('.fc-button-label'),
                ]);
            } catch (error) {
                console.log('No Consent block')
            }
            
            var username = process.env.USERNAME;
            var password = process.env.PASSWORD;
            // Fill in the login credentials
            console.log('Typing username...');
            await page.type('#username', username.toString());
            
            console.log('Typing password...');
            await page.type('#password', password.toString());
            
            console.log('Clicking the login button...');
            await Promise.all([
                page.waitForNavigation(),
                page.click('.button.woocommerce-button.woocommerce-form-login__submit'),
            ]);
            
            // Go to the changelog page
            console.log('Going to the changelog page...');
            await page.goto('https://www.realgpl.com/changelog/?99936_results_per_page=250', { waitUntil: 'networkidle2' });
            
            // Format the date for comparison
            var theDate = new Date(date).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
            });
            console.log(`Filtering changelog entries for date: ${theDate}`);
            
            // Extract all rows from the changelog page
            console.log('Extracting rows from changelog page...');
            const allRows = await page.evaluate((targetDate) => {
                const rows = document.querySelectorAll('tr.awcpt-row');
                const rowDataArray = [];
                
                for (const row of rows) {
                    try {
                        const rowDate = row.querySelector('.awcpt-date').innerText;
                        
                        // Filter rows by date
                        if (targetDate === rowDate) {
                            // Basic row information
                            const id = row.getAttribute('data-id');
                            const cartIn = row.getAttribute('data-cart-in') || '0';
                            const productName = row.querySelector('.awcpt-title').innerText;
                            const productURL = row.querySelector('.awcpt-prdTitle-col a').getAttribute('href');
                            
                            // Get all download buttons in this row
                            const downloadBtns = row.querySelectorAll('.awcpt-shortcode-wrap a.yith-wcmbs-download-button');
                            
                            // Check for "not enough credits" message
                            const lockedMessage = row.querySelector('.yith-wcmbs-product-download-box__non-sufficient-credits');
                            const hasInsufficientCredits = !!lockedMessage;
                            
                            // Default values if no buttons are found
                            let hasButtons = downloadBtns.length > 0;
                            let downloadLink = '';
                            let downloadButtonClass = '';
                            let isLocked = true;
                            let isUnlocked = false;
                            
                            // Collect information about all buttons
                            const buttons = [];
                            for (const btn of downloadBtns) {
                                const btnInfo = {
                                    href: btn.getAttribute('href') || '',
                                    className: btn.className || '',
                                    dataKey: btn.getAttribute('data-key') || '',
                                    buttonName: btn.querySelector('.yith-wcmbs-download-button__name')?.innerText || '',
                                    isLocked: btn.classList.contains('locked'),
                                    isUnlocked: btn.classList.contains('unlocked')
                                };
                                buttons.push(btnInfo);
                                
                                // Use the first button for main product information if needed
                                if (buttons.length === 1) {
                                    downloadLink = btnInfo.href;
                                    downloadButtonClass = btnInfo.className;
                                    isLocked = btnInfo.isLocked;
                                    isUnlocked = btnInfo.isUnlocked;
                                }
                            }
                            
                            // Create an object with the extracted data for each row
                            const rowData = {
                                id,
                                cartIn,
                                productName,
                                date: rowDate,
                                productURL,
                                downloadLink,
                                downloadButtonClass,
                                isLocked,
                                isUnlocked,
                                hasInsufficientCredits,
                                hasButtons,
                                multipleButtons: buttons.length > 1,
                                buttonCount: buttons.length,
                                buttons: buttons,
                                // Initialize these fields to ensure they're always present in the CSV
                                version: '',
                                slug: '',
                                fileUrl: '',
                                filename: '',
                                filePath: ''
                            };
                            
                            rowDataArray.push(rowData);
                        }
                    } catch (error) {
                        console.error(`Error processing row: ${error.message}`);
                    }
                }
                
                return rowDataArray;
            }, theDate);
            
            console.log(`Found ${allRows.length} rows in the changelog for date: ${theDate}`);
            
            // Process each row and download the files
            let fileCounter = 0;
            let errorCounter = 0;
            let totalBytesDownloaded = 0;
            
            // Import node.js file system and archiver for zipping files
            const archiver = require('archiver');
            
            // Get initial disk space information
            const initialDiskInfo = await getDiskInfo(downloadPath);
            if (initialDiskInfo) {
                console.log('=== Initial Disk Space Information ===');
                console.log(`Total space: ${initialDiskInfo.totalFormatted}`);
                console.log(`Available space: ${initialDiskInfo.availableFormatted}`);
                console.log(`Used: ${initialDiskInfo.usedPercentage}%`);
                console.log('======================================');
            }
            
            // Display system information
            console.log('=== System Information ===');
            console.log(`Platform: ${os.platform()}`);
            console.log(`Architecture: ${os.arch()}`);
            console.log(`CPU cores: ${os.cpus().length}`);
            console.log(`Total memory: ${formatBytes(os.totalmem())}`);
            console.log(`Free memory: ${formatBytes(os.freemem())}`);
            console.log('=========================');
            
            // Create a summary object to track download statistics
            const downloadStats = {
                startTime: Date.now(),
                totalFiles: 0,
                totalBytes: 0,
                successfulDownloads: 0,
                failedDownloads: 0,
                largestFile: { name: '', size: 0 },
                smallestFile: { name: '', size: Infinity },
                averageFileSize: 0,
                totalDownloadTime: 0,
                averageSpeed: 0
            };
            
            // Limit number of rows in development mode
            const rowsToProcess = isDevelopment ? Math.min(2, allRows.length) : allRows.length;
            if (isDevelopment) {
                console.log(`DEVELOPMENT MODE: Processing only ${rowsToProcess} rows`);
            }
            
            // Flag to track if we're on the changelog page
            let isOnChangelogPage = true;
            
            for (let i = 0; i < rowsToProcess; i++) {
                const row = allRows[i];
                console.log(`Processing download ${i + 1} of ${rowsToProcess}: ${row.productName}...`);
                
                try {
                    // Extract a filename from the product name
                    let slugFromName = row.productName
                        .toLowerCase()
                        .replace(/[^\w\s-]/g, '')
                        .replace(/\s+/g, '-')
                        .replace(/-+/g, '-')
                        .replace(/^-+|-+$/g, '');
                    
                    // Prevent duplicate name parts in filenames
                    const parts = slugFromName.split('-');
                    if (parts.length > 3) {
                        // Check for duplicate segments
                        const uniqueParts = [];
                        const seenParts = new Set();
                        
                        for (const part of parts) {
                            // Only consider substantial parts (longer than 3 chars)
                            if (part.length > 3) {
                                // Check if we've seen this part or a similar one before
                                let isDuplicate = false;
                                for (const seenPart of seenParts) {
                                    if (part.includes(seenPart) || seenPart.includes(part)) {
                                        isDuplicate = true;
                                        break;
                                    }
                                }
                                
                                if (!isDuplicate) {
                                    uniqueParts.push(part);
                                    seenParts.add(part);
                                }
                            } else {
                                // Keep short parts as they might be important connectors
                                uniqueParts.push(part);
                            }
                        }
                        
                        // Only use unique parts if we have enough to make a meaningful name
                        if (uniqueParts.length >= 2) {
                            slugFromName = uniqueParts.join('-');
                        }
                    }
                    
                    // Create a unique identifier for this product
                    const productIdentifier = `${row.id}-${slugFromName}`;
                    
                    // Create a proper filename for the archive
                    const finalArchiveFilename = `${slugFromName}-${row.id}.zip`;
                    const finalArchivePath = path.join(downloadPath, finalArchiveFilename);
                    
                    // Check download history first
                    if (downloadHistory.has(productIdentifier)) {
                        const historyRecord = downloadHistory.get(productIdentifier);
                        console.log(`Product "${row.productName}" was previously downloaded on ${historyRecord.date}`);
                        console.log(`File exists at: ${historyRecord.filePath}`);
                        
                        // Verify the file still exists
                        if (fs.existsSync(historyRecord.filePath)) {
                            console.log(`Skipping download - already in history and file exists`);
                            row.filename = historyRecord.filename;
                            row.filePath = historyRecord.filePath;
                            row.fileUrl = historyRecord.fileUrl;
                            fileCounter++;
                            list.push(row);
                            skippedFromHistory++;
                            continue;
                        } else {
                            console.log(`File in history doesn't exist anymore, will re-download`);
                            // Continue with download since the file is missing
                        }
                    }
                    
                    // Create a temporary directory for downloaded files for this row
                    const tempDirName = `temp-${row.id}-${Date.now()}`;
                    const tempDirPath = path.join(downloadPath, tempDirName);
                    if (!fs.existsSync(tempDirPath)) {
                        fs.mkdirSync(tempDirPath, { recursive: true });
                    }
                    
                    // Array to track downloaded files for this row
                    const downloadedFiles = [];
                    
                    // Navigate directly to the product page instead of the changelog page
                    console.log(`Navigating directly to product page: ${row.productURL}`);
                    await page.goto(row.productURL, { waitUntil: 'networkidle2' });
                    
                    // Use waitFor or waitForTimeout depending on which is available
                    // This ensures compatibility with different Puppeteer versions
                    console.log('Waiting for page to fully load...');
                    await delay(2000); // Use our universal delay function
                    
                    // Process each button in the row ONE AT A TIME
                    for (let b = 0; b < row.buttons.length; b++) {
                        const button = row.buttons[b];
                        const buttonName = button.buttonName || `file-${b+1}`;
                        console.log(`Processing button ${b + 1} of ${row.buttons.length}: ${buttonName}`);
                        
                        // Set up the temporary file name for this button's download
                        const buttonFilename = `${slugFromName}-${buttonName.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-')}.zip`;
                        const buttonFilePath = path.join(tempDirPath, buttonFilename);
                        
                        // Start watching for new files before clicking the download button
                        const fileWatcherPromise = watchForNewFile(downloadPath);
                        
                        // Look for download buttons on the product page - handling both single and multi-button scenarios
                        console.log(`Looking for download buttons on product page for: ${buttonName}...`);
                        const buttonClicked = await page.evaluate((buttonDataKey, buttonName) => {
                            // Log what we're looking for
                            console.log(`Looking for button with data-key: ${buttonDataKey} or name containing: ${buttonName}`);
                            
                            // Try to find buttons by multiple methods
                            const allButtons = document.querySelectorAll('a.yith-wcmbs-download-button');
                            console.log(`Found ${allButtons.length} download buttons on the page`);
                            
                            let targetButton = null;
                            
                            // First try: direct match by data-key (most reliable)
                            if (buttonDataKey) {
                                targetButton = document.querySelector(`a.yith-wcmbs-download-button[data-key="${buttonDataKey}"]`);
                                if (targetButton) {
                                    console.log(`Found button by data-key: ${buttonDataKey}`);
                                }
                            }
                            
                            // Second try: match by name if we have a button name
                            if (!targetButton && buttonName) {
                                // Loop through all buttons to find name matches
                                for (const btn of allButtons) {
                                    const nameElement = btn.querySelector('.yith-wcmbs-download-button__name');
                                    if (nameElement && nameElement.innerText === buttonName) {
                                        targetButton = btn;
                                        console.log(`Found button by exact name: ${buttonName}`);
                                        break;
                                    }
                                    
                                    // Try partial match as fallback
                                    if (nameElement && nameElement.innerText.includes(buttonName)) {
                                        targetButton = btn;
                                        console.log(`Found button by partial name match: ${nameElement.innerText}`);
                                        break;
                                    }
                                }
                            }
                            
                            // Third try: if there's only one button and we haven't found anything, just use that
                            if (!targetButton && allButtons.length === 1) {
                                targetButton = allButtons[0];
                                console.log(`Using the only available button on the page`);
                            }
                            
                            // Fourth try: use any button with similar class name
                            if (!targetButton && buttonDataKey) {
                                // Extract class name from data-key (often they're related)
                                const className = buttonDataKey.split('-')[0];
                                if (className && className.length > 3) {
                                    const classSelector = `a.yith-wcmbs-download-button[class*="${className}"]`;
                                    targetButton = document.querySelector(classSelector);
                                    if (targetButton) {
                                        console.log(`Found button by class name similarity: ${className}`);
                                    }
                                }
                            }
                            
                            // Last resort: just pick a button at index
                            if (!targetButton && allButtons.length > 0) {
                                const index = Math.min(b, allButtons.length - 1);
                                targetButton = allButtons[index];
                                console.log(`Falling back to button at index: ${index}`);
                            }
                            
                            // Click the target button if found
                            if (targetButton) {
                                targetButton.click();
                                return true;
                            }
                            
                            return false;
                        }, button.dataKey, buttonName);
                        
                        if (!buttonClicked) {
                            console.error(`Failed to click download button: ${buttonName}`);
                            continue; // Skip this button but try others
                        }
                        
                        console.log('Download button clicked on product page');
                        
                        // Wait for navigation if needed
                        try {
                            await page.waitForNavigation({ timeout: 5000 });
                        } catch (navErr) {
                            console.log('No navigation occurred or already completed');
                        }
                        
                        // Check for locked download handling
                        const isLocked = await page.evaluate(() => {
                            return document.querySelector('button.unlock, a.unlock, input[type="submit"][value*="unlock"]') !== null;
                        });
                        
                        if (isLocked) {
                            console.log('Processing locked download...');
                            try {
                                await page.click('button.unlock, a.unlock, input[type="submit"][value*="unlock"]');
                                await page.waitForNavigation({ timeout: 10000 }).catch(() => {});
                            } catch (unlockErr) {
                                console.log(`Error unlocking download: ${unlockErr.message}`);
                            }
                        }
                        
                        // Look for direct download links on the page
                        const directDownloadUrl = await page.evaluate(() => {
                            const links = Array.from(document.querySelectorAll('a[href*=".zip"], a[href*=".rar"], a[href*=".tar"], a[href*=".gz"]'));
                            return links.length > 0 ? links[0].href : null;
                        });
                        
                        if (directDownloadUrl) {
                            console.log(`Found direct download link: ${directDownloadUrl}`);
                            try {
                                await page.goto(directDownloadUrl, { timeout: 30000 }).catch(e => {
                                    console.log(`Navigation error (expected for downloads): ${e.message}`);
                                });
                            } catch (dlErr) {
                                console.log(`Error initiating download: ${dlErr.message}`);
                            }
                        }
                        
                        // Wait for download to start and complete
                        console.log(`Waiting for download to complete...`);
                        let downloadedFile = null;
                        
                        try {
                            // Wait for file watcher to detect new files (with timeout)
                            const fileWatchResult = await Promise.race([
                                fileWatcherPromise,
                                delay(120000).then(() => { throw new Error('Download timeout'); }) // Replace the inline Promise
                            ]);
                            
                            if (fileWatchResult && fileWatchResult.path) {
                                downloadedFile = fileWatchResult;
                                console.log(`Download detected: ${downloadedFile.filename}`);
                                
                                // Move the downloaded file to our temp directory with correct name
                                const afterStats = fs.statSync(downloadedFile.path);
                                console.log(`Downloaded file size: ${formatBytes(afterStats.size)}`);
                                
                                fs.renameSync(downloadedFile.path, buttonFilePath);
                                console.log(`Moved file to: ${buttonFilePath}`);
                                
                                // Add to our list of downloaded files for this product
                                downloadedFiles.push({
                                    originalPath: downloadedFile.path,
                                    tempPath: buttonFilePath,
                                    filename: buttonFilename,
                                    buttonName: buttonName,
                                    size: afterStats.size,
                                    sizeFormatted: formatBytes(afterStats.size)
                                });
                                
                                totalDownloadedFiles++;
                            } else {
                                console.log(`No download detected for button ${b+1}`);
                            }
                        } catch (watchErr) {
                            console.error(`Error waiting for download: ${watchErr.message}`);
                        }
                        
                        // Small pause between downloads of the same product
                        console.log('Pausing before next button download...');
                        await delay(3000); // Replace setTimeout with delay function
                    } // End of button loop
                    
                    // After processing all buttons for this product
                    if (downloadedFiles.length > 0) {
                        // Archive all files into a single zip
                        console.log(`Creating archive with ${downloadedFiles.length} files for ${row.productName}...`);
                        
                        // Create a file to stream archive data to
                        const output = fs.createWriteStream(finalArchivePath);
                        const archive = archiver('zip', {
                            zlib: { level: 9 } // Compression level
                        });
                        
                        // Listen for all archive data to be written
                        output.on('close', function() {
                            console.log(`Archive created: ${finalArchiveFilename}, total size: ${archive.pointer()} bytes`);
                        });
                        
                        // Warning event
                        archive.on('warning', function(err) {
                            if (err.code === 'ENOENT') {
                                console.warn('Archive warning:', err);
                            } else {
                                throw err;
                            }
                        });
                        
                        // Error event
                        archive.on('error', function(err) {
                            throw err;
                        });
                        
                        // Pipe archive data to the file
                        archive.pipe(output);
                        
                        // Add each file to the archive
                        for (const file of downloadedFiles) {
                            archive.file(file.tempPath, { name: file.filename });
                        }
                        
                        // Finalize the archive
                        await archive.finalize();
                        
                        // Clean up temp files after archiving
                        console.log('Cleaning up temporary files...');
                        for (const file of downloadedFiles) {
                            if (fs.existsSync(file.tempPath)) {
                                fs.unlinkSync(file.tempPath);
                            }
                        }
                    }
                    
                    // Remove the temp directory
                    if (fs.existsSync(tempDirPath)) {
                        try {
                            fs.rmdirSync(tempDirPath);
                        } catch (rmErr) {
                            console.warn(`Could not remove temp directory: ${rmErr.message}`);
                        }
                    }
                    
                    // Update the row with file info
                    row.filename = finalArchiveFilename;
                    row.filePath = finalArchivePath;
                    // Properly format the download URL to avoid double paths
                    const formattedDownloadUrl = DOWNLOAD_URL.startsWith('/') ? DOWNLOAD_URL : `/${DOWNLOAD_URL}`;
                    row.fileUrl = `${formattedDownloadUrl}/${finalArchiveFilename}`.replace(/\/+/g, '/');
                    row.downloadedFiles = downloadedFiles.length;
                    
                    // Ensure required fields are set even if they weren't extracted earlier
                    if (!row.version && row.productName) {
                        // Try to extract version from product name
                        try {
                            const versionMatch = row.productName.match(/v\d+(\.\d+){0,3}/);
                            if (versionMatch) {
                                row.version = versionMatch[0].replace('v', '');
                            } else {
                                // No version found in the pattern v1.2.3, try looking for numbers
                                const numberMatch = row.productName.match(/\s\d+(\.\d+){0,3}/);
                                if (numberMatch) {
                                    row.version = numberMatch[0].trim();
                                } else {
                                    row.version = ''; // Set empty if no version found
                                }
                            }
                        } catch (e) {
                            row.version = '';
                        }
                    }
                    
                    if (!row.slug) {
                        // Extract slug from productURL, which should be the Real GPL product slug
                        if (row.productURL) {
                            try {
                                const urlObj = new URL(row.productURL);
                                const pathParts = urlObj.pathname.split('/').filter(part => part);
                                if (pathParts.length > 0) {
                                    // Get the last part of the path - this is the exact product slug from Real GPL
                                    let slug = pathParts[pathParts.length - 1];
                                    // Clean up the slug - only remove query params, keep the full slug including prefixes
                                    slug = slug.split('?')[0];
                                    // Don't remove "download-" prefix as it's part of the actual slug
                                    row.slug = slug;
                                    console.log(`Extracted exact product slug '${slug}' from productURL`);
                                } else {
                                    // Fallback to filename
                                    row.slug = finalArchiveFilename.replace(/\.zip$/, '');
                                }
                            } catch (urlErr) {
                                console.log(`Error extracting slug from productURL: ${urlErr.message}`);
                                // Fallback to filename
                                row.slug = finalArchiveFilename.replace(/\.zip$/, '');
                            }
                        } else {
                            // Fallback to filename
                            row.slug = finalArchiveFilename.replace(/\.zip$/, '');
                        }
                    }
                    
                    // Add to download history
                    downloadHistory.set(productIdentifier, {
                        id: row.id,
                        productName: row.productName,
                        filename: finalArchiveFilename,
                        filePath: finalArchivePath,
                        // Properly format the download URL to avoid double paths
                        fileUrl: `${DOWNLOAD_URL.startsWith('/') ? DOWNLOAD_URL : `/${DOWNLOAD_URL}`}/${finalArchiveFilename}`.replace(/\/+/g, '/'),
                        date: new Date().toISOString(),
                        fileSize: fs.statSync(finalArchivePath).size
                    });
                    downloadHistory.sync();
                    
                    console.log(`Download successful for product: ${row.productName}`);
                    fileCounter++;
                    list.push(row);
                } catch (e) {
                    errorCounter++;
                    console.error(`Failed to download: ${row.productName}`);
                    console.error(e);
                    error.push(row);
                }
                
                console.log(`Processed product ${i + 1} of ${rowsToProcess}: ${row.productName}`);
                console.log('------------------------------------------------------');
                
                // If we're not on the last row, don't navigate back to the changelog
                // Simply process the next product directly
                if (i < rowsToProcess - 1) {
                    console.log('Finished with current product, continuing to next product...');
                    
                    // Give a pause between products
                    console.log('Pausing before next product...');
                    await delay(5000); // Replace setTimeout with delay function
                }
            }
            
            // Display final download statistics
            const endTime = Date.now();
            const totalRunTime = (endTime - downloadStats.startTime) / 1000;
            
            console.log('\n=== Download Statistics Summary ===');
            console.log(`Total files downloaded: ${downloadStats.totalFiles}`);
            console.log(`Total data downloaded: ${formatBytes(downloadStats.totalBytes)}`);
            console.log(`Successful downloads: ${downloadStats.successfulDownloads}`);
            console.log(`Failed downloads: ${downloadStats.failedDownloads}`);
            console.log(`Skipped (already in history): ${skippedFromHistory}`);
            
            if (downloadStats.largestFile.name) {
                console.log(`Largest file: ${downloadStats.largestFile.name} (${downloadStats.largestFile.sizeFormatted})`);
            }
            
            if (downloadStats.smallestFile.name) {
                console.log(`Smallest file: ${downloadStats.smallestFile.name} (${downloadStats.smallestFile.sizeFormatted})`);
            }
            
            if (downloadStats.totalFiles > 0) {
                downloadStats.averageFileSize = downloadStats.totalBytes / downloadStats.totalFiles;
                console.log(`Average file size: ${formatBytes(downloadStats.averageFileSize)}`);
            }
            
            if (downloadStats.totalDownloadTime > 0) {
                downloadStats.averageSpeed = downloadStats.totalBytes / downloadStats.totalDownloadTime;
                console.log(`Average download speed: ${formatSpeed(downloadStats.averageSpeed)}`);
            }
            
            console.log(`Total runtime: ${formatTime(totalRunTime)}`);
            
            // Get final disk space information
            const finalDiskInfo = await getDiskInfo(downloadPath);
            if (finalDiskInfo) {
                console.log('\n=== Final Disk Space Information ===');
                console.log(`Total space: ${finalDiskInfo.totalFormatted}`);
                console.log(`Available space: ${finalDiskInfo.availableFormatted}`);
                console.log(`Used: ${finalDiskInfo.usedPercentage}%`);
                
                if (initialDiskInfo) {
                    const spaceUsed = initialDiskInfo.available - finalDiskInfo.available;
                    console.log(`Space used by this session: ${formatBytes(spaceUsed)}`);
                }
                
                console.log('====================================');
            }
            
            console.log('Downloaded files:', fileCounter);
            console.log('Errors:', errorCounter);
            
            // Close the Puppeteer browser
            await browser.close();
            console.log('Browser closed.');
            
            // Save results and errors to files
            try {
                touch('error.csv');
                convertJsonToCsv(error, './public/error.csv', (err, errorSummary) => {
                    if (err) {
                        console.error('Error:', err);
                    } else {
                        console.log('Error CSV file has been saved:', errorSummary);
                    }
                });
            } catch (err) {
                console.error('An error occurred saving error CSV:', err);
            }
            
            try {
                // Verify all required fields are present
                console.log('Verifying all required fields for downloadAllFiles before CSV generation...');
                list.forEach((item, index) => {
                    // Ensure version is in column 6 (index 5)
                    if (typeof item.version === 'undefined') {
                        console.log(`Adding missing version field for item ${index}`);
                        item.version = '';
                    }
                    
                    // Ensure slug is in column 8 (index 7)
                    if (typeof item.slug === 'undefined' || item.slug === '') {
                        console.log(`Adding missing slug field for item ${index}`);
                        if (item.productURL) {
                            try {
                                // Try to extract slug from product URL
                                const urlObj = new URL(item.productURL);
                                const pathParts = urlObj.pathname.split('/').filter(part => part);
                                if (pathParts.length > 0) {
                                    // Get the last part of the path - this is the exact product slug from Real GPL
                                    let slug = pathParts[pathParts.length - 1];
                                    // Clean up the slug - only remove query params, keep the full slug including prefixes
                                    slug = slug.split('?')[0];
                                    // Don't remove "download-" prefix as it's part of the actual slug
                                    item.slug = slug;
                                    console.log(`Extracted exact product slug '${slug}' from productURL`);
                                } else {
                                    // Fallback to filename
                                    item.slug = finalArchiveFilename.replace(/\.zip$/, '');
                                }
                            } catch (urlErr) {
                                console.log(`Error extracting slug from productURL: ${urlErr.message}`);
                                // Fallback to filename
                                item.slug = finalArchiveFilename.replace(/\.zip$/, '');
                            }
                        } else if (item.filename) {
                            item.slug = item.filename.replace(/\.zip$/, '');
                            console.log(`Using filename-based slug: ${item.slug}`);
                        } else {
                            item.slug = '';
                        }
                    }
                    
                    // Ensure fileUrl is in column 9 (index 8)
                    if (typeof item.fileUrl === 'undefined') {
                        console.log(`Adding missing fileUrl field for item ${index}`);
                        if (item.filename) {
                            // Properly format the download URL to avoid double paths
                            const formattedDownloadUrl = DOWNLOAD_URL.startsWith('/') ? DOWNLOAD_URL : `/${DOWNLOAD_URL}`;
                            item.fileUrl = `${formattedDownloadUrl}/${item.filename}`.replace(/\/+/g, '/');
                        } else {
                            item.fileUrl = '';
                        }
                    }
                });
                
                db.JSON(list);
                db.sync();
                touch('data.csv');
                convertJsonToCsv(list, './public/data.csv', (err, dataSummary) => {
                    if (err) {
                        console.error('Error:', err);
                    } else {
                        console.log('Data CSV file has been saved:', dataSummary);
                        
                        // Notify plugin.php that the data is ready
                        notifyPluginDataReady(totalDownloadedFiles, error.length)
                            .then(response => console.log('Plugin notification sent successfully:', response))
                            .catch(err => console.error('Failed to notify plugin:', err));
                    }
                });
            } catch (err) {
                console.error('An error occurred saving data CSV:', err);
            }
            
            // Display final stats
            console.log(`Downloaded ${totalDownloadedFiles} files with ${error.length} errors`);
            console.log(`Skipped ${skippedFromHistory} files (already in download history)`);
            console.log('[+] All done.');
            
            // Return detailed results
            return {
                downloadedCount: totalDownloadedFiles,
                skippedCount: skippedFromHistory,
                successList: list,
                errorList: error,
                directoryReport: directoryReport
            };
        } catch (e) {
            console.error('An error occurred in processing:', e);
            return {
                downloadedCount: 0,
                skippedCount: 0,
                error: e.message,
                directoryReport: null
            };
        } finally {
            if (browser) {
                await browser.close();
            }
        }
    } catch (outerError) {
        console.error('An error occurred launching browser:', outerError);
        return {
            downloadedCount: 0,
            skippedCount: 0,
            error: outerError.message,
            directoryReport: null
        };
    }
};

// Helper function to get disk space information
const getDiskInfo = async (path) => {
    try {
        const info = await disk.check(path);
        return {
            available: info.available,
            free: info.free,
            total: info.total,
            availableFormatted: formatBytes(info.available),
            freeFormatted: formatBytes(info.free),
            totalFormatted: formatBytes(info.total),
            usedPercentage: Math.round((1 - info.available / info.total) * 100)
        };
    } catch (err) {
        console.error(`Error getting disk info: ${err.message}`);
        return null;
    }
};

// Helper function to format download speed
const formatSpeed = (bytesPerSecond) => {
    return `${formatBytes(bytesPerSecond)}/s`;
};

// Helper function to format time
const formatTime = (seconds) => {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${Math.round(seconds % 60)}s`;
};

// Cleanup function to remove temporary Chrome user data directory
const cleanupUserDataDir = () => {
    const userDataDir = path.join(process.cwd(), 'temp_user_data');
    if (fs.existsSync(userDataDir)) {
        try {
            // Use rimraf or similar library for better directory removal in production
            const deleteDirectory = (dirPath) => {
                if (fs.existsSync(dirPath)) {
                    fs.readdirSync(dirPath).forEach((file) => {
                        const curPath = path.join(dirPath, file);
                        if (fs.lstatSync(curPath).isDirectory()) {
                            // Recursive call
                            deleteDirectory(curPath);
                        } else {
                            // Delete file
                            fs.unlinkSync(curPath);
                        }
                    });
                    fs.rmdirSync(dirPath);
                }
            };
            
            deleteDirectory(userDataDir);
            console.log('Temporary user data directory cleaned up');
        } catch (err) {
            console.error('Error cleaning up user data directory:', err);
        }
    }
};

// Add cleanup call before exiting
process.on('exit', cleanupUserDataDir);
process.on('SIGINT', () => {
    cleanupUserDataDir();
    process.exit();
});

// Helper function to notify plugin.php that data processing is complete
const notifyPluginDataReady = async (successCount, errorCount) => {
    try {
        console.log('Triggering product update via WordPress plugin...');
        
        // Construct the URL to plugin.php with proper path resolution
        const pluginUrl = process.env.WORDPRESS_PLUGIN_URL || process.env.PLUGIN_URL || 'https://wpnova.io/wp-content/plugins/wpnova/plugin.php';
        
        if (!pluginUrl.includes('wpnova.io') && !pluginUrl.includes('localhost') && pluginUrl.includes('your-wordpress-site.com')) {
            console.log('WORDPRESS_PLUGIN_URL environment variable not set correctly. Skipping update trigger.');
            return { success: false, skipped: true, error: 'Plugin URL not properly configured' };
        }
        
        // Add timestamp to prevent caching
        const timestamp = new Date().getTime();
        
        console.log(`Sending update trigger to: ${pluginUrl}`);
        const response = await axios.post(pluginUrl, {
            action: 'data_ready',
            timestamp: timestamp
        }, {
            headers: {
                'Content-Type': 'application/json',
                'X-WP-Nova-Api': 'true' // Custom header for authentication if needed
            },
            timeout: 30000 // 30 second timeout
        });
        
        console.log(`Update triggered successfully with status: ${response.status}`);
        console.log(`Response from WordPress: ${JSON.stringify(response.data)}`);
        return response.data;
    }
    catch (error) {
        console.error('Error triggering product update:');
        if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            console.error(`Status: ${error.response.status}`);
            console.error(`Data: ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
            // The request was made but no response was received
            console.error('No response received from server');
        } else {
            // Something happened in setting up the request that triggered an Error
            console.error(`Error message: ${error.message}`);
        }
        
        // Don't throw, just log - we don't want to fail the entire process if update trigger fails
        return { success: false, error: error.message };
    }
};

module.exports = scheduledTask;
module.exports.downloadAllFiles = downloadAllFiles;
