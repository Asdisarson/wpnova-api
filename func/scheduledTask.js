const puppeteer = require('puppeteer');
const JSONdb = require('simple-json-db');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const stream = require('stream');
const {promisify} = require('util');
const pipeline = promisify(stream.pipeline);
const convertJsonToCsv = require('./convertJsonToCsv');
const { extractAndSolveCaptcha } = require('./captcha');
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

/**
 * Handles the login process with retries
 * @param {Page} page - Puppeteer page object
 * @returns {Promise<boolean>} - True if login successful
 */
async function handleLogin(page) {
    console.log('Starting login process...');
    
    // Go to the login page
    console.log('Navigating to login page...');
    await page.goto('https://www.realgpl.com/my-account/', {
        waitUntil: 'networkidle0',
        timeout: 60000
    });
    
    // Handle consent if present
    try {
        const consentButton = await page.$('.fc-button-label');
        if (consentButton) {
            console.log('Handling consent popup...');
            await consentButton.click();
            await page.waitForTimeout(1000); // Wait for animation
        }
    } catch (error) {
        console.log('No consent popup found');
    }
    
    // Try login up to 3 times
    for (let attempt = 1; attempt <= 3; attempt++) {
        console.log(`\nLogin attempt ${attempt} of 3`);
        
        try {
            // Clear any existing input before retry
            if (attempt > 1) {
                console.log('Clearing previous input...');
                await page.evaluate(() => {
                    document.querySelector('#username').value = '';
                    document.querySelector('#password').value = '';
                    const captchaInput = document.querySelector('.aiowps-captcha-answer');
                    if (captchaInput) captchaInput.value = '';
                });
                await page.reload({ waitUntil: 'networkidle0' });
                await page.waitForTimeout(2000); // Wait for page to stabilize
            }
            
            // Get and log the current captcha equation before solving
            const captchaElement = await page.$('.aiowps-captcha-equation strong');
            if (captchaElement) {
                const captchaText = await page.evaluate(el => el.textContent, captchaElement);
                console.log('Current captcha:', captchaText.trim());
            }
            
            // Fill in credentials
            console.log('Entering credentials...');
            await page.type('#username', process.env.USERNAME);
            await page.type('#password', process.env.PASSWORD);
            
            // Handle captcha
            console.log('Solving captcha...');
            const html = await page.content();
            const captchaSolution = extractAndSolveCaptcha(html);
            console.log('Captcha equation:', captchaSolution.equation);
            console.log('Captcha answer:', captchaSolution.answer);
            
            await page.type('.aiowps-captcha-answer', captchaSolution.answer.toString());
            
            // Submit form and wait for navigation
            console.log('Submitting login form...');
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }),
                page.click('.woocommerce-form-login__submit')
            ]);
            
            // Verify login success
            const errorMessage = await page.$('.woocommerce-error');
            if (errorMessage) {
                const error = await page.evaluate(el => el.textContent, errorMessage);
                console.log('Login failed:', error.trim());
                if (attempt < 3) await page.waitForTimeout(3000); // Wait before retry
                continue;
            }
            
            const loggedInElement = await page.$('.woocommerce-MyAccount-navigation');
            if (loggedInElement) {
                console.log('Login successful!');
                return true;
            }
            
            console.log('Login status unclear - no error but not on account page');
            if (attempt < 3) await page.waitForTimeout(3000);
            
        } catch (error) {
            console.error(`Error during login attempt ${attempt}:`, error.message);
            if (attempt < 3) {
                console.log('Waiting before retry...');
                await page.waitForTimeout(3000);
            }
        }
    }
    
    console.log('All login attempts failed');
    return false;
}

/**
 * Scrapes changelog data from a specific page
 * @param {Page} page - Puppeteer page object
 * @param {string} theDate - Target date string
 * @param {number} pageNum - Page number to scrape
 * @returns {Promise<Array>} - Array of changelog entries
 */
async function scrapeChangelogPage(page, theDate, pageNum) {
    console.log(`Scraping changelog page ${pageNum}...`);
    const url = `https://www.realgpl.com/changelog/?99936_results_per_page=250&99936_paged=${pageNum}`;
    
    await page.goto(url);
    console.log(`Navigated to page ${pageNum}`);
    
    const data = await page.evaluate((theDate) => {
        const rows = document.querySelectorAll('tr.awcpt-row');
        const rowDataArray = [];
        console.log(`Found ${rows.length} rows on page`);

        for (const row of rows) {
            var date = row.querySelector('.awcpt-date').innerText;
            if (theDate === date) {
                try {
                    const id = row.getAttribute('data-id');
                    const productName = row.querySelector('.awcpt-title').innerText;
                    const downloadLink = row.querySelector('.awcpt-shortcode-wrap a').getAttribute('href');
                    const productURL = row.querySelector('.awcpt-prdTitle-col a').getAttribute('href');

                    rowDataArray.push({
                        id,
                        productName,
                        date,
                        downloadLink,
                        productURL,
                    });
                } catch (e) {
                    console.error('Error processing row:', e);
                }
            }
        }
        return rowDataArray;
    }, theDate);

    console.log(`Found ${data.length} matching entries on page ${pageNum}`);
    return data;
}

const scheduledTask = async (date = new Date()) => {
    const dbPath = path.join(__dirname, 'files.json');
    ensureDirectoryExistence(dbPath);
    const db = new JSONdb(dbPath);
    db.JSON({});
    let list = [];
    let error = [];

    // Calculate days difference
    const today = new Date();
    const daysDiff = Math.floor((today - date) / (1000 * 60 * 60 * 24));
    console.log(`Searching for updates from ${daysDiff} days ago`);

    try {
        // Launch browser with specific options
        console.log('Launching browser...');
        const browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu'
            ]
        });

        // Create new page with longer timeout
        const page = await browser.newPage();
        page.setDefaultTimeout(30000);
        
        // Set a reasonable viewport
        await page.setViewport({ width: 1280, height: 800 });

        // Attempt login
        const loginSuccess = await handleLogin(page);
        if (!loginSuccess) {
            throw new Error('Failed to login after multiple attempts');
        }

        // Changelog scraping with pagination
        console.log('Starting changelog scraping...');
        let allData = [];
        let currentPage = 1;
        let maxPages = daysDiff > 3 ? 2 : 1; // Check up to 2 pages if date is more than 3 days ago
        let foundEntries = false;

        const theDate = new Date(date).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
        console.log(`Looking for entries from: ${theDate}`);

        while (currentPage <= maxPages) {
            console.log(`Processing page ${currentPage} of ${maxPages}`);
            const pageData = await scrapeChangelogPage(page, theDate, currentPage);
            
            if (pageData.length > 0) {
                console.log(`Found ${pageData.length} entries on page ${currentPage}`);
                allData = allData.concat(pageData);
                foundEntries = true;
            } else if (foundEntries) {
                console.log('No more entries found on subsequent page, stopping pagination');
                break;
            } else if (currentPage === maxPages) {
                console.log(`No entries found after checking ${maxPages} pages`);
                break;
            }
            
            currentPage++;
            if (currentPage <= maxPages) {
                console.log('Waiting 2 seconds before next page...');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        console.log(`Total entries found: ${allData.length}`);
        
        // Process the found entries
        for (let i = 0; i < allData.length; i++) {
            let text = allData[i].productName;

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
                url = allData[i].productURL;
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
                allData[i].version = versionWithoutV;
                allData[i].name = textWithoutVersion;
                allData[i].slug = slug;
                allData[i].filename = '';
                allData[i].filePath = '';
                allData[i].productId = productId;

            }
        }
        console.log('Data processing completed.');

        // Process each title and download the files
        let fileCounter = 0;
        let errorCounter = 0;
        for (let i = 0; i < allData.length; i++) {
            console.log(`Starting download for file ${i + 1} of ${allData.length}...`);
            try {
                // Get cookies from Puppeteer
                const cookies = await page.cookies();

                // Format cookies for axios
                const formattedCookies = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

                // Use axios to download the file
                const response = await axios({
                    url: allData[i].downloadLink,
                    method: 'GET',
                    responseType: 'stream',
                    headers: {
                        Cookie: formattedCookies
                    }
                });
                // Extract the filename from the URL
                var modifiedString = allData[i].slug.replace(/-download$/, "");
                modifiedString = allData[i].slug.replace(/download-/, "");
                var filename = `${modifiedString}.zip`;

                // Set the file path
                const filePath = path.join('./public/downloads/', filename);
                touch(filePath);
                // Download the file and save it to the specified path
                await pipeline(response.data, fs.createWriteStream(filePath));

                // Update the titles array with the filename and file path
                allData[i].filename = filename;
                allData[i].filePath = filePath;

                allData[i].fileUrl = path.join(process.env.DOWNLOAD_URL, filename);
                console.log('Download Successful: ', allData[i].productName)
                fileCounter++;
                list.push(allData[i]);
            } catch (e) {
                errorCounter++;
                console.error(`Failed to download from link: ${allData[i].downloadLink}`);
                console.error(e);
                error.push(allData[i]);

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
}

module.exports = scheduledTask;
