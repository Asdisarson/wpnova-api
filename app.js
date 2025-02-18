console.log();
require('dotenv').config();
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const fs = require('fs');
const dbJson = require('simple-json-db')
const scheduledTask = require('./func/scheduledTask'); // Import the scheduled task
var date = new Date();
var app = express();
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Run scheduled task on startup
console.log('Starting initial data fetch...');
const startupDate = new Date();
scheduledTask(startupDate)
    .then(downloads => {
        console.log(`Initial fetch completed. Found ${downloads} items.`);
    })
    .catch(error => {
        console.error('Initial fetch failed:', error);
    });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/refresh', async(req,res) => {
    var date = new Date();
    if(req.query.date){
        date = new Date(req.query.date);
    }
    console.log(date);
    scheduledTask(date)
        .then(downloads => {
            return res.status(200).json({
                message: 'Downloadable Files',
                files: downloads
            });
        })
        .catch(error => {
            console.error('Refresh failed:', error);
            return res.status(503).json({
                message: 'Something went wrong',
                error: error.message
            });
        });
});
app.use('/lastUpdate', async(req,res) => {
        var db = new dbJson('./files.json');
        return res.send(db.JSON());
});

// Error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        message: 'Internal Server Error',
        error: err.message
    });
});

module.exports = app;
