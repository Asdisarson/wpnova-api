require('dotenv').config();
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const fs = require('fs');
const dbJson = require('simple-json-db')
const scheduledTask = require('./func/scheduledTask'); // Import the scheduled task

var app = express();
app.use((req, res, next) => {
    const remoteAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    console.log(req.ip);
  if (process.env.ALLOWED_IP.includes(remoteAddress)||process.env.DEVELOPMENT) {
      console.log('SUCCESS');
    next();
  } else {
      console.log('DENIED')
    res.status(403).send('Access denied');
  }
});
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
function executeAfterAnHour() {
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
    scheduledTask(process.env.YESTERDAY||false).then(downloads => {


        executeAfterAnHour();
        return res.status(200).json({message:'Downloadable Files',
                                        files: downloads})
    }).catch(error => {
        executeAfterAnHour();
        return res.status(503).json({ message: 'Something is Wrong ' });
    });
});
app.use('/lastUpdate', async(req,res) => {
        var db = new dbJson('./files.json');
        return res.send(db.JSON());
});
module.exports = app;
