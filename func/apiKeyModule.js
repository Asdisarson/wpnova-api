// apiKeyModule.js

const { v4: uuidv4 } = require('uuid');
const SimpleJsonDb = require('simple-json-db');

// Initialize the database
const db = new SimpleJsonDb('./db.json');

function generateKey(userId) {
    const key = uuidv4();
    db.set(userId, key); // Save the generated key to the database using userId as the key
    return key;
}

function validateKey(key) {
    // Check if the userId exists in the database
    return db.has(key);
}

function deleteKey(userId) {
    // Remove the key associated with the userId from the database
    if (db.has(userId)) {
        db.delete(userId);
        return true;
    } else {
        return false;
    }
}

module.exports = {
    generateKey,
    validateKey,
    deleteKey,
};
