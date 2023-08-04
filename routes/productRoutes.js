// productRoutes.js

const express = require('express');
const fetch = require('node-fetch');
const Cache = require('node-cache');
const SimpleJsonDb = require('simple-json-db');
const productsDb = new SimpleJsonDb('./routes/dbProducts.json');
const router = express.Router();
const cache = new Cache({stdTTL: 3600, checkperiod: 120}); // Cache for an hour

router.get('/:productId', async (req, res) => {
    const product = productsDb.get(req.params.productId);
    console.log(req.params.productId)
    if (!product) {
        return res.status(404).json({message: 'Product not found'});
    }
    let data;
    try {
        data = cache.get(product.productId);
        res.setHeader('Content-Type', 'application/zip');
        res.send(data);
    } catch (e) {
        if (!data) {
            try {
                const response = await fetch(product.downloads);

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                data = await response.buffer();
                cache.set(product.productId, data);
                res.setHeader('Content-Type', 'application/zip');
                res.send(data);
            } catch (error) {
                return res.status(500).json({message: 'Error fetching product file'});
            }
        }
        return res.status(500).json({message: 'Error fetching product file'});

    }


});

module.exports = router;
