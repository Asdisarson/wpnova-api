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

const scheduledTask = async () => {
    const dbPath = path.join(__dirname, 'files.json');
    ensureDirectoryExistence(dbPath);
    const db = new JSONdb(dbPath);
    db.JSON({});
    let list = [];
    try {
        // Launch Puppeteer browser
        console.log('Launching Puppeteer browser...');
        const browser = await puppeteer.launch({
            headless: true,
            executablePath: '/usr/bin/chromium', // Adjusted path for Chromium
            defaultViewport: null,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--headless'],
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/78.0.3904.97 Safari/537.36'
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


            // Fill in the login credentials
            console.log('Typing username and password...');
            await page.type('#username', process.env.USERNAME);
            await page.type('#password', process.env.PASSWORD);

            // Click the login button and wait for navigation
            console.log('Clicking the login button...');
            await Promise.all([
                page.waitForNavigation(),
                page.click('.button.woocommerce-button.woocommerce-form-login__submit'),
            ]);

            // Go to the changelog page
            console.log('Going to the changelog page...');
            await page.goto('https://www.realgpl.com/changelog/?99936_results_per_page=500');

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
                    // Get cookies from Puppeteer
                    const cookies = await page.cookies();

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
            // Close the Puppeteer browser
            await browser.close();
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
