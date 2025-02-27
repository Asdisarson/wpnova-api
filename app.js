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
    downloadAllFiles().then(result => {
        executeAfterAnHour();
        return res.status(200).json({
            message: 'Downloadable Files',
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
    console.log('Starting download of all files from changelog...');
    try {
        const downloads = await scheduledTaskYesterday.downloadAllFiles();
        executeAfterAnHour();
        return res.status(200).json({
            message: 'Downloaded all files from changelog',
            count: downloads
        });
    } catch (error) {
        console.error('Error downloading all files:', error);
        executeAfterAnHour();
        return res.status(503).json({message: 'Error downloading all files'});
    }
});
app.use('/lastUpdate', async(req,res) => {
        var db = new dbJson('./files.json');
        return res.send(db.JSON());
});
module.exports = app;
