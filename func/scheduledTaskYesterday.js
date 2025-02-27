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

            // Configure download behavior
            const downloadPath = path.resolve('./public/downloads/');
            await page._client.send('Page.setDownloadBehavior', {
                behavior: 'allow',
                downloadPath: downloadPath
            });

            for (let i = 0; i < data.length; i++) {
                console.log(`Processing download ${i + 1} of ${data.length}: ${data[i].productName}...`);
                try {
                    // Extract the slug for filename
                    var modifiedString = data[i].slug.replace(/-download$/, "");
                    modifiedString = data[i].slug.replace(/download-/, "");
                    var filename = `${modifiedString}.zip`;
                    const filePath = path.join('./public/downloads/', filename);

                    // Navigate to the download page
                    console.log(`Navigating to download page for ${data[i].productName}...`);
                    await page.goto(data[i].productURL, { waitUntil: 'networkidle2' });

                    // Find and click the download button
                    console.log(`Looking for download button...`);
                    
                    // Wait for the download button to be available (adjust selector as needed)
                    const downloadButton = await page.waitForSelector('.download-button, .woocommerce-Button, a.button, .wp-block-button__link, a[download], a[href*="download"]', { timeout: 30000 });
                    
                    // Setup file watcher to detect when download starts/completes
                    const fileExistsPromise = new Promise((resolve) => {
                        // Check if the file already exists before we start
                        const preExistingFiles = fs.readdirSync(downloadPath);
                        
                        // Setup a file watcher on the download directory
                        const watcher = fs.watch(downloadPath, (eventType, filename) => {
                            if (eventType === 'rename' && filename) {
                                const fullPath = path.join(downloadPath, filename);
                                
                                // Check if this is a new file
                                if (!preExistingFiles.includes(filename) && fs.existsSync(fullPath)) {
                                    console.log(`Download detected: ${filename}`);
                                    watcher.close();
                                    resolve(fullPath);
                                }
                            }
                        });
                        
                        // Set a timeout in case the download takes too long
                        setTimeout(() => {
                            watcher.close();
                            resolve(null);
                        }, 120000); // 2 minutes timeout
                    });
                    
                    // Click the download button
                    console.log(`Clicking download button for ${data[i].productName}...`);
                    await downloadButton.click();
                    
                    // Wait for the download to be detected
                    console.log(`Waiting for download to start...`);
                    const downloadedPath = await fileExistsPromise;
                    
                    if (downloadedPath) {
                        console.log(`Download detected at: ${downloadedPath}`);
                        
                        // Wait for download to complete (check file size stabilization)
                        await new Promise(resolve => {
                            let lastSize = 0;
                            const checkFileComplete = setInterval(() => {
                                try {
                                    const stats = fs.statSync(downloadedPath);
                                    console.log(`Current file size: ${stats.size} bytes`);
                                    
                                    if (stats.size > 0 && stats.size === lastSize) {
                                        clearInterval(checkFileComplete);
                                        resolve();
                                    }
                                    lastSize = stats.size;
                                } catch (err) {
                                    console.log(`Error checking file: ${err.message}`);
                                }
                            }, 1000); // Check every second
                            
                            // Set a timeout in case the file size check gets stuck
                            setTimeout(() => {
                                clearInterval(checkFileComplete);
                                resolve();
                            }, 60000); // 1 minute timeout
                        });
                        
                        // Rename the file if needed
                        if (path.basename(downloadedPath) !== filename) {
                            fs.renameSync(downloadedPath, filePath);
                            console.log(`File renamed to ${filename}`);
                        }
                        
                        // Update the titles array with the filename and file path
                        data[i].filename = filename;
                        data[i].filePath = filePath;
                        data[i].fileUrl = path.join(process.env.DOWNLOAD_URL, filename);
                        
                        console.log('Download Successful: ', data[i].productName);
                        fileCounter++;
                        list.push(data[i]);
                    } else {
                        throw new Error('Download not detected within timeout period');
                    }
                    
                    // Wait a moment before the next download to avoid overwhelming the server
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
