const fs = require('fs');
const path = require('path');

/**
 * Convert a JSON array to CSV format and save to a file
 * @param {Array} jsonData - Array of objects to convert to CSV
 * @param {string} outputFile - Path to save the CSV file
 * @param {Function} callback - Callback function (err, summary)
 */
const convertJsonToCsv = (jsonData, outputFile, callback) => {
    if (!Array.isArray(jsonData) || jsonData.length === 0) {
        console.log('No data to convert to CSV');
        return callback(null, { success: false, rowCount: 0, message: 'No data to convert' });
    }
    
    try {
        console.log(`Starting JSON to CSV conversion for ${jsonData.length} items`);
        console.log(`Output file: ${outputFile}`);
        
        // Get all unique keys from all objects
        const allKeys = new Set();
        jsonData.forEach(item => {
            Object.keys(item).forEach(key => allKeys.add(key));
        });
        
        const headers = Array.from(allKeys);
        console.log(`Found ${headers.length} unique columns in data`);
        
        // Convert JSON to CSV
        let csvContent = headers.join(',') + '\n';
        
        jsonData.forEach(item => {
            const row = headers.map(header => {
                // Handle special characters and ensure proper CSV format
                const value = item[header] !== undefined ? item[header] : '';
                // Escape quotes and wrap fields with commas in quotes
                if (typeof value === 'string') {
                    return `"${value.replace(/"/g, '""')}"`;
                } else if (value === null) {
                    return '';
                } else {
                    return value;
                }
            }).join(',');
            
            csvContent += row + '\n';
        });
        
        // Ensure the directory exists
        const dir = path.dirname(outputFile);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        // Write to file
        fs.writeFile(outputFile, csvContent, 'utf8', (err) => {
            if (err) {
                console.error(`Error writing CSV file: ${err.message}`);
                return callback(err);
            }
            
            // Get file size
            const stats = fs.statSync(outputFile);
            const fileSizeInBytes = stats.size;
            const fileSizeFormatted = formatBytes(fileSizeInBytes);
            
            const summary = {
                success: true,
                rowCount: jsonData.length,
                columnCount: headers.length,
                fileSize: fileSizeInBytes,
                fileSizeFormatted,
                outputFile
            };
            
            console.log(`CSV conversion completed successfully`);
            console.log(`Wrote ${jsonData.length} rows with ${headers.length} columns`);
            console.log(`File size: ${fileSizeFormatted}`);
            
            return callback(null, summary);
        });
    } catch (err) {
        console.error(`Error in convertJsonToCsv: ${err.message}`);
        return callback(err);
    }
};

/**
 * Format bytes to a human-readable format
 */
const formatBytes = (bytes, decimals = 2) => {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

module.exports = convertJsonToCsv;
