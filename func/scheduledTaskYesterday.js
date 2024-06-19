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
            await Promise.all ([ await page.goto('https://www.realgpl.com/changelog/?99936_results_per_page=1000')]);
            let theDate = new Date(date);
            console.log(theDate);
            const data = await page.evaluate((theDateStr) => {
                const theDate = new Date(theDateStr);  // Reconstruct the Date object
                const rows = document.querySelectorAll('.awcpt-row');
                const rowDataArray = [];
                return (rows);
            });// Pass the date as a string
            console.log(data.length)
            console.log('Changelog entries for ', theDate);


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

                    // Set the file path
                    const filePath = path.join('./public/downloads/', filename);
                    touch(filePath);
                    // Download the file and save it to the specified path
                    await pipeline(response.data, fs.createWriteStream(filePath));

                    // Update the titles array with the filename and file path
                    data[i].filename = filename;
                    data[i].filePath = filePath;

                    data[i].fileUrl = path.join(process.env.DOWNLOAD_URL, filename);
                    console.log('Download Successful: ', data[i].productName)
                    fileCounter++;
                    list.push(data[i]);
                } catch (e) {
                    errorCounter++;
                    console.error(`Failed to download from link: ${data[i].downloadLink}`);
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
