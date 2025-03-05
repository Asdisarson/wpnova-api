const puppeteer = require('puppeteer');
const JSONdb = require('simple-json-db');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const stream = require('stream');
const {promisify} = require('util');
const pipeline = promisify(stream.pipeline);
const convertJsonToCsv = require('./convertJsonToCsv');
const disk = require('diskusage');
const os = require('os');

// Near the top of the file, add a constant for the download URL with proper path normalization
// This ensures we don't get duplicate /downloads segments
const DOWNLOAD_URL = process.env.DOWNLOAD_URL ? 
    '/' + process.env.DOWNLOAD_URL.replace(/^\/+|\/+$/g, '') : // Remove leading and trailing slashes, then add a single leading slash
    '/downloads';

// Set up scheduled cleanup for temp files
const setupScheduledTempCleanup = () => {
    console.log('Setting up scheduled temp file cleanup...');
    
    // Run cleanup initially
    setTimeout(() => {
        console.log('Running initial temp cleanup...');
        cleanupAllTemporaryFiles()
            .then(() => console.log('Initial cleanup completed'))
            .catch(err => console.error('Error in initial cleanup:', err));
    }, 5 * 60 * 1000); // Run 5 minutes after startup
    
    // Set up interval to run cleanup every hour
    setInterval(() => {
        console.log('Running scheduled hourly temp cleanup...');
        cleanupAllTemporaryFiles()
            .then(() => console.log('Hourly cleanup completed'))
            .catch(err => console.error('Error in hourly cleanup:', err));
    }, 60 * 60 * 1000); // Run every hour
    
    // Set up interval to recreate Chrome user data directory every 3 hours
    setInterval(() => {
        console.log('Recreating Chrome user data directory...');
        recreateUserDataDir()
            .then(success => console.log(success ? 'Chrome user data directory recreated' : 'Failed to recreate Chrome user data directory'))
            .catch(err => console.error('Error recreating Chrome user data directory:', err));
    }, 3 * 60 * 60 * 1000); // Run every 3 hours
};

// Run cleanup immediately on script start
console.log('Running immediate startup cleanup...');
// This will be executed right away, but we need to wait for the cleanupAllTemporaryFiles function to be defined
// So we'll use setTimeout with a delay of 0 to push this to the end of the event loop
setTimeout(() => {
    if (typeof cleanupAllTemporaryFiles === 'function') {
        cleanupAllTemporaryFiles()
            .then(() => console.log('Startup cleanup completed'))
            .catch(err => console.error('Error in startup cleanup:', err));
    } else {
        console.log('cleanupAllTemporaryFiles function not available yet, will rely on scheduled cleanup');
    }
}, 0);

// Initialize the scheduled cleanup
setupScheduledTempCleanup();

// Add a universal delay function that works with any Puppeteer version
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Create a download history database to prevent duplicates
const downloadHistoryPath = path.join(__dirname, 'download_history.json');
// Ensure the file exists
if (!fs.existsSync(downloadHistoryPath)) {
    fs.writeFileSync(downloadHistoryPath, JSON.stringify({}));
}
const downloadHistory = new JSONdb(downloadHistoryPath);

// Format bytes to human-readable format (replacement for pretty-bytes)
const formatBytes = (bytes, decimals = 2) => {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

const ensureDirectoryExistence = (filePath) => {
    const dirname = path.dirname(filePath);
    if (fs.existsSync(dirname)) {
        return true;
    }
    ensureDirectoryExistence(dirname);
    fs.mkdirSync(dirname);
}

function touch(filename) {
    try {
        // Check if file exists
        if (!fs.existsSync(filename)) {
            // If not, create an empty file
            fs.writeFileSync(filename, '');
        } else {
            // If it does, update its modification time
            const currentTime = new Date();
            fs.utimesSync(filename, currentTime, currentTime);
        }
    } catch (err) {
        console.error(`Error touching file ${filename}:`, err);
    }
}

// Helper function to watch for new files in a directory
const watchForNewFile = (directoryPath, timeout = 120000) => {
    return new Promise((resolve) => {
        // Get initial file list with timestamps
        const initialFiles = new Map();
        fs.readdirSync(directoryPath).forEach(file => {
            try {
                const filePath = path.join(directoryPath, file);
                if (fs.statSync(filePath).isFile()) {
                    initialFiles.set(file, fs.statSync(filePath).mtimeMs);
                }
            } catch (err) {
                console.error(`Error reading file ${file}:`, err);
            }
        });
        
        console.log(`Watching for new files in: ${directoryPath}`);
        console.log(`Initial file count: ${initialFiles.size}`);
        
        // Track .crdownload files
        const crdownloadFiles = new Set();
        // Track which files we've already logged to prevent duplicate messages
        const loggedFiles = new Set();
        
        // Set up watcher
        const watcher = fs.watch(directoryPath, (eventType, filename) => {
            if (!filename) return;
            
            const fullPath = path.join(directoryPath, filename);
            
            // Check if this is a Chrome temporary download file
            if (filename.endsWith('.crdownload')) {
                // Only log if we haven't seen this file before
                if (!loggedFiles.has(filename)) {
                    console.log(`Chrome download started: ${filename}`);
                    loggedFiles.add(filename);
                    
                    crdownloadFiles.add({
                        tempPath: fullPath,
                        expectedFinalPath: path.join(directoryPath, filename.replace('.crdownload', ''))
                    });
                }
                // Don't resolve yet, wait for the final file
                return;
            }
            
            // For non-crdownload files, check if it's new or modified
            if (eventType === 'rename' || eventType === 'change') {
                try {
                    // Make sure file exists
                    if (!fs.existsSync(fullPath)) return;
                    
                    const stats = fs.statSync(fullPath);
                    if (!stats.isFile()) return;
                    
                    // A file is considered new if:
                    // 1. It wasn't in our initial list
                    // 2. Or it was updated after we started watching
                    const isNew = !initialFiles.has(filename) || 
                                  stats.mtimeMs > initialFiles.get(filename);
                    
                    if (isNew) {
                        console.log(`New/updated file detected: ${filename}`);
                        watcher.close();
                        resolve({ path: fullPath, filename });
                    }
                    
                    // Also check if this is the final file for any .crdownload we've seen
                    for (const crdownload of crdownloadFiles) {
                        if (fullPath === crdownload.expectedFinalPath) {
                            console.log(`Chrome download completed: ${filename}`);
                            
                            // Increment download counter and trigger cleanup after every X downloads
                            downloadCounter++;
                            if (downloadCounter % CLEANUP_FREQUENCY === 0) {
                                console.log(`Reached ${downloadCounter} downloads, triggering cleanup...`);
                                cleanupOldTempDirectories(1) // Clean temp dirs older than 1 hour
                                    .then(() => console.log('Download batch cleanup completed'))
                                    .catch(err => console.error('Error in download batch cleanup:', err));
                            }
                            
                            watcher.close();
                            resolve({ 
                                path: crdownload.expectedFinalPath, 
                                filename: filename 
                            });
                            return;
                        }
                    }
                } catch (err) {
                    console.error(`Error processing file event for ${filename}:`, err);
                }
            }
        });
        
        // Set timeout in case no file appears
        const timeoutId = setTimeout(() => {
            watcher.close();
            
            // Check if any previously seen .crdownload files completed
            for (const crdownload of crdownloadFiles) {
                if (fs.existsSync(crdownload.expectedFinalPath)) {
                    const finalFilename = path.basename(crdownload.expectedFinalPath);
                    console.log(`Found completed download: ${finalFilename}`);
                    resolve({ 
                        path: crdownload.expectedFinalPath, 
                        filename: finalFilename 
                    });
                    return;
                }
            }
            
            // Do a final check for any new files by comparing against initial list
            try {
                const currentFiles = new Set();
                fs.readdirSync(directoryPath).forEach(file => {
                    try {
                        const filePath = path.join(directoryPath, file);
                        if (fs.statSync(filePath).isFile() && 
                            !file.endsWith('.crdownload') && 
                            !file.endsWith('.tmp') && 
                            !initialFiles.has(file)) {
                            
                            currentFiles.add(file);
                        }
                    } catch (err) {
                        console.error(`Error in final check for ${file}:`, err);
                    }
                });
                
                if (currentFiles.size === 1) {
                    // If exactly one new file, assume it's our download
                    const newFile = [...currentFiles][0];
                    const fullPath = path.join(directoryPath, newFile);
                    console.log(`Found one new file in final check: ${newFile}`);
                    resolve({ path: fullPath, filename: newFile });
                    return;
                } else if (currentFiles.size > 1) {
                    // If multiple new files, log but we can't determine which is ours
                    console.log(`Found ${currentFiles.size} new files in final check, can't determine which is the target`);
                    // Pick the newest file by modification time
                    let newestFile = null;
                    let newestTime = 0;
                    
                    for (const file of currentFiles) {
                        const filePath = path.join(directoryPath, file);
                        try {
                            const stats = fs.statSync(filePath);
                            if (stats.mtimeMs > newestTime) {
                                newestTime = stats.mtimeMs;
                                newestFile = file;
                            }
                        } catch (err) {
                            console.error(`Error checking modification time for ${file}:`, err);
                        }
                    }
                    
                    if (newestFile) {
                        const fullPath = path.join(directoryPath, newestFile);
                        console.log(`Using newest file as download: ${newestFile}`);
                        resolve({ path: fullPath, filename: newestFile });
                        return;
                    }
                }
            } catch (err) {
                console.error(`Error in final file check: ${err.message}`);
            }
            
            console.log(`No new files detected within ${timeout}ms`);
            resolve(null);
        }, timeout);
    });
};

// Helper function to wait for a file to finish downloading
const waitForFileToFinish = async (filePath, checkInterval = 100, timeout = 60000) => {
    return new Promise((resolve) => {
        let lastSize = 0;
        let unchangedCount = 0;
        let startTime = Date.now();
        let lastCheckTime = startTime;
        let speed = 0;
        let totalTime = 0;
        
        const checkFile = setInterval(() => {
            try {
                // Check if file exists before attempting to stat it
                if (!fs.existsSync(filePath)) {
                    console.log(`File no longer exists at path: ${filePath}`);
                    clearInterval(checkFile);
                    resolve(false);
                    return;
                }
                
                const stats = fs.statSync(filePath);
                const currentTime = Date.now();
                const timeDiff = (currentTime - lastCheckTime) / 1000; // in seconds
                const sizeDiff = stats.size - lastSize;
                
                if (timeDiff > 0) {
                    speed = sizeDiff / timeDiff;
                }
                
                totalTime = (currentTime - startTime) / 1000;
                
                // Calculate estimated time remaining if we have a speed
                let eta = 'calculating...';
                if (speed > 0) {
                    const bytesRemaining = 0; // We don't know the total size
                    const timeRemaining = bytesRemaining / speed;
                    if (timeRemaining > 0) {
                        eta = formatTime(timeRemaining);
                    }
                }
                
                console.log(`File: ${path.basename(filePath)}`);
                console.log(`Size: ${formatBytes(stats.size)}`);
                console.log(`Speed: ${formatSpeed(speed)}`);
                console.log(`Time elapsed: ${formatTime(totalTime)}`);
                
                lastCheckTime = currentTime;
                
                if (stats.size === lastSize) {
                    unchangedCount++;
                    
                    // If size hasn't changed for 3 checks, assume download is complete
                    if (unchangedCount >= 3) {
                        clearInterval(checkFile);
                        console.log(`Download complete: ${path.basename(filePath)}`);
                        console.log(`Final size: ${formatBytes(stats.size)}`);
                        console.log(`Total time: ${formatTime(totalTime)}`);
                        console.log(`Average speed: ${formatSpeed(stats.size / totalTime)}`);
                        resolve(true);
                    }
                } else {
                    // Reset counter if size has changed
                    unchangedCount = 0;
                    lastSize = stats.size;
                }
            } catch (err) {
                console.log(`Error checking file: ${err.message}`);
                // If we can't access the file several times, abort
                unchangedCount++;
                if (unchangedCount >= 5) {
                    clearInterval(checkFile);
                    console.log(`Too many errors checking file, assuming download failed`);
                    resolve(false);
                }
            }
        }, checkInterval);
        
        // Set a timeout in case the file size check gets stuck
        setTimeout(() => {
            clearInterval(checkFile);
            console.log(`Timeout reached, assuming download is complete`);
            resolve(false);
        }, timeout);
    });
};

// Add scheduled cleanup that runs at intervals
let tempCleanupInterval;

// Function to start periodic temp cleanup
const startPeriodicTempCleanup = (intervalMinutes = 30) => {
    console.log(`Starting periodic temp file cleanup (every ${intervalMinutes} minutes)`);
    
    // Run immediately on start
    (async () => {
        console.log('Running initial temp cleanup...');
        await cleanupOldTempDirectories(2); // Initially clean temp directories older than 2 hours
    })();
    
    // Set up interval for future cleanups
    tempCleanupInterval = setInterval(async () => {
        console.log('Running scheduled temp cleanup...');
        await cleanupOldTempDirectories(2); // Clean temp directories older than 2 hours during runtime
    }, intervalMinutes * 60 * 1000);
};

// Function to stop periodic cleanup
const stopPeriodicTempCleanup = () => {
    if (tempCleanupInterval) {
        console.log('Stopping periodic temp file cleanup');
        clearInterval(tempCleanupInterval);
        tempCleanupInterval = null;
    }
};

// First declare the original functions and store references to them
let scheduledTask_original;
let downloadAllFiles_original;

// Define the original scheduledTask function first
scheduledTask_original = async (date = new Date()) => {
    // Your original scheduledTask implementation goes here
    // This should be the body of your original scheduledTask function
    console.log('Running original scheduled task...');
    // If your original function is elsewhere in the code, you'll need to move that implementation here
    
    // For now, this is a placeholder - replace with actual implementation
    return { status: "completed" };
};

// Define the original downloadAllFiles function first
downloadAllFiles_original = async (date = new Date()) => {
    // Your original downloadAllFiles implementation goes here
    // This should be the body of your original downloadAllFiles function
    console.log('Running original download all files...');
    // If your original function is elsewhere in the code, you'll need to move that implementation here
    
    // For now, this is a placeholder - replace with actual implementation
    return { status: "completed" };
};

// Now create the enhanced versions that wrap the originals
const scheduledTask = async (date = new Date()) => {
    try {
        // Run cleanup at the beginning
        console.log('Cleaning up before starting task...');
        await cleanupAllTemporaryFiles();
        
        // Start periodic cleanup
        startPeriodicTempCleanup(30); // Run every 30 minutes
        
        // Run the original function
        const result = await scheduledTask_original(date);
        
        // Clean up again at the end
        console.log('Task completed, doing final cleanup...');
        await cleanupAllTemporaryFiles();
        
        // Stop the periodic cleanup
        stopPeriodicTempCleanup();
        
        return result;
    } catch (err) {
        console.error('Error in scheduledTask:', err);
        
        // Clean up even if there's an error
        await cleanupAllTemporaryFiles();
        stopPeriodicTempCleanup();
        
        throw err;
    }
};

// Similarly define the enhanced downloadAllFiles function
const downloadAllFiles = async (date = new Date()) => {
    try {
        // Run cleanup at the beginning
        console.log('Cleaning up before starting downloads...');
        await cleanupAllTemporaryFiles();
        
        // Start periodic cleanup
        startPeriodicTempCleanup(15); // Run every 15 minutes for downloads
        
        // Run the improved function
        const result = await downloadAllFiles_original(date);
        
        // Clean up again at the end
        console.log('Downloads completed, doing final cleanup...');
        await cleanupAllTemporaryFiles();
        
        // Stop the periodic cleanup
        stopPeriodicTempCleanup();
        
        return result;
    } catch (err) {
        console.error('Error in downloadAllFiles:', err);
        
        // Clean up even if there's an error
        await cleanupAllTemporaryFiles();
        stopPeriodicTempCleanup();
        
        throw err;
    }
};

/**
 * Scans the download directory and reports existing files
 * Checks if files exist in the download history
 */
const scanDownloadDirectory = () => {
  const downloadsDir = path.resolve('./public/downloads/');
  
  if (!fs.existsSync(downloadsDir)) {
    console.log('Downloads directory does not exist, creating...');
    fs.mkdirSync(downloadsDir, { recursive: true });
    return { fileCount: 0, totalSize: 0, files: [] };
  }
  
  // Get all files in the directory
  const files = fs.readdirSync(downloadsDir)
    .filter(file => {
      const filePath = path.join(downloadsDir, file);
      // Filter out directories and temp files
      return fs.statSync(filePath).isFile() && 
        !file.startsWith('.') && 
        !file.endsWith('.tmp') &&
        !file.endsWith('.crdownload');
    });
  
  console.log(`Found ${files.length} files in downloads directory`);
  
  if (files.length === 0) {
    return { fileCount: 0, totalSize: 0, files: [] };
  }
  
  let totalSize = 0;
  const fileDetails = [];
  
  // Process each file
  files.forEach(file => {
    const filePath = path.join(downloadsDir, file);
    const stats = fs.statSync(filePath);
    const fileSizeBytes = stats.size;
    totalSize += fileSizeBytes;
    
    // Check if this file is in download history
    const entries = downloadHistory.JSON();
    const matchingEntries = Object.values(entries).filter(entry => 
      entry.filePath === filePath || entry.filename === file
    );
    
    const inHistory = matchingEntries.length > 0;
    const historyInfo = inHistory ? matchingEntries[0] : null;
    
    fileDetails.push({
      filename: file,
      filePath,
      sizeBytes: fileSizeBytes,
      sizeFormatted: formatBytes(fileSizeBytes),
      created: stats.birthtime,
      modified: stats.mtime,
      inHistory,
      historyInfo
    });
  });
  
  // Sort files by size (largest first)
  fileDetails.sort((a, b) => b.sizeBytes - a.sizeBytes);
  
  console.log(`Total size of ${files.length} files: ${formatBytes(totalSize)}`);
  console.log('Files by size (largest first):');
  
  fileDetails.forEach(file => {
    console.log(`${file.filename} (${file.sizeFormatted}) - Created: ${file.created.toISOString()}, Modified: ${file.modified.toISOString()}`);
    console.log(`  In history: ${file.inHistory ? 'Yes' : 'No'}`);
    if (file.inHistory && file.historyInfo) {
      console.log(`  Product: ${file.historyInfo.productName}`);
      console.log(`  Downloaded: ${new Date(file.historyInfo.downloadDate).toISOString()}`);
    }
  });
  
  console.log('--------------------------------------------------');
  
  return { 
    fileCount: files.length, 
    totalSize, 
    totalSizeFormatted: formatBytes(totalSize),
    files: fileDetails
  };
};

// Improved robust directory deletion using fs.rm with recursive option
const removeDirectoryRecursive = async (dirPath) => {
    if (!fs.existsSync(dirPath)) return;
    
    try {
        // For Node.js 14.14.0+ we can use fs.rm with recursive option
        if (fs.rm) {
            await fs.promises.rm(dirPath, { recursive: true, force: true });
            console.log(`Successfully removed directory: ${dirPath}`);
        } else {
            // Fallback for older Node.js versions
            const deleteDirectory = (dirPath) => {
                if (fs.existsSync(dirPath)) {
                    fs.readdirSync(dirPath).forEach((file) => {
                        const curPath = path.join(dirPath, file);
                        if (fs.lstatSync(curPath).isDirectory()) {
                            // Recursive call
                            deleteDirectory(curPath);
                        } else {
                            // Delete file
                            fs.unlinkSync(curPath);
                        }
                    });
                    fs.rmdirSync(dirPath);
                }
            };
            deleteDirectory(dirPath);
            console.log(`Successfully removed directory: ${dirPath}`);
        }
    } catch (err) {
        console.error(`Failed to remove directory ${dirPath}:`, err);
    }
};

// Function to clean up temporary directories older than a certain age
const cleanupOldTempDirectories = async (maxAgeHours = 24) => {
    const downloadsDir = path.resolve('./public/downloads/');
    if (!fs.existsSync(downloadsDir)) return;
    
    console.log(`Scanning for temporary directories older than ${maxAgeHours} hours...`);
    const now = Date.now();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    
    try {
        const entries = fs.readdirSync(downloadsDir);
        let cleanedCount = 0;
        
        for (const entry of entries) {
            if (entry.startsWith('temp-')) {
                const dirPath = path.join(downloadsDir, entry);
                if (!fs.existsSync(dirPath)) continue;
                
                const stats = fs.statSync(dirPath);
                const ageMs = now - stats.mtimeMs;
                
                if (ageMs > maxAgeMs) {
                    console.log(`Removing old temp directory: ${entry} (${Math.round(ageMs / 3600000)} hours old)`);
                    await removeDirectoryRecursive(dirPath);
                    cleanedCount++;
                }
            }
        }
        
        console.log(`Cleaned up ${cleanedCount} old temporary directories`);
    } catch (err) {
        console.error('Error while cleaning up old temp directories:', err);
    }
};

// Enhanced clearDownloadsDirectory to also handle temp directories
let clearDownloadsDirectory = async (cleanTemp = true) => {
    const downloadsDir = path.resolve('./public/downloads/');
    
    if (!fs.existsSync(downloadsDir)) {
        console.log('Downloads directory does not exist, creating...');
        fs.mkdirSync(downloadsDir, { recursive: true });
        return;
    }
    
    console.log('Clearing downloads directory...');
    
    // Get all files in the directory
    const entries = fs.readdirSync(downloadsDir);
    
    // First, handle regular files
    const files = entries.filter(entry => {
        const entryPath = path.join(downloadsDir, entry);
        // Filter out directories, system files, temp directories, and temp files
        return fs.statSync(entryPath).isFile() && 
            !entry.startsWith('.') && 
            !entry.endsWith('.crdownload') &&
            !entry.endsWith('.tmp') &&
            entry !== 'index.html'; // Keep index.html
    });
    
    if (files.length === 0) {
        console.log('No regular files to clear in downloads directory');
    } else {
        console.log(`Found ${files.length} files to clear from downloads directory`);
        
        // Delete each file
        let deletedCount = 0;
        let errorCount = 0;
        
        for (const file of files) {
            try {
                const filePath = path.join(downloadsDir, file);
                fs.unlinkSync(filePath);
                console.log(`Deleted: ${file}`);
                deletedCount++;
            } catch (err) {
                console.error(`Error deleting file ${file}:`, err.message);
                errorCount++;
            }
        }
        
        console.log(`Cleared downloads directory: ${deletedCount} files deleted, ${errorCount} errors`);
    }
    
    // Next, handle temp files and directories if requested
    if (cleanTemp) {
        // Find all temp directories
        const tempDirs = entries.filter(entry => {
            const entryPath = path.join(downloadsDir, entry);
            return fs.statSync(entryPath).isDirectory() && 
                  (entry.startsWith('temp-') || entry === 'temp_user_data');
        });
        
        if (tempDirs.length > 0) {
            console.log(`Found ${tempDirs.length} temporary directories to clean`);
            
            for (const dir of tempDirs) {
                const dirPath = path.join(downloadsDir, dir);
                // Skip temp_user_data as it's handled separately, but clean all temp- dirs
                if (dir !== 'temp_user_data') {
                    await removeDirectoryRecursive(dirPath);
                }
            }
        }
        
        // Clean temp files - be more aggressive with temporary files
        const tempFiles = entries.filter(entry => {
            const entryPath = path.join(downloadsDir, entry);
            return fs.statSync(entryPath).isFile() && 
                (entry.endsWith('.tmp') || 
                 entry.endsWith('.crdownload') || 
                 entry.endsWith('.partial') ||
                 entry.endsWith('.download'));
        });
        
        if (tempFiles.length > 0) {
            console.log(`Found ${tempFiles.length} temporary files to clean`);
            
            for (const file of tempFiles) {
                try {
                    const filePath = path.join(downloadsDir, file);
                    fs.unlinkSync(filePath);
                    console.log(`Deleted temporary file: ${file}`);
                } catch (err) {
                    console.error(`Error deleting temporary file ${file}:`, err.message);
                }
            }
        }
    }
};

// Comprehensive cleanup function that handles all temporary files and directories
const cleanupAllTemporaryFiles = async () => {
    console.log('Starting comprehensive cleanup of all temporary files...');
    
    // 1. Clean up Chrome user data directory
    await cleanupUserDataDir();
    
    // 2. Clean up downloads directory including temp files and directories
    await clearDownloadsDirectory(true);
    
    // 3. Clean up old temp directories
    await cleanupOldTempDirectories(24); // Clean directories older than 24 hours
    
    console.log('Comprehensive cleanup completed');
};

// Improved cleanup function for Chrome user data directory
const cleanupUserDataDir = async () => {
    const userDataDir = path.join(process.cwd(), 'temp_user_data');
    if (fs.existsSync(userDataDir)) {
        console.log('Cleaning up Chrome user data directory...');
        await removeDirectoryRecursive(userDataDir);
    }
};

// Function to recreate the user data directory fresh to prevent it from growing too large
const recreateUserDataDir = async () => {
    const userDataDir = path.join(process.cwd(), 'temp_user_data');
    console.log(`Recreating Chrome user data directory: ${userDataDir}`);
    
    try {
        // Clean up the existing directory
        await cleanupUserDataDir();
        
        // Create a fresh directory
        if (!fs.existsSync(userDataDir)) {
            fs.mkdirSync(userDataDir, { recursive: true });
            console.log('Created fresh Chrome user data directory');
        }
        
        return true;
    } catch (err) {
        console.error('Error recreating Chrome user data directory:', err);
        return false;
    }
};

// Enhance the original clearDownloadsDirectory function to use the async version
// Store a reference to the original function
const clearDownloadsDirectory_original = clearDownloadsDirectory;

// Now redefine the function
clearDownloadsDirectory = async (cleanTemp = false) => {
    await clearDownloadsDirectory_original(cleanTemp);
};

// Add improved signal handlers for cleanup
process.on('exit', () => {
    console.log('Process exiting - cleaning up...');
    // For the exit event, we must use synchronous operations
    try {
        const userDataDir = path.join(process.cwd(), 'temp_user_data');
        if (fs.existsSync(userDataDir)) {
            // Use the synchronous deleteDirectory for process.exit
            const deleteDirectory = (dirPath) => {
                if (fs.existsSync(dirPath)) {
                    fs.readdirSync(dirPath).forEach((file) => {
                        const curPath = path.join(dirPath, file);
                        if (fs.lstatSync(curPath).isDirectory()) {
                            // Recursive call
                            deleteDirectory(curPath);
                        } else {
                            // Delete file
                            fs.unlinkSync(curPath);
                        }
                    });
                    fs.rmdirSync(dirPath);
                }
            };
            deleteDirectory(userDataDir);
        }
    } catch (err) {
        console.error('Error during exit cleanup:', err);
    }
});

process.on('SIGINT', async () => {
    console.log('Received SIGINT - cleaning up before exit...');
    try {
        await cleanupAllTemporaryFiles();
        process.exit(0);
    } catch (err) {
        console.error('Error during SIGINT cleanup:', err);
        process.exit(1);
    }
});

process.on('SIGTERM', async () => {
    console.log('Received SIGTERM - cleaning up before exit...');
    try {
        await cleanupAllTemporaryFiles();
        process.exit(0);
    } catch (err) {
        console.error('Error during SIGTERM cleanup:', err);
        process.exit(1);
    }
});

// Helper function to get disk space information
const getDiskInfo = async (path) => {
    try {
        const info = await disk.check(path);
        return {
            available: info.available,
            free: info.free,
            total: info.total,
            availableFormatted: formatBytes(info.available),
            freeFormatted: formatBytes(info.free),
            totalFormatted: formatBytes(info.total),
            usedPercentage: Math.round((1 - info.available / info.total) * 100)
        };
    } catch (err) {
        console.error(`Error getting disk info: ${err.message}`);
        return null;
    }
};

// Helper function to format download speed
const formatSpeed = (bytesPerSecond) => {
    return `${formatBytes(bytesPerSecond)}/s`;
};

// Helper function to format time
const formatTime = (seconds) => {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${Math.round(seconds % 60)}s`;
};

// Helper function to notify plugin.php that data processing is complete
const notifyPluginDataReady = async (successCount, errorCount) => {
    try {
        console.log('Triggering product update via WordPress plugin...');
        
        // Construct the URL to plugin.php with proper path resolution
        const pluginUrl = process.env.WORDPRESS_PLUGIN_URL || process.env.PLUGIN_URL || 'https://wpnova.io/wp-content/plugins/wpnova/plugin.php';
        
        if (!pluginUrl.includes('wpnova.io') && !pluginUrl.includes('localhost') && pluginUrl.includes('your-wordpress-site.com')) {
            console.log('WORDPRESS_PLUGIN_URL environment variable not set correctly. Skipping update trigger.');
            return { success: false, skipped: true, error: 'Plugin URL not properly configured' };
        }
        
        // Add timestamp to prevent caching
        const timestamp = new Date().getTime();
        
        console.log(`Sending update trigger to: ${pluginUrl}`);
        const response = await axios.post(pluginUrl, {
            action: 'data_ready',
            timestamp: timestamp
        }, {
            headers: {
                'Content-Type': 'application/json',
                'X-WP-Nova-Api': 'true' // Custom header for authentication if needed
            },
            timeout: 30000 // 30 second timeout
        });
        
        console.log(`Update triggered successfully with status: ${response.status}`);
        console.log(`Response from WordPress: ${JSON.stringify(response.data)}`);
        return response.data;
    }
    catch (error) {
        console.error('Error triggering product update:');
        if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            console.error(`Status: ${error.response.status}`);
            console.error(`Data: ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
            // The request was made but no response was received
            console.error('No response received from server');
        } else {
            // Something happened in setting up the request that triggered an Error
            console.error(`Error message: ${error.message}`);
        }
        
        // Don't throw, just log - we don't want to fail the entire process if update trigger fails
        return { success: false, error: error.message };
    }
};

// Add a counter for triggering cleanup
let downloadCounter = 0;
const CLEANUP_FREQUENCY = 10; // Trigger cleanup after every 10 downloads

// Process each title and download the files
let fileCounter = 0;
let errorCounter = 0;
let skippedFromHistory = 0;
let totalDownloadedFiles = 0; // Track total downloaded files

// Reset the download counter at the start of each batch
downloadCounter = 0;

module.exports = scheduledTask;
module.exports.downloadAllFiles = downloadAllFiles;
