const { 
    createRegularBrowser, 
    navigateWithRetry, 
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

const scheduledTask = async () => {
    const dbPath = path.join(__dirname, 'files.json');
    ensureDirectoryExistence(dbPath);
    const db = new JSONdb(dbPath);
    db.JSON({});
    let list = [];
    try {
        // Launch regular Puppeteer browser (no Cloudflare/browserless)
        console.log('Launching regular Puppeteer browser...');
        const { browser, page } = await createRegularBrowser();
        
        // Add human-like behavior
        await addHumanLikeBehavior(page);
        
        if (!fs.existsSync('./public/downloads/')) {
            fs.mkdirSync('./public/downloads/', {recursive: true});
            touch('index.html');
        }
        
        page.setDefaultTimeout(0);

        try {
            // Go to the login page
            console.log('Going to the login page...');
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

            var username =  process.env.USERNAME;
            var password = process.env.PASSWORD;
            
            // Wait for login form to be ready
            await waitForElementReady(page, '#username');
            await waitForElementReady(page, '#password');
            
            // Fill in the login credentials
            console.log('Typing username...');
            await page.type('#username',username.toString());

            console.log('Typing password...');
            await page.type('#password',password.toString());
            
            // Wait for login button to be ready before clicking
            await waitForElementReady(page, '.button.woocommerce-button.woocommerce-form-login__submit');
            
            // Click the login button and wait for navigation
            console.log('Clicking the login button...');
            
            // Click the login button and wait for either navigation or DOM changes
            await page.click('.button.woocommerce-button.woocommerce-form-login__submit');
            
            // Wait for login success indicators with a race condition
            try {
                await Promise.race([
                    // Option 1: Wait for navigation
                    page.waitForNavigation({ timeout: 60000, waitUntil: ['load', 'domcontentloaded'] }),
                    // Option 2: Wait for account navigation menu to appear (indicates successful login)
                    page.waitForSelector('.woocommerce-MyAccount-navigation', { timeout: 60000 }),
                    // Option 3: Wait for account content
                    page.waitForSelector('.woocommerce-account', { timeout: 60000 })
                ]);
                console.log('✅ Successfully logged in');
            } catch (error) {
                // Final verification: check if we're logged in by examining the page
                console.log('⚠️  Login wait timed out, performing final verification...');
                await delay(randomDelay(2000, 3000)); // Give page time to settle
                
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
            
            // Additional wait to ensure login is complete
            await delay(randomDelay(2000, 4000));

            // Go to the changelog page
            console.log('Going to the changelog page...');
            await navigateWithRetry(page, 'https://www.realgpl.com/changelog/?99936_results_per_page=500');

            // Wait for changelog table to be fully loaded
            await waitForElementReady(page, 'tr.awcpt-row', 30000);

            // Get the links of the changelog entrie
            const today = new Date().toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
            });
            const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
            });

            // Extract data from rows matching today or yesterday's date
            const data = await page.evaluate((today, yesterday) => {
                const rows = document.querySelectorAll('tr.awcpt-row');
                const rowDataArray = [];

                for (const row of rows) {
                    const date = row.querySelector('.awcpt-date').innerText;
                    // This determanice date of the update
                    if (date === today) {
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

                        rowDataArray.push(rowData);
                    }
                }

                return rowDataArray;
            }, today, yesterday);

            console.log('Changelog entries for today');
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
                        // Support versions like "v6.2.0.0" and also "4.1.2" (no leading v)
                        const versionMatch =
                            text.match(/\bv\d+(?:\.\d+){0,4}\b/i) ||
                            text.match(/\b\d+\.\d+(?:\.\d+){0,3}\b/) ||
                            // Also allow single-number versions like "Product Name 4" (only if at end)
                            text.match(/\b\d{1,4}\b(?=\s*[\)\]]?\s*$)/);

                        if (versionMatch) {
                            const version = versionMatch[0];
                            versionWithoutV = version.replace(/^v/i, '');
                            textWithoutVersion = text
                                .replace(version, '')
                                .replace(/\s+/g, ' ')
                                .trim();
                        } else {
                            versionWithoutV = '';
                            textWithoutVersion = text;
                        }

                    } catch (e) {
                        console.log(e);
                        versionWithoutV = '';
                        textWithoutVersion = text;
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

            for (let i = 0; i < data.length; i++) {
                console.log(`Starting download for file ${i + 1} of ${data.length}...`);
                try {
                    // Get cookies from Browserless
                    const cookies = await getCookies(page);

                    // Format cookies for axios
                    const formattedCookies = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

                    // Use axios to download the file
                    const response = await axios({
                        url: data[i].downloadLink,
                        method: 'GET',
                        responseType: 'stream',
                        headers: {
                            Cookie: formattedCookies
                        }
                    });
                    // Extract the filename from the URL
                    var modifiedString = data[i].slug.replace(/-download$/, "");
                    modifiedString = data[i].slug.replace(/download-/, "");
                    var filename = `${modifiedString}.zip`;
                    console.log('Filename:', filename);

                    // Set the file path
                    const filePath = path.join('./public/downloads/', filename);
                    console.log('File path:', filePath);
                    touch(filePath);
                    // Download the file and save it to the specified path
                    await pipeline(response.data, fs.createWriteStream(filePath));
                    console.log(`Downloaded: ${filename}`);

                    // Update the titles array with the filename and file path
                    data[i].filename = filename;
                    data[i].filePath = filePath;

                    data[i].fileUrl = path.join(process.env.DOWNLOAD_URL, filename);
                    console.log('object: ', data[i])
                    fileCounter++;
                    list.push(data[i]);
                } catch (e) {
                    console.error(`Failed to download from link: ${data[i].downloadLink}`);
                    console.error(e);
                }

            }

            console.log('Downloaded files:', fileCounter);
            // Close the Browserless browser
            await closeBrowser(browser);
            console.log('Browser closed.');
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
