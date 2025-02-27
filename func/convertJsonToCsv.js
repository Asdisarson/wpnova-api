const fs = require('fs');
const path = require('path');

/**
 * Convert a JSON array to CSV format and save to a file
 * Ensures specific fields are in specific column positions:
 * - version in column 6 (index 5)
 * - slug in column 8 (index 7)
 * - fileUrl in column 9 (index 8)
 * 
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
        
        // Define ordered columns with specific fields at required positions
        const orderedColumns = [
            'id',
            'productName',
            'date',
            'name',
            'downloadLink',
            'version', // Column 6 (index 5): Contains the product version
            'productId',
            'slug',    // Column 8 (index 7): Contains the product slug
            'fileUrl', // Column 9 (index 8): Contains the file URL
            'filename',
            'filePath',
            'isLocked',
            'isUnlocked',
            'productURL'
        ];
        
        // Get all keys from the data that might not be in our ordered list
        const allKeys = new Set();
        jsonData.forEach(item => {
            Object.keys(item).forEach(key => allKeys.add(key));
        });
        
        // Add any missing keys to the end of ordered columns
        Array.from(allKeys).forEach(key => {
            if (!orderedColumns.includes(key)) {
                orderedColumns.push(key);
            }
        });
        
        console.log(`Found ${orderedColumns.length} columns in data`);
        console.log(`Ensuring version in column 6, slug in column 8, fileUrl in column 9`);
        
        // Convert JSON to CSV with ordered columns
        let csvContent = orderedColumns.join(',') + '\n';
        
        jsonData.forEach(item => {
            const row = orderedColumns.map(header => {
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
                columnCount: orderedColumns.length,
                fileSize: fileSizeInBytes,
                fileSizeFormatted,
                outputFile
            };
            
            console.log(`CSV conversion completed successfully`);
            console.log(`Wrote ${jsonData.length} rows with ${orderedColumns.length} columns`);
            console.log(`File size: ${fileSizeFormatted}`);
            console.log(`Column positions: version=${orderedColumns.indexOf('version')+1}, slug=${orderedColumns.indexOf('slug')+1}, fileUrl=${orderedColumns.indexOf('fileUrl')+1}`);
            
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
