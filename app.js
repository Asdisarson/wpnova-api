console.log();
require('dotenv').config();
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const fs = require('fs');
const dbJson = require('simple-json-db')
const downloadFromChangelog = require('./func/changelogDownloader'); // Use the new unified changelog downloader
const { processVerificationLink } = require('./func/cloudflareBypass');
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
// Simple health endpoint for container orchestration
app.get('/health', (req, res) => {
    return res.status(200).json({ status: 'ok' });
});
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

// Inbound email webhook: forward email here as JSON { subject, text, html, link? }
app.post('/email/webhook', async (req, res) => {
    try {
        const { subject = '', text = '', html = '', link: directLink } = req.body || {};
        const blob = `${subject}\n\n${text}\n\n${html}`;
        // Prefer explicit link field, else extract first HTTPS link from email body
        let link = (typeof directLink === 'string' && /^https?:\/\//i.test(directLink)) ? directLink : null;
        if (!link) {
            const anyUrl = blob.match(/https?:\/\/[^\s\"']+/i);
            if (anyUrl) link = anyUrl[0];
        }
        if (!link) {
            return res.status(400).json({ ok: false, error: 'No link found in email' });
        }

        // Optional domain whitelist via env (comma-separated)
        const allowed = (process.env.ALLOWED_VERIFICATION_DOMAINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        if (allowed.length > 0) {
            try {
                const { hostname } = new URL(link);
                const hostOk = allowed.some(d => hostname.toLowerCase().endsWith(d));
                if (!hostOk) {
                    return res.status(400).json({ ok: false, error: `Link domain not allowed: ${hostname}` });
                }
            } catch (_) {}
        }

        console.log('📧 Verification link extracted:', link);
        await processVerificationLink(link);
        return res.json({ ok: true, link });
    } catch (err) {
        console.error('Email webhook error:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = app;