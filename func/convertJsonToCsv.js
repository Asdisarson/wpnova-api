const fs = require('fs');
const { Parser } = require('json2csv');

function convertJsonToCsv(jsonData, outputPath, callback) {
    try {
        const fields = [
            'id',
            'productName',
            'date',
            'downloadLink',
            'productURL',
            'version',
            'name',
            'slug',
            'filename',
            'filePath',
            'productId',
            'fileUrl'
        ];
        const parser = new Parser({ fields });
        const csv = parser.parse(jsonData);
        fs.writeFile(outputPath, csv, (err) => {
            if (err) {
                callback(err);
            } else {
                callback(null);
            }
        });
    } catch (error) {
        callback(error);
    }
}

module.exports = convertJsonToCsv;
