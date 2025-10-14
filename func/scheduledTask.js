const { 
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
        // Launch Browserless browser with Cloudflare bypass
        console.log('Launching Browserless browser with Cloudflare bypass...');
        const { browser, page } = await createCloudflareBypassBrowser();
        
        // Add human-like behavior
        await addHumanLikeBehavior(page);
        
        if (!fs.existsSync('./public/downloads/')) {
            fs.mkdirSync('./public/downloads/', {recursive: true});
            touch('index.html');
        }
        
        page.setDefaultTimeout(0);

        try {
            // Go directly to changelog page
            console.log('Going directly to changelog page...');
            await navigateWithRetry(page, 'https://www.realgpl.com/changelog/?99936_results_per_page=500');

            // Clear all cookies for a clean slate before login
            console.log('🧹 Clearing all cookies for fresh login...');
            try {
                const cookies = await page.cookies();
                if (cookies.length > 0) {
                    await page.deleteCookie(...cookies);
                    console.log(`✅ Cleared ${cookies.length} cookies`);
                    
                    // Reload the page so it can detect the missing cookies and show login form
                    console.log('🔄 Reloading page to trigger login form...');
                    await page.reload({ waitUntil: 'domcontentloaded' });
                    await delay(randomDelay(2000, 3000));
                    console.log('✅ Page reloaded');
                } else {
                    console.log('No cookies to clear');
                }
            } catch (error) {
                console.log(`⚠️  Cookie clearing warning: ${error.message}`);
            }

            // Handle consent block if it appears (after reload)
            try {
                const consentExists = await waitForElementReady(page, '.fc-button-label', 5000);
                if (consentExists) {
                    await page.click('.fc-button-label');
                    await delay(1000);
                    console.log('Consent block accepted');
                }
            } catch (error) {
                console.log('No Consent block')
            }

            // Check if we need to login on the changelog page
            console.log('🔍 Checking if login is needed...');
            const needsLogin = await page.evaluate(() => {
                const loginForm = document.querySelector('form.login, form.woocommerce-form-login, #username');
                const hasTable = document.querySelector('table#awcpt-product-table-99936') !== null;
                return loginForm !== null || !hasTable;
            });
            
            if (needsLogin) {
                console.log('🔐 Login required - logging in on changelog page...');
                
                const username = process.env.USERNAME;
                const password = process.env.PASSWORD;
                
                if (!username || !password) {
                    throw new Error('USERNAME and PASSWORD environment variables are required');
                }
                
                // Wait for and fill login form
                await waitForElementReady(page, '#username');
                await waitForElementReady(page, '#password');
                
                console.log('Entering credentials...');
                await page.type('#username', username.toString());
                await delay(randomDelay(500, 1000));
                await page.type('#password', password.toString());
                await delay(randomDelay(500, 1000));
                
                // Submit login form
                const loginButton = await page.$('.button.woocommerce-button.woocommerce-form-login__submit, input[type="submit"][name="login"]');
                if (loginButton) {
                    console.log('Submitting login form...');
                    await loginButton.click();
                    
                    // Wait for page to reload/update after login
                    await delay(randomDelay(3000, 5000));
                    console.log('✅ Login submitted, checking results...');
                    
                    // Verify login was successful by checking if table is now visible
                    const tableVisible = await waitForElementReady(page, 'table#awcpt-product-table-99936', 30000);
                    if (tableVisible) {
                        console.log('✅ Login successful - table is now visible');
                    } else {
                        throw new Error('Login may have failed - table still not visible');
                    }
                } else {
                    throw new Error('Login button not found on changelog page');
                }
            } else {
                console.log('✅ Already logged in - table is visible');
            }

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
