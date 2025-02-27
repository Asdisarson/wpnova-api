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
        
        // Set up watcher
        const watcher = fs.watch(directoryPath, (eventType, filename) => {
            if (!filename) return;
            
            const fullPath = path.join(directoryPath, filename);
            
            // Check if this is a Chrome temporary download file
            if (filename.endsWith('.crdownload')) {
                console.log(`Chrome download started: ${filename}`);
                crdownloadFiles.add({
                    tempPath: fullPath,
                    expectedFinalPath: path.join(directoryPath, filename.replace('.crdownload', ''))
                });
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
                            resolve({ path: fullPath, filename });
                            return;
                        }
                    }
                } catch (err) {
                    console.error(`Error processing file event for ${filename}:`, err);
                }
            }
        });
        
        // Set timeout in case no file appears
        setTimeout(() => {
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
            }
            
            console.log(`No new files detected within ${timeout}ms`);
            resolve(null);
        }, timeout);
    });
};

// Helper function to wait for a file to finish downloading
const waitForFileToFinish = async (filePath, checkInterval = 1000, timeout = 60000) => {
    return new Promise((resolve) => {
        let lastSize = 0;
        let unchangedCount = 0;
        let startTime = Date.now();
        let lastCheckTime = startTime;
        let speed = 0;
        let totalTime = 0;
        
        const checkFile = setInterval(() => {
            try {
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
            await page.goto('https://www.realgpl.com/changelog/?99936_results_per_page=250');
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
                            const id = row.getAttribute('data-id');
                            const productName = row.querySelector('.awcpt-title').innerText;
                            const downloadLink = row.querySelector('.awcpt-shortcode-wrap a').getAttribute('href');
                            const downloadButtonClass = row.querySelector('.awcpt-shortcode-wrap a').className;
                            const productURL = row.querySelector('.awcpt-prdTitle-col a').getAttribute('href');
                            const isLocked = downloadButtonClass.includes('locked');
                            const isUnlocked = downloadButtonClass.includes('unlocked');

                            // Create an object with the extracted data for each row
                            const rowData = {
                                id,
                                productName,
                                date,
                                downloadLink,
                                productURL,
                                isLocked,
                                isUnlocked
                            };

                            rowDataArray.push(rowData); }
                        catch (e) {
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
                        let version = text.match(/v\d+(\.\d+){0,3}/)[0];

                        // Remove 'v' from version
                        versionWithoutV = version.replace('v', '');
                        // Remove version from title
                        textWithoutVersion = text.replace(/ v\d+(\.\d+){0,3}/, '');

                    } catch (e) {
                        console.log(e);
                    }
                    url = data[i].productURL;
                    try {

                        let parsedUrl = new URL(url);
                        url = url.replace(/^\/|\/$/g, '');

                        // Get the last part of the URL after the last slash
                        let parts = url.split('/');
                        slug = parts[parts.length - 1];// Extract the slug from the URL
                        productId = parsedUrl.searchParams.get("product_id");
                    } catch (e) {
                        console.log(e);
                    }// Get the product_id parameter value
                    data[i].version = versionWithoutV;
                    data[i].name = textWithoutVersion;
                    data[i].slug = slug;
                    data[i].filename = '';
                    data[i].filePath = '';
                    data[i].productId = productId;

                }
            }
            console.log('Data processing completed.');

            // Process each title and download the files
            let fileCounter = 0;
            let errorCounter = 0;

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
                        data[i].fileUrl = path.join(process.env.DOWNLOAD_URL, filename);
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
                            await page.waitForNavigation({ timeout: 10000 }).catch(() => {
                                console.log('No navigation occurred after clicking locked button');
                            });
                            
                            // Check for any unlock buttons or forms that might appear
                            const unlockElement = await page.$('button.unlock, a.unlock, input[type="submit"][value*="unlock"]')
                                .catch(() => null);
                            
                            if (unlockElement) {
                                console.log('Found unlock element, clicking it...');
                                await unlockElement.click();
                                await page.waitForNavigation({ timeout: 10000 }).catch(() => {});
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
                                data[i].fileUrl = path.join(process.env.DOWNLOAD_URL, filename);
                                
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
                    
                    // Wait a moment before the next download
                    await page.waitForTimeout(2000);
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
                db.JSON(list);
                db.sync();
                touch('data.csv');
                convertJsonToCsv(list, './public/data.csv', (err, dataSummary) => {
                    if (err) {
                        console.error('Error:', err);
                    } else {
                        console.log('Data CSV file has been saved:', dataSummary);
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
const downloadAllFiles = async () => {
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
            
            // Extract all rows from the changelog page
            console.log('Extracting rows from changelog page...');
            const allRows = await page.evaluate(() => {
                const rows = document.querySelectorAll('tr.awcpt-row');
                const rowDataArray = [];
                
                for (const row of rows) {
                    try {
                        const id = row.getAttribute('data-id');
                        const cartIn = row.getAttribute('data-cart-in');
                        const productName = row.querySelector('.awcpt-title').innerText;
                        const date = row.querySelector('.awcpt-date').innerText;
                        
                        // Get all download buttons in this row
                        const downloadBtns = row.querySelectorAll('.awcpt-shortcode-wrap a.yith-wcmbs-download-button');
                        if (downloadBtns.length === 0) continue; // Skip if no download buttons
                        
                        // Collect information about all buttons
                        const buttons = [];
                        for (const btn of downloadBtns) {
                            buttons.push({
                                href: btn.getAttribute('href'),
                                className: btn.className,
                                dataKey: btn.getAttribute('data-key'),
                                buttonName: btn.querySelector('.yith-wcmbs-download-button__name')?.innerText || '',
                                isLocked: btn.classList.contains('locked'),
                                isUnlocked: btn.classList.contains('unlocked')
                            });
                        }
                        
                        const productURL = row.querySelector('.awcpt-prdTitle-col a').getAttribute('href');
                        
                        // Create an object with the extracted data for each row
                        const rowData = {
                            id,
                            cartIn,
                            productName,
                            date,
                            productURL,
                            multipleButtons: buttons.length > 1,
                            buttonCount: buttons.length,
                            buttons: buttons
                        };
                        
                        rowDataArray.push(rowData);
                    } catch (e) {
                        console.error(`Error processing row: ${e.message}`);
                    }
                }
                
                return rowDataArray;
            });
            
            console.log(`Found ${allRows.length} rows in the changelog`);
            
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
                    const slugFromName = row.productName
                        .toLowerCase()
                        .replace(/[^\w\s-]/g, '')
                        .replace(/\s+/g, '-')
                        .replace(/-+/g, '-')
                        .replace(/^-+|-+$/g, '');
                    
                    // Create a unique identifier for this product
                    const productIdentifier = `${row.id}-${slugFromName}`;
                    
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
                    
                    // Create a unique filename for the final archive
                    const finalArchiveFilename = `${slugFromName}-${row.id}.zip`;
                    const finalArchivePath = path.join(downloadPath, finalArchiveFilename);
                    
                    // Check if archive already exists (to avoid redownloading)
                    if (fs.existsSync(finalArchivePath)) {
                        console.log(`Archive ${finalArchiveFilename} already exists, skipping download`);
                        row.filename = finalArchiveFilename;
                        row.filePath = finalArchivePath;
                        row.fileUrl = `${process.env.DOWNLOAD_URL}/${finalArchiveFilename}`;
                        
                        // Add to download history
                        downloadHistory.set(productIdentifier, {
                            id: row.id,
                            productName: row.productName,
                            filename: finalArchiveFilename,
                            filePath: finalArchivePath,
                            fileUrl: `${process.env.DOWNLOAD_URL}/${finalArchiveFilename}`,
                            date: new Date().toISOString(),
                            fileSize: fs.statSync(finalArchivePath).size
                        });
                        downloadHistory.sync();
                        
                        fileCounter++;
                        list.push(row);
                        continue;
                    }
                    
                    // Create a temporary directory for downloaded files for this row
                    const tempDirName = `temp-${row.id}-${Date.now()}`;
                    const tempDirPath = path.join(downloadPath, tempDirName);
                    if (!fs.existsSync(tempDirPath)) {
                        fs.mkdirSync(tempDirPath, { recursive: true });
                    }
                    
                    // Array to track downloaded files for this row
                    const downloadedFiles = [];
                    
                    // Navigate to the changelog page only if we're not already there
                    if (!isOnChangelogPage) {
                        console.log(`Navigating to changelog page...`);
                        await page.goto('https://www.realgpl.com/changelog/?99936_results_per_page=250', 
                            { waitUntil: 'networkidle2' });
                        isOnChangelogPage = true;
                    } else {
                        console.log(`Already on changelog page, continuing with downloads...`);
                    }
                    
                    // Process each button in the row ONE AT A TIME
                    for (let b = 0; b < row.buttons.length; b++) {
                        const button = row.buttons[b];
                        const buttonName = button.buttonName || `file-${b+1}`;
                        console.log(`Processing button ${b + 1} of ${row.buttons.length}: ${buttonName}`);
                        
                        // Set up the temporary file name for this button's download
                        const buttonFilename = `${slugFromName}-${buttonName.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-')}.zip`;
                        const buttonFilePath = path.join(tempDirPath, buttonFilename);
                        
                        // Make sure we're watching the correct download directory
                        const downloadsDir = path.resolve('./public/downloads/');
                        console.log(`Setting up file watcher for directory: ${downloadsDir}`);
                        
                        // Start watching for new files before clicking the download button
                        const fileWatcherPromise = watchForNewFile(downloadsDir);
                        
                        // Click the specific download button in the row
                        console.log(`Looking for row with product ID: ${row.id} and button ${b+1}...`);
                        const downloadSuccess = await page.evaluate(async (productId, buttonIndex) => {
                            // Find the row with the specific data-id
                            const row = document.querySelector(`tr.awcpt-row[data-id="${productId}"]`);
                            if (!row) {
                                return { success: false, error: 'Row not found' };
                            }
                            
                            // Find all download buttons in this row
                            const downloadBtns = row.querySelectorAll('.awcpt-shortcode-wrap a.yith-wcmbs-download-button');
                            if (downloadBtns.length === 0) {
                                return { success: false, error: 'No download buttons found in row' };
                            }
                            
                            // Get the specified button
                            const downloadBtn = downloadBtns[buttonIndex];
                            if (!downloadBtn) {
                                return { success: false, error: `Button at index ${buttonIndex} not found` };
                            }
                            
                            // Check if it's locked or unlocked
                            const isLocked = downloadBtn.classList.contains('locked');
                            const isUnlocked = downloadBtn.classList.contains('unlocked');
                            const buttonName = downloadBtn.querySelector('.yith-wcmbs-download-button__name')?.innerText || '';
                            const href = downloadBtn.getAttribute('href');
                            
                            console.log(`Found button ${buttonIndex} for product ${productId}: ${buttonName}, Locked: ${isLocked}, Unlocked: ${isUnlocked}`);
                            
                            // Instead of clicking directly, return the href to open in a new tab
                            return { 
                                success: true, 
                                locked: isLocked, 
                                unlocked: isUnlocked,
                                href: href,
                                buttonName: buttonName
                            };
                        }, row.id, b);
                        
                        if (!downloadSuccess || !downloadSuccess.success) {
                            console.error(`Failed to find download button: ${downloadSuccess?.error || 'Unknown error'}`);
                            continue; // Skip this button but try others
                        }
                        
                        // We have a successful button reference, now handle the download
                        if (downloadSuccess.href) {
                            console.log(`Download URL: ${downloadSuccess.href}`);
                            let downloadStarted = false;
                            
                            try {
                                // Try to download directly with the main page first
                                console.log('Attempting download with main page...');
                                
                                // Configure CDP session
                                await client.send('Page.setDownloadBehavior', {
                                    behavior: 'allow',
                                    downloadPath: path.resolve('./public/downloads/')
                                });
                                
                                // Try to click the button on the main page instead of opening a new tab
                                const buttonClicked = await page.evaluate((productId, buttonIndex) => {
                                    // Find the row with the specific data-id
                                    const row = document.querySelector(`tr.awcpt-row[data-id="${productId}"]`);
                                    if (!row) return false;
                                    
                                    // Find all download buttons in this row
                                    const downloadBtns = row.querySelectorAll('.awcpt-shortcode-wrap a.yith-wcmbs-download-button');
                                    if (downloadBtns.length === 0) return false;
                                    
                                    // Get the specified button
                                    const downloadBtn = downloadBtns[buttonIndex];
                                    if (!downloadBtn) return false;
                                    
                                    // Click the button
                                    downloadBtn.click();
                                    return true;
                                }, row.id, b);
                                
                                if (buttonClicked) {
                                    console.log('Download button clicked on main page');
                                    
                                    // Wait for navigation if needed
                                    try {
                                        await page.waitForNavigation({ timeout: 5000 });
                                        isOnChangelogPage = false;
                                    } catch (navErr) {
                                        console.log('No navigation occurred or already completed');
                                    }
                                    
                                    // Check for locked download handling
                                    if (downloadSuccess.locked) {
                                        console.log('Processing locked download...');
                                        const unlockElement = await page.$('button.unlock, a.unlock, input[type="submit"][value*="unlock"]')
                                            .catch(() => null);
                                        
                                        if (unlockElement) {
                                            console.log('Found unlock element, clicking it...');
                                            await unlockElement.click();
                                            await page.waitForNavigation({ timeout: 10000 }).catch(() => {});
                                        }
                                    }
                                    
                                    // Wait for a direct download link to appear
                                    console.log('Looking for direct download link...');
                                    const downloadLink = await page.evaluate(() => {
                                        const links = Array.from(document.querySelectorAll('a[href*=".zip"], a[href*=".rar"], a[href*=".tar"], a[href*=".gz"]'));
                                        return links.length > 0 ? links[0].href : null;
                                    });
                                    
                                    if (downloadLink) {
                                        console.log(`Found direct download link: ${downloadLink}`);
                                        await page.goto(downloadLink, { waitUntil: 'networkidle2' }).catch(e => {
                                            console.log(`Navigation error (expected for downloads): ${e.message}`);
                                        });
                                        downloadStarted = true;
                                    }
                                }
                                
                                // If direct approach didn't work, try axios download as backup
                                if (!downloadStarted) {
                                    console.log('Attempting direct download via axios...');
                                    
                                    try {
                                        const response = await axios({
                                            url: downloadSuccess.href,
                                            method: 'GET',
                                            responseType: 'stream',
                                            headers: {
                                                'User-Agent': await page.evaluate(() => navigator.userAgent),
                                                'Cookie': await page.evaluate(() => document.cookie)
                                            },
                                            maxRedirects: 5,
                                            timeout: 30000
                                        });
                                        
                                        // Create a temp file in the downloads directory
                                        const downloadFilePath = path.join(downloadPath, `temp-download-${Date.now()}.zip`);
                                        const writer = fs.createWriteStream(downloadFilePath);
                                        
                                        // Setup file writing
                                        console.log(`Writing download to: ${downloadFilePath}`);
                                        let downloadedBytes = 0;
                                        
                                        response.data.on('data', (chunk) => {
                                            downloadedBytes += chunk.length;
                                            if (downloadedBytes % 1048576 === 0) { // Log every 1MB
                                                console.log(`Downloaded: ${formatBytes(downloadedBytes)}`);
                                            }
                                        });
                                        
                                        // Pipe download to file and wait for completion
                                        await pipeline(response.data, writer);
                                        console.log(`Direct download complete: ${formatBytes(downloadedBytes)}`);
                                        
                                        // Create an artificial file event
                                        const fakePath = downloadFilePath;
                                        const fakeFilename = path.basename(downloadFilePath);
                                        
                                        // Move to the correct location with the right name
                                        fs.renameSync(fakePath, buttonFilePath);
                                        
                                        // Add to downloaded files list
                                        downloadedFiles.push({
                                            originalPath: fakePath,
                                            tempPath: buttonFilePath,
                                            filename: buttonFilename,
                                            buttonName: buttonName,
                                            size: fs.statSync(buttonFilePath).size,
                                            sizeFormatted: formatBytes(fs.statSync(buttonFilePath).size)
                                        });
                                        
                                        downloadStarted = true;
                                        totalDownloadedFiles++;
                                        
                                        // Go back to changelog page
                                        console.log('Navigating back to changelog page...');
                                        await page.goto('https://www.realgpl.com/changelog/?99936_results_per_page=250', 
                                            { waitUntil: 'networkidle2' });
                                        isOnChangelogPage = true;
                                        
                                        // Skip watching for files since we handled it directly
                                        continue;
                                    } catch (axiosErr) {
                                        console.error(`Axios download failed: ${axiosErr.message}`);
                                    }
                                }
                                
                                // If both approaches failed, try one more with a new tab
                                if (!downloadStarted) {
                                    console.log(`Opening download link in new tab as last resort: ${downloadSuccess.href}`);
                                    
                                    // Open a new tab with the download URL
                                    const newPage = await browser.newPage();
                                    
                                    // Configure download settings for the new tab
                                    const newClient = await newPage.target().createCDPSession();
                                    await newClient.send('Page.setDownloadBehavior', {
                                        behavior: 'allow',
                                        downloadPath: path.resolve('./public/downloads/')
                                    });
                                    
                                    // Enable request interception for better handling
                                    await newPage.setRequestInterception(true);
                                    newPage.on('request', async (request) => {
                                        // If it's a download type, don't abort
                                        if (request.resourceType() === 'document' || 
                                            request.resourceType() === 'fetch' || 
                                            request.resourceType() === 'xhr') {
                                            request.continue();
                                        } else if (
                                            request.url().includes('.zip') || 
                                            request.url().includes('.rar') || 
                                            request.url().includes('.gz')) {
                                            console.log(`Detected download URL: ${request.url()}`);
                                            request.continue();
                                        } else {
                                            request.continue();
                                        }
                                    });
                                    
                                    try {
                                        // Navigate to the download URL in the new tab with a longer timeout
                                        await newPage.goto(downloadSuccess.href, { 
                                            waitUntil: 'networkidle2', 
                                            timeout: 60000 
                                        });
                                        
                                        // If it's a locked button, handle the unlock process
                                        if (downloadSuccess.locked) {
                                            console.log('Processing locked download in new tab...');
                                            const unlockElement = await newPage.$('button.unlock, a.unlock, input[type="submit"][value*="unlock"]')
                                                .catch(() => null);
                                            
                                            if (unlockElement) {
                                                console.log('Found unlock element in new tab, clicking it...');
                                                await unlockElement.click();
                                                await newPage.waitForNavigation({ timeout: 10000 }).catch(() => {});
                                            }
                                        }
                                        
                                        // Look for direct download links
                                        const directLinks = await newPage.evaluate(() => {
                                            const links = Array.from(document.querySelectorAll('a[href*=".zip"], a[href*=".rar"], a[href*=".tar"], a[href*=".gz"]'));
                                            return links.map(l => l.href);
                                        });
                                        
                                        if (directLinks.length > 0) {
                                            console.log(`Found ${directLinks.length} direct download links in new tab`);
                                            for (const link of directLinks) {
                                                console.log(`Clicking direct download link: ${link}`);
                                                await newPage.goto(link, { timeout: 30000 }).catch(e => {
                                                    console.log(`Expected navigation error for download: ${e.message}`);
                                                });
                                                break; // Just try the first link
                                            }
                                        }
                                        
                                        // Wait a longer time for download to start
                                        console.log('Waiting longer for download to initiate...');
                                        await newPage.waitForTimeout(10000);
                                        
                                        // Keep the tab open longer to ensure download starts
                                        console.log('Keeping tab open to ensure download starts...');
                                        await newPage.waitForTimeout(5000);
                                        
                                        // Close the tab after allowing download to start
                                        await newPage.close();
                                        
                                    } catch (tabError) {
                                        console.error(`Error in new tab: ${tabError.message}`);
                                        await newPage.close();
                                        // Continue to file watcher to see if download started anyway
                                    }
                                }
                                
                                // Wait for a new file to appear in the downloads directory
                                console.log(`Waiting for download to start or complete...`);
                                const newFile = await fileWatcherPromise;
                                
                                if (newFile) {
                                    console.log(`Download detected: ${newFile.filename}`);
                                    
                                    // Get file stats before waiting
                                    const beforeStats = fs.statSync(newFile.path);
                                    const downloadStartTime = Date.now();
                                    
                                    // Wait for the download to complete
                                    console.log(`Waiting for download to complete...`);
                                    await waitForFileToFinish(newFile.path);
                                    
                                    // Process the downloaded file
                                    const afterStats = fs.statSync(newFile.path);
                                    const downloadEndTime = Date.now();
                                    const downloadTime = (downloadEndTime - downloadStartTime) / 1000; // in seconds
                                    const downloadSpeed = afterStats.size / downloadTime;
                                    
                                    console.log(`Download completed in ${formatTime(downloadTime)}`);
                                    console.log(`Average download speed: ${formatSpeed(downloadSpeed)}`);
                                    
                                    // Update download statistics
                                    downloadStats.totalFiles++;
                                    downloadStats.totalBytes += afterStats.size;
                                    downloadStats.successfulDownloads++;
                                    downloadStats.totalDownloadTime += downloadTime;
                                    totalDownloadedFiles++;
                                    
                                    if (afterStats.size > downloadStats.largestFile.size) {
                                        downloadStats.largestFile = { 
                                            name: newFile.filename, 
                                            size: afterStats.size,
                                            sizeFormatted: formatBytes(afterStats.size)
                                        };
                                    }
                                    
                                    if (afterStats.size < downloadStats.smallestFile.size) {
                                        downloadStats.smallestFile = { 
                                            name: newFile.filename, 
                                            size: afterStats.size,
                                            sizeFormatted: formatBytes(afterStats.size)
                                        };
                                    }
                                    
                                    // Move the file to temp directory with a unique name
                                    fs.renameSync(newFile.path, buttonFilePath);
                                    console.log(`File moved to: ${buttonFilePath}`);
                                    
                                    // Add to downloaded files list
                                    downloadedFiles.push({
                                        originalPath: newFile.path,
                                        tempPath: buttonFilePath,
                                        filename: buttonFilename,
                                        buttonName: button.buttonName || `file-${b+1}`,
                                        size: afterStats.size,
                                        sizeFormatted: formatBytes(afterStats.size),
                                        downloadTime: downloadTime,
                                        downloadSpeed: downloadSpeed,
                                        downloadSpeedFormatted: formatSpeed(downloadSpeed)
                                    });
                                    
                                    // Update total bytes downloaded
                                    totalBytesDownloaded += afterStats.size;
                                    
                                    // Show current disk space
                                    const currentDiskInfo = await getDiskInfo(downloadPath);
                                    if (currentDiskInfo) {
                                        console.log('=== Current Disk Space ===');
                                        console.log(`Available: ${currentDiskInfo.availableFormatted}`);
                                        console.log(`Used: ${currentDiskInfo.usedPercentage}%`);
                                        console.log('========================');
                                    }
                                } else {
                                    console.log(`No download detected for button ${b+1}`);
                                }
                                
                            } catch (downloadErr) {
                                console.error(`Error during download: ${downloadErr.message}`);
                            }
                            
                            // Ensure we're back on the changelog page for next download
                            if (!isOnChangelogPage) {
                                console.log('Navigating back to changelog page...');
                                await page.goto('https://www.realgpl.com/changelog/?99936_results_per_page=250', 
                                    { waitUntil: 'networkidle2' });
                                isOnChangelogPage = true;
                            }
                        } else {
                            console.error(`No href found for button ${b+1}, skipping`);
                            continue;
                        }
                        
                        // Give a small pause between downloads
                        console.log('Pausing before next download...');
                        await new Promise(resolve => setTimeout(resolve, 3000));
                    }
                    
                    // Check if we have at least one downloaded file
                    if (downloadedFiles.length === 0) {
                        throw new Error('No files were successfully downloaded for this row');
                    }
                    
                    // If we only have one file, just rename it to the final filename
                    if (downloadedFiles.length === 1) {
                        fs.renameSync(downloadedFiles[0].tempPath, finalArchivePath);
                        console.log(`Single file renamed to: ${finalArchiveFilename}`);
                    } else {
                        // Create a zip archive with all downloaded files
                        console.log(`Creating zip archive for ${downloadedFiles.length} files...`);
                        
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
                    row.fileUrl = `${process.env.DOWNLOAD_URL}/${finalArchiveFilename}`;
                    row.downloadedFiles = downloadedFiles.length;
                    
                    // Add to download history
                    downloadHistory.set(productIdentifier, {
                        id: row.id,
                        productName: row.productName,
                        filename: finalArchiveFilename,
                        filePath: finalArchivePath,
                        fileUrl: `${process.env.DOWNLOAD_URL}/${finalArchiveFilename}`,
                        date: new Date().toISOString(),
                        fileSize: fs.existsSync(finalArchivePath) ? fs.statSync(finalArchivePath).size : 0
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
                db.JSON(list);
                db.sync();
                touch('data.csv');
                convertJsonToCsv(list, './public/data.csv', (err, dataSummary) => {
                    if (err) {
                        console.error('Error:', err);
                    } else {
                        console.log('Data CSV file has been saved:', dataSummary);
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

module.exports = scheduledTask;
module.exports.downloadAllFiles = downloadAllFiles;
