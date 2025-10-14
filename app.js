console.log();
require('dotenv').config();
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const fs = require('fs');
const dbJson = require('simple-json-db')
const downloadFromChangelog = require('./func/changelogDownloader'); // Use the new unified changelog downloader
var date = new Date();
var app = express();
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
function executeAfterAnHour()    {
    setTimeout(() => {
        const downloadsDir = path.join(__dirname, 'public', 'downloads');
        fs.readdir(downloadsDir, (err, files) => {
            if (err) throw err;

            for (const file of files) {
                fs.unlink(path.join(downloadsDir, file), err => {
                    if (err) throw err;
                });
            }
        });
        // Your code here
    }, 3600000); // 3600000 milliseconds = 1 hour
}
app.use(express.static(path.join(__dirname, 'public')));
app.use('/refresh', async(req,res) => {
    var date = new Date();
    if(req.query.date){
        date = new Date(req.query.date);
    }
    console.log(`Refreshing changelog for date: ${date.toLocaleDateString()}`);
    
    try {
        // Use the new unified changelog downloader
        const result = await downloadFromChangelog({
            date: date,
            resultsPerPage: 500,
            downloadFiles: true
        });
        
        executeAfterAnHour();
        return res.status(200).json({
            message: 'Downloadable Files from Changelog',
            date: date.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
            }),
            files: result.products.length,
            downloaded: result.downloadedCount,
            errors: result.errorCount
        });
    } catch (error) {
        console.error('Error in download process:', error);
        executeAfterAnHour();
        return res.status(503).json({
            message: 'Something is Wrong',
            error: error.message
        });
    }
});

// Download all files from changelog
app.use('/download-all', async(req,res) => {
    var date = new Date();
    if(req.query.date){
        date = new Date(req.query.date);
    }
    console.log(`Starting download of all files from changelog for date: ${date.toLocaleDateString()}`);
    
    try {
        const result = await downloadFromChangelog({
            date: date,
            resultsPerPage: 500,
            downloadFiles: true
        });
        
        executeAfterAnHour();
        return res.status(200).json({
            message: 'Downloaded all files from changelog',
            date: date.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
            }),
            downloaded: result.downloadedCount,
            errors: result.errorCount,
            files: result.products.length
        });
    } catch (error) {
        console.error('Error downloading all files:', error);
        executeAfterAnHour();
        return res.status(503).json({
            message: 'Error downloading all files',
            error: error.message
        });
    }
});

app.use('/lastUpdate', async(req,res) => {
        var db = new dbJson('./files.json');
        return res.send(db.JSON());
});

module.exports = app;