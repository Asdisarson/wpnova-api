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
            headless: true
        });
        if (!fs.existsSync('./public/downloads/')) {
            fs.mkdirSync('./public/downloads/', {recursive: true});
            touch('index.html');
        }
        // Create a new page
        const page = await browser.newPage();
        page.setDefaultTimeout(0);

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
                    // This determanice date of the update
                    if (theDate === date) {
                        try {
                            const id = row.getAttribute('data-id');
                            const productName = row.querySelector('.awcpt-title').innerText;
                            const downloadLink = row.querySelector('.awcpt-shortcode-wrap a').getAttribute('href');
                            const productURL = row.querySelector('.awcpt-prdTitle-col a').getAttribute('href');

                            // Create an object with the extracted data for each row
                            const rowData = {
                                id,
                                productName,
                                date,
                                downloadLink,
                                productURL, // Add the product URL to the object
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
            
            // Helper function to watch for new files in a directory
            const watchForNewFile = (directoryPath, timeout = 120000) => {
                return new Promise((resolve) => {
                    // Get initial file list
                    const initialFiles = new Set(fs.readdirSync(directoryPath));
                    console.log(`Watching for new files in: ${directoryPath}`);
                    console.log(`Initial files: ${Array.from(initialFiles).join(', ')}`);
                    
                    // Set up watcher
                    const watcher = fs.watch(directoryPath, (eventType, filename) => {
                        if (eventType === 'rename' && filename) {
                            // Check if this is a new file
                            if (!initialFiles.has(filename)) {
                                const fullPath = path.join(directoryPath, filename);
                                
                                // Make sure file exists (wasn't deleted)
                                if (fs.existsSync(fullPath)) {
                                    console.log(`New file detected: ${filename}`);
                                    watcher.close();
                                    resolve({ path: fullPath, filename });
                                }
                            }
                        }
                    });
                    
                    // Set timeout in case no file appears
                    setTimeout(() => {
                        watcher.close();
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
                    
                    const checkFile = setInterval(() => {
                        try {
                            const stats = fs.statSync(filePath);
                            console.log(`File size: ${stats.size} bytes`);
                            
                            if (stats.size === lastSize) {
                                unchangedCount++;
                                
                                // If size hasn't changed for 3 checks, assume download is complete
                                if (unchangedCount >= 3) {
                                    clearInterval(checkFile);
                                    console.log(`File size stable at ${stats.size} bytes, download complete`);
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

                    // Navigate to the download page
                    console.log(`Navigating to download page for ${data[i].productName}...`);
                    await page.goto(data[i].productURL, { waitUntil: 'networkidle2' });
                    
                    // Start watching for new files before clicking the download button
                    const fileWatcherPromise = watchForNewFile(downloadPath);
                    
                    // Find and click the download button
                    console.log(`Looking for download button...`);
                    const downloadButton = await page.waitForSelector(
                        '.download-button, .woocommerce-Button, button.button, a.button, .wp-block-button__link, a[download], a[href*="download"]', 
                        { timeout: 30000 }
                    );
                    
                    // Click the download button
                    console.log(`Clicking download button for ${data[i].productName}...`);
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {}),
                        downloadButton.click()
                    ]);
                    
                    // Wait for a new file to appear in the downloads directory
                    console.log(`Waiting for download to start...`);
                    const newFile = await fileWatcherPromise;
                    
                    if (newFile) {
                        console.log(`Download detected: ${newFile.filename}`);
                        
                        // Wait for the download to complete
                        console.log(`Waiting for download to complete...`);
                        await waitForFileToFinish(newFile.path);
                        
                        // Rename the file if needed
                        const targetFilePath = path.join(downloadPath, filename);
                        if (newFile.path !== targetFilePath) {
                            fs.renameSync(newFile.path, targetFilePath);
                            console.log(`File renamed from ${newFile.filename} to ${filename}`);
                        }
                        
                        // Update the data with file info
                        data[i].filename = filename;
                        data[i].filePath = targetFilePath;
                        data[i].fileUrl = path.join(process.env.DOWNLOAD_URL, filename);
                        
                        console.log(`Download successful: ${data[i].productName}`);
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
                }
            }

            console.log('Downloaded files:', fileCounter);
            console.log('Errors:', errorCounter);
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
