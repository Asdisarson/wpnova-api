const AdmZip = require('adm-zip');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const SimpleJsonDb = require('simple-json-db');
const archiver = require('archiver');

const fileDB = new SimpleJsonDb('./files.json');

function hasRequiredFiles(entryNames, requiredFiles) {
    return requiredFiles.every(requiredFile => entryNames.some(entry => entry.includes(requiredFile)));
}

function hasWordPressHeaders(zip, entryNames, header) {
    return entryNames.some(entryName => {
        if (entryName.endsWith('.php') || entryName.endsWith('style.css')) {
            const contents = zip.readAsText(entryName);
            return contents.includes(header);
        }
        return false;
    });
}

function moveFile(source, destination) {
    if (!fs.existsSync(path.dirname(destination))) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
    }
    fs.renameSync(source, destination);
}

function checkAndMoveNestedZipFiles(zip, entries, parentZip) {
    for (const entry of entries) {
        if (entry.entryName.endsWith('.zip')) {
            const tempDir = path.join(os.tmpdir(), uuidv4());
            fs.mkdirSync(tempDir, { recursive: true });
            zip.extractEntryTo(entry, tempDir, false, true);
            const nestedZip = path.join(tempDir, entry.entryName);
            const result = isValidPluginOrTheme(nestedZip);
            if (result !== 'none') {
                const newFileLocation = path.join('public', 'converted', `wordpress ${result}s`, path.basename(parentZip), path.basename(nestedZip));
                console.log(`The file ${nestedZip} is a WordPress ${result}. Moving to ${newFileLocation}`);
                moveFile(nestedZip, newFileLocation);
                fileDB.set(uuidv4(), { status: 'successful', location: newFileLocation });
            } else {
                fileDB.set(uuidv4(), { status: 'unsuccessful', location: nestedZip });
            }
        }
    }
}

function isValidPluginOrTheme(zipPath) {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    const entryNames = entries.map(entry => entry.entryName);

    const themeFiles = ['style.css', 'index.php', 'functions.php', 'screenshot.png'];
    const pluginFiles = ['readme.txt'];

    const isTheme = hasRequiredFiles(entryNames, themeFiles) && hasWordPressHeaders(zip, entryNames, 'Theme Name:');
    const isPlugin = hasRequiredFiles(entryNames, pluginFiles) && hasWordPressHeaders(zip, entryNames, 'Plugin Name:');

    if (isTheme && isPlugin) {
        return 'mixed';
    } else if (isTheme) {
        return 'theme';
    } else if (isPlugin) {
        return 'plugin';
    }

    checkAndMoveNestedZipFiles(zip, entries, zipPath);

    return 'none';
}

async function zipAndMoveOutput(directory) {
    const archive = archiver('zip', {
        zlib: { level: 9 }
    });

    const output = fs.createWriteStream(path.join('public', 'downloads', 'converted.zip'));

    archive.pipe(output);
    archive.directory(directory, false);
    await archive.finalize();

    // Remove the original directory
    fs.removeSync(directory);

    console.log(`Zipped and moved converted files to public/downloads/converted.zip`);
}

async function checkAndConvertZip(zipFile) {
    const result = isValidPluginOrTheme(zipFile);
    if (result !== 'none') {
        const newFileLocation = path.join('public', 'converted', `wordpress ${result}s`, path.basename(zipFile));
        console.log(`The file ${zipFile} is a WordPress ${result}. Moving to ${newFileLocation}`);
        moveFile(zipFile, newFileLocation);
        fileDB.set(uuidv4(), { status: 'successful', location: newFileLocation });
    } else {
        console.log(`The file ${zipFile} is neither a WordPress theme nor a plugin.`);
        fileDB.set(uuidv4(), { status: 'unsuccessful', location: zipFile });
    }

    await zipAndMoveOutput(path.join('public', 'converted'));
}

module.exports = function(zipFilePath) {
   return checkAndConvertZip(zipFilePath);
}
