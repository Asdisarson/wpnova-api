const fs = require('fs');
const unzipper = require('unzipper');
const path = require('path');

function unzipFile(zipFilePath, extractTo) {
    let totalEntries = 0;
    let processedEntries = 0;

    const readStream = fs.createReadStream(zipFilePath);
    readStream.on('error', function(err) {
        console.error(`An error occurred while reading the file: ${err.message}`);
    });

    const unzipStream = readStream.pipe(unzipper.Parse());
    unzipStream.on('error', function(err) {
        console.error(`An error occurred while unzipping the file: ${err.message}`);
    });

    unzipStream.on('entry', function (entry) {
        totalEntries++;

        const fileName = entry.path;
        const type = entry.type; // 'Directory' or 'File'
        const targetPath = path.join(extractTo, fileName);
        if (type === 'File' && path.extname(fileName) === '.zip') {
            if (!fs.existsSync(targetPath)) {
                const writeStream = entry.pipe(fs.createWriteStream(targetPath));
                writeStream.on('error', function(err) {
                    console.error(`An error occurred while writing the file: ${err.message}`);
                });
                writeStream.on('finish', () => {
                    processedEntries++;
                    console.log(`Processed ${processedEntries} out of ${totalEntries} entries.`);
                    unzipFile(targetPath, extractTo);
                });
            } else {
                console.log(`File ${targetPath} already exists. Skipping.`);
                entry.autodrain();
                processedEntries++;
            }
        } else if (type === 'File') {
            if (!fs.existsSync(targetPath)) {
                const writeStream = entry.pipe(fs.createWriteStream(targetPath));
                writeStream.on('error', function(err) {
                    console.error(`An error occurred while writing the file: ${err.message}`);
                });
                writeStream.on('finish', () => {
                    processedEntries++;
                    console.log(`Processed ${processedEntries} out of ${totalEntries} entries.`);
                });
            } else {
                console.log(`File ${targetPath} already exists. Skipping.`);
                entry.autodrain();
                processedEntries++;
            }
        } else {
            entry.autodrain();
            processedEntries++;
        }
    });
}

module.exports = unzipFile;
