const puppeteer = require('puppeteer');
const JSONdb = require('simple-json-db');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const stream = require('stream');
const {promisify} = require('util');
const pipeline = promisify(stream.pipeline);
const convertJsonToCsv = require('./convertJsonToCsv');

// Maximum number of login attempts
const MAX_LOGIN_ATTEMPTS = 3;
const RETRY_DELAY = 5000; // 5 seconds

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

async function attemptLogin(page, username, password, attempt = 1) {
    console.log(`Login attempt ${attempt} of ${MAX_LOGIN_ATTEMPTS}...`);
    
    try {
        // Fill in credentials
        console.log('Entering username...');
        await page.type('#username', username.toString());
        
        console.log('Entering password...');
        await page.type('#password', password.toString());
        
        // Handle CAPTCHA
        console.log('Processing CAPTCHA...');
        await new Promise(async (resolve) => {
            try {
                await page.waitForSelector('.aiowps-captcha-equation');
                console.log('CAPTCHA element found');
                
                const captchaText = await page.$eval('.aiowps-captcha-equation strong', el => el.textContent);
                console.log('CAPTCHA equation found:', captchaText);
                
                const equation = captchaText.split('=')[0].trim();
                
                const wordToNumber = {
                    'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4,
                    'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9,
                    'ten': 10, 'eleven': 11, 'twelve': 12, 'thirteen': 13,
                    'fourteen': 14, 'fifteen': 15, 'sixteen': 16,
                    'seventeen': 17, 'eighteen': 18, 'nineteen': 19, 'twenty': 20
                };

                const parts = equation.toLowerCase().split(/\s+/);
                console.log('Parsed equation parts:', parts);
                
                const num1 = wordToNumber[parts[0]] || parseInt(parts[0]);
                const operator = parts[1];
                const num2 = wordToNumber[parts[2]] || parseInt(parts[2]);
                
                let result;
                switch(operator) {
                    case '+':
                    case 'plus':
                        result = num1 + num2;
                        break;
                    case '-':
                    case '−':
                    case 'minus':
                        result = num1 - num2;
                        break;
                    case '×':
                    case '*':
                    case 'times':
                        result = num1 * num2;
                        break;
                    default:
                        throw new Error('Unknown operator: ' + operator);
                }

                console.log('Solved CAPTCHA:', equation, '=', result);
                
                const captchaInput = await page.$('.aiowps-captcha-answer');
                await captchaInput.type(result.toString());
                console.log('Entered CAPTCHA solution');
                
                resolve();
            } catch (error) {
                console.error('CAPTCHA handling error:', error);
                resolve();
            }
        });

        // Click login button and wait for navigation
        console.log('Submitting login form...');
        await Promise.all([
            page.waitForNavigation(),
            page.click('.button.woocommerce-button.woocommerce-form-login__submit'),
        ]);

        // Check if login was successful by looking for a success indicator
        const isLoggedIn = await page.evaluate(() => {
            return !document.querySelector('.woocommerce-error');
        });

        if (isLoggedIn) {
            console.log('Login successful!');
            return true;
        } else {
            console.log('Login failed - error message present');
            throw new Error('Login failed');
        }
    } catch (error) {
        console.error(`Login attempt ${attempt} failed:`, error.message);
        
        if (attempt < MAX_LOGIN_ATTEMPTS) {
            console.log(`Waiting ${RETRY_DELAY/1000} seconds before next attempt...`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            return attemptLogin(page, username, password, attempt + 1);
        } else {
            throw new Error(`Failed to login after ${MAX_LOGIN_ATTEMPTS} attempts`);
        }
    }
}

const scheduledTask = async (date = new Date()) => {
    console.log('Starting scheduled task...');
    console.log('Target date:', date);
    
    const dbPath = path.join(__dirname, 'files.json');
    ensureDirectoryExistence(dbPath);
    const db = new JSONdb(dbPath);
    db.JSON({});
    let list = [];
    let error = [];

    try {
        console.log('Launching browser...');
        const browser = await puppeteer.launch({
            headless: true
        });

        if (!fs.existsSync('./public/downloads/')) {
            console.log('Creating downloads directory...');
            fs.mkdirSync('./public/downloads/', {recursive: true});
            touch('index.html');
        }

        const page = await browser.newPage();
        page.setDefaultTimeout(0);

        try {
            console.log('Navigating to login page...');
            await page.goto('https://www.realgpl.com/my-account/');

            try {
                console.log('Handling consent popup if present...');
                await Promise.all([
                    page.click('.fc-button-label'),
                ]);
                console.log('Consent popup handled');
            } catch (error) {
                console.log('No consent popup found');
            }

            const username = process.env.USERNAME;
            const password = process.env.PASSWORD;
            
            // Attempt login with retry logic
            await attemptLogin(page, username, password);

            // Go to the changelog page
            console.log('Going to the changelog page...');
            await page.goto('https://www.realgpl.com/changelog/?99936_results_per_page=250');
            
            console.log('Changelog page...');

            var theDate = new Date(date).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
            });
            console.log('Processing date:', theDate);
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
                            
                            // Get download link if available
                            let downloadLink = null;
                            let isLocked = false;
                            const downloadButton = row.querySelector('.awcpt-shortcode-wrap a');
                            if (downloadButton) {
                                downloadLink = downloadButton.getAttribute('href');
                                isLocked = downloadButton.classList.contains('locked');
                                console.log(`Found ${isLocked ? 'locked' : 'unlocked'} download button for: ${productName}`);
                            } else {
                                console.log(`No download button found for: ${productName}`);
                            }
                            
                            const productURL = row.querySelector('.awcpt-prdTitle-col a').getAttribute('href');

                            // Create an object with the extracted data for each row
                            const rowData = {
                                id,
                                productName,
                                date,
                                downloadLink,
                                productURL,
                                isLocked
                            };

                            if (downloadLink && !isLocked) {
                                rowDataArray.push(rowData);
                            } else {
                                console.log(`Skipping ${isLocked ? 'locked' : 'missing download link for'}: ${productName}`);
                            }
                        } catch (e) {
                            console.error('Error processing row:', e);
                        }
                    }
                }
                return rowDataArray;
            }, theDate);

            console.log(`Found ${data.length} downloadable items for ${theDate}`);
            
            // Process each title and download the files
            let fileCounter = 0;
            let errorCounter = 0;
            
            for (let i = 0; i < data.length; i++) {
                const item = data[i];
                console.log(`\nProcessing download ${i + 1}/${data.length}: ${item.productName}`);
                
                try {
                    if (!item.downloadLink) {
                        console.log('No download link available, skipping...');
                        continue;
                    }

                    if (item.isLocked) {
                        console.log('Item is locked (requires credits), skipping...');
                        continue;
                    }

                    // Get cookies from Puppeteer
                    const cookies = await page.cookies();
                    console.log('Got session cookies');

                    // Format cookies for axios
                    const formattedCookies = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

                    // Use axios to download the file
                    console.log('Starting download from:', item.downloadLink);
                    const response = await axios({
                        url: item.downloadLink,
                        method: 'GET',
                        responseType: 'stream',
                        headers: {
                            Cookie: formattedCookies
                        }
                    });

                    // Extract the filename from the URL
                    var modifiedString = item.slug?.replace(/-download$/, "") || 
                                      item.productName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
                    modifiedString = modifiedString.replace(/download-/, "");
                    var filename = `${modifiedString}.zip`;

                    // Set the file path
                    const filePath = path.join('./public/downloads/', filename);
                    console.log('Saving to:', filePath);
                    touch(filePath);

                    // Download the file and save it to the specified path
                    await pipeline(response.data, fs.createWriteStream(filePath));

                    // Update the data array with the filename and file path
                    data[i].filename = filename;
                    data[i].filePath = filePath;
                    data[i].fileUrl = path.join(process.env.DOWNLOAD_URL, filename);
                    
                    console.log('Download successful:', item.productName);
                    fileCounter++;
                    list.push(data[i]);
                } catch (e) {
                    errorCounter++;
                    console.error(`Failed to download: ${item.productName}`);
                    console.error('Error:', e.message);
                    error.push(data[i]);
                }
            }

            console.log('\nDownload Summary:');
            console.log(`Successfully downloaded: ${fileCounter} files`);
            console.log(`Failed downloads: ${errorCounter}`);

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
