// adminRoutes.js

const express = require('express');
const { generateKey } = require('../func/apiKeyModule');
const router = express.Router();

router.post('/generate', (req, res) => {
    if (!req.isAdmin) {
        return res.status(403).json({ message: 'Forbidden' });
    }

    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ message: 'User ID required' });
    }

    const key = generateKey(userId);

    res.json({ apiKey: key });
});

module.exports = router;
