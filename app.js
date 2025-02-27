console.log();
require('dotenv').config();
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const fs = require('fs');
const dbJson = require('simple-json-db')
const scheduledTask = require('./func/scheduledTask');
const { downloadAllFiles } = require('./func/scheduledTaskYesterday'); // Import the optimized function
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
    console.log(date);
    
    // Use the optimized downloadAllFiles function for better performance
    // Pass the date parameter to filter by specific date
    downloadAllFiles(date).then(result => {
        executeAfterAnHour();
        return res.status(200).json({
            message: 'Downloadable Files',
            date: date.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
            }),
            files: result.successList ? result.successList.length : 0,
            downloaded: result.downloadedCount,
            skipped: result.skippedCount
        });
    }).catch(error => {
        console.error('Error in download process:', error);
        executeAfterAnHour();
        return res.status(503).json({
            message: 'Something is Wrong',
            error: error.message
        });
    });
});

// New endpoint to download all files from changelog
app.use('/download-all', async(req,res) => {
    var date = new Date();
    if(req.query.date){
        date = new Date(req.query.date);
    }
    console.log(`Starting download of all files from changelog for date: ${date.toLocaleDateString()}`);
    
    try {
        const result = await downloadAllFiles(date);
        executeAfterAnHour();
        return res.status(200).json({
            message: 'Downloaded all files from changelog',
            date: date.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
            }),
            downloaded: result.downloadedCount,
            skipped: result.skippedCount,
            files: result.successList ? result.successList.length : 0
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
