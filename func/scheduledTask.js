const puppeteer = require('puppeteer');
const JSONdb = require('simple-json-db');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const stream = require('stream');
const {promisify} = require('util');
const pipeline = promisify(stream.pipeline);
const convertJsonToCsv = require('./convertJsonToCsv');
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

const scheduledTask = async (date = new Date()) => {
    const dbPath = path.join(__dirname, 'files.json');
    ensureDirectoryExistence(dbPath);
    const db = new JSONdb(dbPath);
    db.JSON({});
    let list = [];
    let error = [];
    try {
        // Launch Puppeteer browser
        console.log('Launching Puppeteer browser...');
        const browser = await puppeteer.launch({
            headless: process.env.HEADLESS,
            defaultViewport: {
                width: 1920,
                height: 1080
            },
            args: [
                '--start-maximized',
                '--window-size=1920,1080'
            ]
        });

        // Helper function to check if download is complete
        const isDownloadComplete = async (timeout) => {
            const checkInterval = 1000; // Check every second
            const startTime = Date.now();
            
            while (Date.now() - startTime < timeout) {
                // Check the downloads directory
                const files = fs.readdirSync(path.join(process.cwd(), 'public/downloads'));
                const downloadingFiles = files.filter(file => file.endsWith('.crdownload') || file.endsWith('.download'));
                
                if (files.length > 0 && downloadingFiles.length === 0) {
                    // If we have files and none are still downloading, download is complete
                    return true;
                }
                
                // Wait before checking again
                await new Promise(resolve => setTimeout(resolve, checkInterval));
            }
            
            return false;
        };

        if (!fs.existsSync('./public/downloads/')) {
            fs.mkdirSync('./public/downloads/', {recursive: true});
            touch('index.html');
        }

        // Clear downloads directory at start of task
        console.log('Clearing downloads directory at start of task...');
        const downloadDir = path.join(process.cwd(), 'public/downloads');
        const existingFiles = fs.readdirSync(downloadDir);
        for (const file of existingFiles) {
            if (file !== 'index.html') {  // Preserve index.html
                fs.unlinkSync(path.join(downloadDir, file));
            }
        }

        // Create a new page
        const page = await browser.newPage();
        page.setDefaultTimeout(0);

        // Helper function for random delays
        const randomDelay = (min = 500, max = 2000) => {
            const delay = Math.floor(Math.random() * (max - min) + min);
            return new Promise(resolve => setTimeout(resolve, delay));
        };

        // Helper function for human-like typing
        const typeHumanLike = async (selector, text) => {
            await page.focus(selector);
            for (let char of text) {
                await page.type(selector, char, { delay: Math.random() * 200 + 50 });
                await randomDelay(50, 150);
            }
        };

        // Helper function for human-like mouse movement
        const moveMouseHumanLike = async (selector) => {
            const element = await page.$(selector);
            const box = await element.boundingBox();
            
            // Random point near the element
            const x = box.x + box.width / 2 + (Math.random() * 20 - 10);
            const y = box.y + box.height / 2 + (Math.random() * 20 - 10);
            
            await page.mouse.move(x, y, { steps: 25 });
            await randomDelay(100, 300);
        };

        // Set up random user agent
        const userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0'
        ];
        const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
        await page.setUserAgent(randomUserAgent);
        console.log('Using User-Agent:', randomUserAgent);

        try {
            // Go to the front page first since we're being redirected there
            console.log('Going to the front page...');
            await page.goto('https://www.realgpl.com', { waitUntil: 'networkidle0' });
            await randomDelay(2000, 4000);
            
            // Wait for and click the account icon with human-like movement
            console.log('Waiting for account icon...');
            const accountSelector = '.wd-header-my-account.wd-tools-element.wd-event-hover.wd-with-username.wd-design-7.wd-account-style-icon';
            await page.waitForSelector(accountSelector, { visible: true });
            await moveMouseHumanLike(accountSelector);
            await page.click(accountSelector);
            await randomDelay(1000, 2000);

            // Wait for the login form to appear after clicking account icon
            console.log('Waiting for login form...');
            await Promise.all([
                page.waitForSelector('#username', { visible: true, timeout: 30000 }),
                page.waitForSelector('#password', { visible: true, timeout: 30000 })
            ]);
            console.log('Login page fully loaded');
            await randomDelay(1000, 2000);

            try {
                //consent label
                const consentSelector = '.fc-button-label';
                if (await page.$(consentSelector) !== null) {
                    await moveMouseHumanLike(consentSelector);
                    await page.click(consentSelector);
                    await randomDelay(500, 1500);
                }
            } catch (error) {
                console.log('No Consent block')
            }

            var username = process.env.USERNAME;
            var password = process.env.PASSWORD;
            
            // Type credentials with human-like behavior
            console.log('Typing username...');
            await moveMouseHumanLike('#username');
            await typeHumanLike('#username', username.toString());
            await randomDelay(500, 1500);

            console.log('Typing password...');
            await moveMouseHumanLike('#password');
            await typeHumanLike('#password', password.toString());
            await randomDelay(800, 2000);

            // Check for and handle captcha if present
            const hasCaptcha = await page.$('.aiowps-captcha-equation') !== null;
            if (hasCaptcha) {
                console.log('Captcha detected, solving...');
                try {
                    // Get the captcha equation text
                    const captchaText = await page.$eval('.aiowps-captcha-equation strong', el => el.textContent);
                    
                    // Extract the equation parts (e.g., "fourteen − ten = ")
                    const equation = captchaText.split('=')[0].trim();
                    
                    // Convert word numbers to digits
                    const wordToNumber = {
                        'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4,
                        'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9,
                        'ten': 10, 'eleven': 11, 'twelve': 12, 'thirteen': 13,
                        'fourteen': 14, 'fifteen': 15, 'sixteen': 16, 'seventeen': 17,
                        'eighteen': 18, 'nineteen': 19, 'twenty': 20
                    };

                    // Operation mapping
                    const operations = {
                        '−': (a, b) => a - b,
                        '-': (a, b) => a - b,
                        '+': (a, b) => a + b,
                        'plus': (a, b) => a + b,
                        'minus': (a, b) => a - b,
                        'times': (a, b) => a * b,
                        '×': (a, b) => a * b,
                        '*': (a, b) => a * b,
                        'divided by': (a, b) => a / b,
                        '÷': (a, b) => a / b,
                        '/': (a, b) => a / b
                    };

                    // Find which operation is being used
                    let operation;
                    let parts;
                    for (const op of Object.keys(operations)) {
                        if (equation.includes(op)) {
                            operation = op;
                            parts = equation.split(op).map(part => {
                                const word = part.trim().toLowerCase();
                                return wordToNumber[word] !== undefined ? wordToNumber[word] : parseInt(word);
                            });
                            break;
                        }
                    }

                    if (!operation || !parts) {
                        throw new Error('Could not parse equation: ' + equation);
                    }

                    // Calculate the result
                    const result = operations[operation](parts[0], parts[1]);
                    
                    // Input the answer with human-like behavior
                    console.log('Entering captcha solution...');
                    await moveMouseHumanLike('.aiowps-captcha-answer');
                    await typeHumanLike('.aiowps-captcha-answer', Math.round(result).toString());
                    await randomDelay(500, 1500);
                } catch (error) {
                    console.error('Error solving captcha:', error);
                }
            } else {
                console.log('No captcha detected, proceeding with login');
            }

            // Click login button with human-like behavior
            console.log('Clicking login button...');
            await moveMouseHumanLike('.button.woocommerce-button.woocommerce-form-login__submit');
               await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle0' }),
                page.click('.button.woocommerce-button.woocommerce-form-login__submit')
               ]);

            // Wait for successful login
            await page.waitForSelector('.woocommerce-MyAccount-navigation', { timeout: 30000 });
            console.log('Successfully logged in');
            await randomDelay(2000, 4000);

            // Navigate to changelog with human-like behavior
            console.log('Going to the changelog page...');
            await page.goto('https://www.realgpl.com/changelog/', { waitUntil: 'networkidle0' });
            await randomDelay(2000, 4000);
            console.log('Changelog page loaded');

            var theDate = new Date(date).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
            });
            console.log('Looking for entries from:', theDate);

            // Configure Chrome to download files to our downloads directory
            let client;
            try {
                client = await page.target().createCDPSession();
                await client.send('Page.setDownloadBehavior', {
                    behavior: 'allow',
                    downloadPath: path.join(process.cwd(), 'public/downloads')
                });
            } catch (error) {
                console.error('Failed to configure download behavior:', error);
                throw new Error('Download configuration failed');
            }

            let totalDownloads = 0;
            let currentPage = 1;
            let hasMorePages = true;
            const isDevelopment = process.env.NODE_ENV === 'development';
            console.log(`Running in ${isDevelopment ? 'development' : 'production'} mode`);

            while (hasMorePages && (totalDownloads === 0 || !isDevelopment)) {
                console.log(`Processing page ${currentPage}...`);
                
                // Get items from current page
                const items = await page.evaluate((targetDate) => {
                    const rows = Array.from(document.querySelectorAll('tr.awcpt-row'));
                    console.log(`Total rows found: ${rows.length}`); // Debug log
                    const matchingItems = [];

                for (const row of rows) {
                        const dateElement = row.querySelector('.awcpt-date');
                        const dateText = dateElement ? dateElement.innerText.trim() : '';
                        console.log(`Row date: ${dateText}, Target date: ${targetDate}`); // Debug log
                        
                        if (dateElement && dateText === targetDate) {
                            const downloadLinks = Array.from(row.querySelectorAll('.awcpt-shortcode-wrap a'));
                            const titleElement = row.querySelector('.awcpt-title');
                            const productId = row.getAttribute('data-id');
                            
                            console.log(`Product ID: ${productId}, Links found: ${downloadLinks.length}`); // Debug log
                            
                            if (downloadLinks.length > 0 && titleElement) {
                                // Handle multiple download links if present
                                downloadLinks.forEach(downloadLink => {
                                    const isLocked = downloadLink.classList.contains('locked');
                                    console.log(`Link locked status: ${isLocked}`); // Debug log
                                    
                                    // Attempt download regardless of lock status
                                    const linkName = downloadLink.querySelector('.yith-wcmbs-download-button__name')?.innerText?.trim() || '';
                                    matchingItems.push({
                                        id: productId,
                                        productName: titleElement.innerText.trim(),
                                        date: targetDate,
                                        downloadLink: downloadLink.href,
                                        productURL: titleElement.href,
                                        version: titleElement.innerText.match(/v\d+(\.\d+)*/) ? titleElement.innerText.match(/v\d+(\.\d+)*/)[0] : '',
                                        name: linkName,
                                        slug: linkName.toLowerCase().replace(/\s+/g, '-'),
                                        filename: '',
                                        filePath: '',
                                        productId: productId,
                                        fileUrl: downloadLink.href,
                                        isLocked: isLocked
                                    });
                                });
                            }
                        }
                    }
                    console.log(`Total matching items found: ${matchingItems.length}`); // Debug log
                    return matchingItems;
                }, theDate);

                console.log(`Found ${items.length} items on page ${currentPage}`);

                // In development mode, only process one item if we haven't downloaded anything yet
                const itemsToProcess = isDevelopment ? (totalDownloads === 0 ? items : []) : items;
                console.log(`Processing ${itemsToProcess.length} items (${isDevelopment ? 'development mode' : 'production mode'})`);

                // Process each item on the current page
                for (const item of itemsToProcess) {
                    let downloadSuccess = false;
                    let attemptCount = 0;
                    const maxAttempts = 3;

                    while (!downloadSuccess && attemptCount < maxAttempts) {
                        attemptCount++;
                        try {
                            console.log(`Starting download for: ${item.productName} - ${item.name} (Attempt ${attemptCount}/${maxAttempts})`);

                            // Clear downloads directory before each download
                            console.log('Clearing downloads directory before download...');
                            const files = fs.readdirSync(downloadDir);
                            for (const file of files) {
                                if (file !== 'index.html') {
                                    fs.unlinkSync(path.join(downloadDir, file));
                                }
                            }

                            // Simple click and wait approach
                            await page.evaluate((href) => {
                                const link = document.querySelector(`a[href="${href}"]`);
                                if (link) {
                                    link.click();
                                } else {
                                    throw new Error('Download link not found');
                                }
                            }, item.downloadLink);

                            // Wait for download to start
                            console.log('Waiting for download to start...');
                            await randomDelay(5000, 8000);

                            // Monitor the downloads directory
                            let downloadStartTime = Date.now();
                            let downloadComplete = false;
                            let downloadedFileName = null;
                            
                            while (!downloadComplete && (Date.now() - downloadStartTime < 120000)) {
                                const currentFiles = fs.readdirSync(downloadDir);
                                const downloadingFiles = currentFiles.filter(file => file.endsWith('.crdownload') || file.endsWith('.download'));
                                const completedFiles = currentFiles.filter(file => !file.endsWith('.crdownload') && !file.endsWith('.download') && file !== 'index.html');
                                
                                if (completedFiles.length > 0) {
                                    downloadComplete = true;
                                    downloadedFileName = completedFiles[0];
                                    console.log(`Download completed: ${downloadedFileName}`);
                                    
                                    // Create API URL for the file
                                    const apiBaseUrl = 'https://seahorse-app-tx38o.ondigitalocean.app';
                                    const apiDownloadPath = `/downloads/${downloadedFileName}`;
                                    
                                    list.push({
                                        ...item,
                                        filename: downloadedFileName,
                                        filePath: `${apiBaseUrl}${apiDownloadPath}`,
                                        downloadLink: item.downloadLink,
                                        fileUrl: `${apiBaseUrl}${apiDownloadPath}`,
                                        name: item.name,
                                        slug: item.slug,
                                        downloadStatus: 'success',
                                        downloadTime: new Date().toISOString()
                                    });
                                    
                                    downloadSuccess = true;
                                    totalDownloads++;

                                    if (isDevelopment) {
                                        console.log('Development mode: Successfully downloaded one item, stopping further processing');
                                        hasMorePages = false;
                                        break;
                                    }
                                    break;
                                }
                                
                                // Wait a second before checking again
                                await new Promise(resolve => setTimeout(resolve, 1000));
                            }

                            if (!downloadComplete) {
                                throw new Error('Download timeout');
                            }

                            // If in development mode and we've had a successful download, break out
                            if (isDevelopment && downloadSuccess) {
                                break;
                            }

                            // Wait before next download
                            await randomDelay(3000, 5000);

                        } catch (downloadError) {
                            console.error(`Download attempt ${attemptCount} failed for: ${item.productName} - ${item.name}`, downloadError);
                            
                            if (attemptCount < maxAttempts) {
                                console.log(`Retrying download after delay...`);
                                await randomDelay(5000, 10000);
                            } else {
                                console.error(`All download attempts failed for: ${item.productName} - ${item.name}`);
                                error.push({
                                    ...item,
                                    error: downloadError.message || 'Download failed after all attempts',
                                    attempts: attemptCount,
                                    errorTime: new Date().toISOString()
                                });
                            }
                        }
                    }
                    
                    // Break out of the item processing loop if we've had a successful download in development mode
                    if (isDevelopment && downloadSuccess) {
                        break;
                    }
                }

                // Check if this is the last page based on item count
                if (await page.evaluate(() => {
                    const rows = document.querySelectorAll('tr.awcpt-row');
                    return rows.length < 20;
                })) {
                    hasMorePages = false;
                    console.log('Less than 20 items found - this is the last page');
                } else if (isDevelopment && totalDownloads > 0) {
                    hasMorePages = false;
                    console.log('Development mode: Found one item to download, stopping pagination');
                } else {
                    currentPage++;
                    console.log('Moving to next page...');
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'networkidle0' }),
                        page.click('.next.page-numbers')
                    ]);
                    await randomDelay(2000, 4000);
                }
            }

            console.log(`Total successful downloads: ${totalDownloads}`);
            if (error.length > 0) {
                console.log(`Failed downloads: ${error.length}`);
                console.log('Failed items:', error);
            }

            // Schedule cleanup after an hour
            console.log('Scheduling cleanup in one hour...');
            setTimeout(() => {
                console.log('Running scheduled cleanup...');
                const downloadDir = path.join(process.cwd(), 'public/downloads');
                const existingFiles = fs.readdirSync(downloadDir);
                for (const file of existingFiles) {
                    if (file !== 'index.html') {  // Preserve index.html
                        try {
                            fs.unlinkSync(path.join(downloadDir, file));
                            console.log(`Cleaned up file: ${file}`);
                        } catch (err) {
                            console.error(`Error cleaning up file ${file}:`, err);
                        }
                    }
                }
                console.log('Cleanup completed');
            }, 3600000); // 1 hour = 3600000 milliseconds

            // Close the Puppeteer browser
            await browser.close();

            console.log('Browser closed.');
            try{
                touch('error.csv');
                convertJsonToCsv(error, './public/error.csv', (err) => {
                    if (err) {
                        console.error('Error:', err);
                    } else {
                        console.log('CSV file has been saved.');
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
                convertJsonToCsv(list, './public/data.csv', (err) => {
                    if (err) {
                        console.error('Error:', err);
                    } else {
                        console.log('CSV file has been saved.');
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

module.exports = scheduledTask;
