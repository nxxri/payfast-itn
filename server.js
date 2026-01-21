require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch'); // Node 18+ can use global fetch
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();

// Initialize Firebase Admin
admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY))
});

const db = admin.firestore();

app.use(express.json());

// Enable CORS for your frontend only
app.use(cors({
    origin: process.env.FRONTEND_URL
}));

// Health check
app.get('/', (req, res) => {
    res.send('Backend is running!');
});

// Create Yoco checkout
app.post('/create-checkout', async (req, res) => {
    try {
        const { amount, metadata } = req.body;

        if (!amount || isNaN(amount)) {
            return res.status(400).json({ error: 'Amount (in cents) is required and must be a number' });
        }

        // Prepare request to Yoco
        const response = await fetch('https://payments.yoco.com/api/checkouts', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.YOCO_SECRET}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                amount,
                currency: 'ZAR',
                successUrl: `${process.env.FRONTEND_URL}/payment-success`,
                cancelUrl: `${process.env.FRONTEND_URL}/payment-cancelled`,
                failureUrl: `${process.env.FRONTEND_URL}/payment-failed`,
                metadata: metadata || {}
            })
        });

        if (!response.ok) {
            const text = await response.text();
            return res.status(response.status).json({ error: text });
        }

        const data = await response.json();

        // Optional: store checkout info in Firestore
        await db.collection('checkouts').doc(data.id).set({
            ...data,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json(data);

    } catch (err) {
        console.error('Yoco checkout error:', err);
        res.status(500).json({ error: 'Payment API failed', details: err.message });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
