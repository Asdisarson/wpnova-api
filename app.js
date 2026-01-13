require('dotenv').config();
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const fs = require('fs');
const dbJson = require('simple-json-db')
const downloadFromChangelog = require('./func/changelogDownloader'); // Use the new unified changelog downloader
const { processVerificationLink } = require('./func/cloudflareBypass');
var app = express();

// Middleware
app.use(logger('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));
app.use(cookieParser());

// Request timeout middleware (30 minutes for long-running operations)
app.use((req, res, next) => {
    req.setTimeout(1800000); // 30 minutes
    res.setTimeout(1800000);
    next();
});

// Helper function to clean downloads directory (called before new download run)
function cleanDownloadsDirectory() {
        const downloadsDir = path.join(__dirname, 'public', 'downloads');
    try {
        if (!fs.existsSync(downloadsDir)) {
            fs.mkdirSync(downloadsDir, { recursive: true });
                return;
            }
        const files = fs.readdirSync(downloadsDir);
        let removedCount = 0;
            for (const file of files) {
            // Keep index.html placeholder
            if (file === 'index.html') continue;
                const filePath = path.join(downloadsDir, file);
            try {
                fs.unlinkSync(filePath);
                removedCount++;
            } catch (err) {
                        console.error(`Error deleting file ${file}:`, err);
                    }
        }
        if (removedCount > 0) {
            console.log(`🧹 Cleaned downloads directory (removed ${removedCount} files)`);
            }
    } catch (err) {
        console.error('Error cleaning downloads directory:', err);
    }
}

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Simple health endpoint for container orchestration
app.get('/health', (req, res) => {
    return res.status(200).json({ status: 'ok' });
});

// Refresh changelog endpoint (returns immediately, processes in background)
app.get('/refresh', (req, res) => {
    let date = new Date();
    
    // Validate and parse date from query parameter
    if (req.query.date) {
        const parsedDate = new Date(req.query.date);
        if (isNaN(parsedDate.getTime())) {
            return res.status(400).json({
                error: 'Invalid date format. Please use ISO 8601 format (YYYY-MM-DD)'
            });
        }
        date = parsedDate;
    }
    
    const dateLabel = date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });
    
    console.log(`Refreshing changelog for date: ${dateLabel}`);

    // Optional: propagate force_update to the WordPress webhook trigger (after CSV generation)
    const forceUpdateWebhook = (() => {
        const v = req.query.force_update ?? req.query.force;
        if (v === undefined || v === null) return false;
        const s = String(v).trim().toLowerCase();
        return s === '1' || s === 'true' || s === 'yes' || s === 'on';
    })();
    
    // Return immediately
    res.status(200).json({
        message: 'Refresh started',
        date: dateLabel,
        status: 'processing'
    });
    
    // Process in background
    setImmediate(async () => {
        try {
            // Clean downloads directory before starting new download run
            cleanDownloadsDirectory();
            
        // Use the new unified changelog downloader
        const result = await downloadFromChangelog({
            date: date,
            resultsPerPage: 500,
            downloadFiles: true,
            forceUpdateWebhook
        });
        
            console.log(`✅ Refresh completed: ${result.downloadedCount} downloaded, ${result.errorCount} errors`);
    } catch (error) {
            console.error('❌ Error in background refresh process:', error);
        }
        });
});

// Download all files from changelog (returns immediately, processes in background)
app.get('/download-all', (req, res) => {
    let date = new Date();
    
    // Validate and parse date from query parameter
    if (req.query.date) {
        const parsedDate = new Date(req.query.date);
        if (isNaN(parsedDate.getTime())) {
            return res.status(400).json({
                error: 'Invalid date format. Please use ISO 8601 format (YYYY-MM-DD)'
            });
        }
        date = parsedDate;
    }
    
    const dateLabel = date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });
    
    console.log(`Starting download of all files from changelog for date: ${dateLabel}`);
    
    // Return immediately
    res.status(200).json({
        message: 'Download started',
        date: dateLabel,
        status: 'processing'
    });
    
    // Process in background
    setImmediate(async () => {
        try {
            // Clean downloads directory before starting new download run
            cleanDownloadsDirectory();
            
        const result = await downloadFromChangelog({
            date: date,
            resultsPerPage: 500,
            downloadFiles: true
        });
        
            console.log(`✅ Download-all completed: ${result.downloadedCount} downloaded, ${result.errorCount} errors`);
    } catch (error) {
            console.error('❌ Error in background download-all process:', error);
        }
        });
});

// Get last update information
app.get('/lastUpdate', async(req, res) => {
    try {
        const db = new dbJson('./files.json');
        const data = db.JSON();
        return res.status(200).json(data);
    } catch (error) {
        console.error('Error reading last update:', error);
        return res.status(500).json({
            error: 'Failed to retrieve last update information'
        });
    }
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
            } catch (urlError) {
                return res.status(400).json({ ok: false, error: 'Invalid URL format' });
            }
        }

        console.log('📧 Verification link extracted:', link);
        // Respond immediately (async processing)
        res.json({ ok: true, link });
        // Process in background
        setImmediate(async () => {
            try {
                await processVerificationLink(link);
            } catch (e) {
                console.error('Async verification processing failed:', e);
            }
        });
    } catch (err) {
        console.error('Email webhook error:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(err.status || 500).json({
        error: err.message || 'Internal server error',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

module.exports = app;