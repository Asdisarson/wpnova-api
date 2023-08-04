// scheduledTask.js

const cron = require('node-cron');
const puppeteer = require('puppeteer');
const JSONdb = require('simple-json-db');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const stream = require('stream');
const {promisify} = require('util');
const pipeline = promisify(stream.pipeline);
const zip = require("./zip");
const valitor = require('./valitor');
const {default: WooCommerceRestApi} = require("@woocommerce/woocommerce-rest-api");
const env = require("./env.json");
const db = new JSONdb('./tempDB.json');
const scheduledTask =

// Define your task to run every 24 hours
    async () => {


        // Launch Puppeteer browser
        const browser = await puppeteer.launch({
            headless: true,
            defaultViewport: null,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/78.0.3904.97 Safari/537.36'
        });

        // Create a new page
        const page = await browser.newPage();
        page.setDefaultTimeout(0);

        // Go to the login page
        console.log('Going to the login page...');
        await page.goto('https://www.realgpl.com/my-account/');

        await Promise.all([
            page.click('.fc-button-label'),
        ]);
        // Fill in the login credentials
        console.log('Typing username and password...');
        await page.type('#username', 'hafsteinn@pineapple.is');
        await page.type('#password', 'w^2MiIui7*l2$NsD');

        // Click the login button and wait for navigation
        console.log('Clicking the login button...');
        await Promise.all([
            page.waitForNavigation(),
            page.click('.button.woocommerce-button.woocommerce-form-login__submit'),
        ]);
        for (let x = 1; x < 41; x++) {


        // Go to the changelog page
        console.log('Going to the changelog page...');
        await page.goto('https://www.realgpl.com/changelog/?99936_results_per_page=100&_paged='+ x);

        // Get the links of the changelog entries
        console.log('evaluating...');
        const links = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('td.awcpt-table-col.awcpt-eleShortcode-col > div > a'));
            return anchors.map(anchor => anchor.href);
        });

        // Get the titles and URLs of the changelog entries
        const titles = await page.evaluate(() => {
            const nameOfFile = Array.from(document.querySelectorAll('td > a.awcpt-title'));
            return nameOfFile.map(obj => {
                return {
                    title: obj.title,
                    url: obj.href
                };
            });
        });
        const name = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('td.awcpt-shortcode-wrap'));
            return anchors.map(anchor => anchor.text);
        });
        console.log('evaluating DONE!')
        // Process each title and extract relevant information
        for (let i = 0; i < titles.length; i++) {

            let text = titles[i].title;
            let string = titles[i].title;
            // Extract version
            if (/\d/.test(text)) {

                let version = text.match(/v\d+(\.\d+){0,2}/)[0];


                // Remove 'v' from version
                let versionWithoutV = version.replace('v', '');

                // Remove version from title
                let textWithoutVersion = text.replace(/ v\d+(\.\d+){0,2}/, '');

                let url = titles[i].url;
                var parsedUrl = new URL(links[i]);
                url = url.replace(/^\/|\/$/g, '');

                // Get the last part of the URL after the last slash
                const parts = url.split('/');
                const slug = parts[parts.length - 1];
                // Extract the slug from the URL

                // Get the product_id parameter value
                var productId = parsedUrl.searchParams.get("product_id");
                titles[i] = {
                    version: versionWithoutV,
                    name: textWithoutVersion,
                    slug: slug,
                    filename: '',
                    filePath: '',
                    productId: productId,
                    button: name[i],
                    link:
                    links[i].url,
                    string:string
                };
            }                db.set(titles[i].slug, titles[i]);

        }
        }
        let fileCounter = 0;
        var files = [];

        function modifyFilename(url) {
            // Extract the filename
            const filename = url.substring(url.lastIndexOf('/') + 1);

            console.log(`Original Filename: ${filename}`);

            // Split the filename into words
            let words = filename.split('-');

            // Loop through the words and remove any that contain a number and all words after it
            for (let i = 0; i < words.length; i++) {
                if (/\d/.test(words[i])) {
                    words = words.slice(0, i);
                    break;
                }
            }

            // Join the words back together with "-" and append .zip
            const newFilename = words.join('-') + '.zip';

            console.log(`Modified Filename: ${newFilename}`);

            return newFilename;
        }

        // Download files from the provided links
        for (let i = 0; i < links.length; i++) {
            console.log(`Starting download for file ${i + 1} of ${links.length}...`);
            try {
                // Get cookies from Puppeteer
                const cookies = await page.cookies();

                // Format cookies for axios
                const formattedCookies = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

                // Use axios to download the file
                const response = await axios({
                    url: links[i],
                    method: 'GET',
                    responseType: 'stream',
                    headers: {
                        Cookie: formattedCookies
                    }
                });
                // Extract the filename from the URL
                var modifiedString = titles[i].slug.replace(/-download$/, "");
                var filename = `${modifiedString}.zip`;
                console.log('Filename:', filename);

                // Set the file path
                const filePath = path.join('./public/downloads/', filename);
                console.log('File path:', filePath);

                // Download the file and save it to the specified path
                await pipeline(response.data, fs.createWriteStream(filePath));
                console.log(`Downloaded: ${filename}`);

                // Update the titles array with the filename and file path
                titles[i].filename = filename;
                titles[i].filePath = filePath;
                fileCounter++;

                files.push(JSON.stringify(titles[i]));
            } catch (e) {
                console.error(`Failed to download from link: ${links[i]}`);
                console.error(e);
            }
        }
        console.log('Downloaded files:', files.length);


        // Close the Puppeteer browser
        await browser.close();
        console.log('Browser closed.');

        const env = require('./env.json')
        const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
        const api = new WooCommerceRestApi({
            url: env.WC_URL, // replace with your WordPress site URL
            consumerKey:env.WC_CONSUMER_KEY , // replace with your keys
            consumerSecret: env.WC_CONSUMER_SECRET, // replace with your keys
            version: 'wc/v3'
        });
        for (let i = 0; i < links.length; i++) {

            // Upload the file to the corresponding WooCommerce product
            console.log(`Starting upload for file ${i + 1} of ${links.length}...`);
            try {
                let filePath = titles[i].filename;
                let newPath = filePath.replace(/public\//g, '');
                console.log(newPath);
                // In real life, you'd probably upload the file somewhere and get a URL to it
                // For simplicity, let's just assume that we have a URL
                let fileUrl = `${env.SERVER_URL}${newPath}`; // replace with your WordPress site URL

                // Prepare data for the API request
                let data = {
                    downloadable: true,
                    downloads: [
                        {
                            name: titles[i].filename,
                            file: fileUrl
                        }
                    ]
                };
                api.get(`products?slug=${titles[i].slug}`).then(function(result) {
                    var products = result;

                    if (products.length > 0) {
                        api.put(`products/${products[0].id}`, data);
                        console.log(`Uploaded: ${titles[i].filename}`);
                        db.set(products[0].id,fileUrl)
                    } else {
                        console.log('No product found for this slug');
                    }
                }).catch(function(error) {
                    console.error(error);
                });
                // Send PUT request to the WooCommerce API

            } catch (e) {
                console.error(`Failed to upload file: ${titles[i].filename}`);
                console.error(e);
            }
        }

        await zip();

    }

scheduledTask()
    .then(() => {
        const directory = './public/downloads';
        fs.readdir(directory, (err, files) => {
            if (err) throw err;

            for (const file of files) {
                fs.unlink(path.join(directory, file), err => {
                    if (err) throw err;
                });
            }
        });
        process.exit(0); // Exit with success code
    })
    .catch((error) => {
        console.error('Error executing the task:', error);
        process.exit(1); // Exit with error code
    });
