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
console.log('Running initial scheduled task on startup...');
scheduledTask(new Date())
    .then(downloads => {
        console.log('Initial scheduled task completed successfully');
        console.log(`Downloaded ${downloads} files`);
        executeAfterAnHour();
    })
    .catch(error => {
        console.error('Initial scheduled task failed:', error);
        executeAfterAnHour();
    });

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
    }, 3600000); // 3600000 milliseconds = 1 hour
}
app.use(express.static(path.join(__dirname, 'public')));
app.use('/refresh', async(req,res) => {
    var date = new Date();
    if(req.query.date){
        date = new Date(req.query.date);
    }
    console.log(date);
    scheduledTask(date).then(downloads => {


            executeAfterAnHour();
            return res.status(200).json({
                message: 'Downloadable Files',
                files: downloads
            })
        }).catch(error => {
            executeAfterAnHour();
            return res.status(503).json({message: 'Something is Wrong '});
        });

});
app.use('/lastUpdate', async(req,res) => {
        var db = new dbJson('./files.json');
        return res.send(db.JSON());
});
module.exports = app;
