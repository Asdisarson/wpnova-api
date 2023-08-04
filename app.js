var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const scheduledTask = require('./func/scheduledTask'); // Import the scheduled task
require('dotenv').config();
const adminRoutes = require('./routes/adminRoutes');
const productRoutes = require('./routes/productRoutes');

var app = express();

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'defaultDB.zip'));
});
const { validateKey, deleteKey } = require('./func/apiKeyModule');

app.use(async (req, res, next) => {
    const apiKey = req.headers['x-api-key'];

    // Check for the master key
    if (apiKey === process.env.MASTER_KEY) {
        req.isAdmin = true; // add a flag to the request object
        return next();
    }
    if(process.env.DEVELOPMENT) {
        return next()
    }
    // If it's not the master key, validate it in the database
    if (!validateKey(apiKey)) {
        return res.status(401).json({ message: 'Invalid API Key' });
    }

    next();
});
app.use('/auth', async( req, res) =>{
    return res.status(200).json({message:'Authenticated'})
});
app.use('/admin', adminRoutes);
app.use('/products', productRoutes);

scheduledTask();
module.exports = app;
