const WooCommerceRestApi = require('@woocommerce/woocommerce-rest-api').default;
const fs = require('fs');
const archiver = require('archiver');
const JSONdb = require('simple-json-db');

const env = require('./env.json');
const dbPlugins = new JSONdb('./public/defaultDB.json');
const dbProducts = new JSONdb('./routes/dbProducts.json');
const zip =
    async () => {
const api = new WooCommerceRestApi({
    url: env.WC_URL,
    consumerKey: env.WC_CONSUMER_KEY,
    consumerSecret: env.WC_CONSUMER_SECRET,
    version: 'wc/v3',
    userAgent: env.USER_AGENT,
});
const allProductInfo = (product) => {
    let getProductMeta = (key) => product.meta_data.find((meta) => meta.key === key)?.value;

    let productData = {
        'name': product.name,
        'version': getProductMeta('product-version'),
        'description': product.description,
        'permalink': product.permalink,
        'demoLink': getProductMeta('demo-link'),
        'lastUpdate': product['date_modified_gmt'],
        'free': getProductMeta('is-free'),
        'productID': product.id,
        'brand': getProductMeta('brand'),
        'categories': product.categories.map(category => {
            return {
                'name': category.name,
                'slug': category.slug
            };
        }),
        'popular': getProductMeta('popular'),
        'price': product.price,
        'regular_price': product.regular_price,
        'sale_price': product.sale_price,
        'tags': product['tags'].map(tag => tag['name']),
        'developer': getProductMeta('developer'),
        'demo-url': getProductMeta('demo-url'),
        'dev-url': getProductMeta('dev-url'),
        'downloads': product.downloads.map(download => {
            return  download.file
        }),
    };

    if (product.categories.some((category) => category.slug === 'wp-gpl-themes')) {
        productData.type = 'theme';
    }

else if (product.categories.some((category) => category.slug === 'wp-gpl-plugins')) {
        productData.type = 'plugin';
    }
    dbProducts.set(productData.productID, productData);
    return productData;

}
const formatProduct = (product) => {
    let getProductMeta = (key) => product.meta_data.find((meta) => meta.key === key)?.value;

    const productData = {
        name: product.name,
        version: getProductMeta('product-version'),
        permalink: product.permalink,
        productID: product.id
    };

    if (product.categories.some((category) => category.slug === 'wp-gpl-themes')) {
        productData.type = 'theme';
        dbPlugins.set(parseInt(productData.productID), productData);
    } else if (product.categories.some((category) => category.slug === 'wp-gpl-plugins')) {
        productData.type = 'plugin';
        dbPlugins.set(parseInt(productData.productID), productData);
    }
    return productData;
};

const fetchData = async () => {
    try {
        let page = 1;
        const productsData = [];
        const AllData = [];

        while (true) {
            const response = await api.get('products', { per_page: 100, page });
            if (response.data.length === 0) break;

            const formattedProducts = response.data.map(formatProduct);
            productsData.push(...formattedProducts);
            AllData.push(...response.data.map(allProductInfo))
            console.log(page);
            page += 1;
        }

        return [productsData,AllData];
    } catch (error) {
        console.error('Error fetching products:', error);
        throw error;
    }
};

const saveDataToFile = (filename, data) => {
    fs.writeFileSync(filename, JSON.stringify(data), 'utf8');
};

    const zipFiles = async (files, outputFilename) => {
        const archive = archiver('zip', { zlib: { level: 9 } });
        const output = fs.createWriteStream(outputFilename);

        return new Promise((resolve, reject) => {
            archive
                .on('error', reject)
                .pipe(output)
                .on('close', resolve);

            for (const file of files) {
                archive.append(fs.createReadStream(file), { name: file });
            }

            archive.finalize();
        });
    };

const fetchAndSaveData = async () => {
    try {
        const productsData = await fetchData();
        await zipFiles(['./public/defaultDB.json'], './public/defaultDB.zip');
        console.log('Data fetched and saved successfully.');


    } catch (error) {
        console.error('Error fetching and saving data:', error);
    }
}
;fetchAndSaveData().then(r => { }); // Fetch and save data initially

    }
module.exports = zip;