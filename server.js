require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = (...args) =>
    import('node-fetch').then(({ default: fetch }) => fetch(...args));

const admin = require('firebase-admin');

const app = express();

// Parse Firebase config from environment variable
const firebaseConfig = JSON.parse(process.env.FIREBASE_KEY);

// Fix newline characters in private key if needed
if (firebaseConfig.private_key) {
    firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, '\n');
}

// Firebase Admin - pass the modified config
admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig)
});

const db = admin.firestore();

// Middleware
app.use(express.json());
app.use(cors({
    origin: process.env.FRONTEND_URL
}));

// Health check (VERY IMPORTANT)
app.get('/', (req, res) => {
    res.send('Salwa backend is running 🚀');
});

// Create Yoco checkout
app.post('/create-checkout', async (req, res) => {
    try {
        const { amount, metadata } = req.body;

        if (!amount) {
            return res.status(400).json({ error: 'Amount is required' });
        }

        const response = await fetch('https://payments.yoco.com/api/checkouts', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.YOCO_SECRET}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                amount,
                currency: 'ZAR',
                successUrl: `${process.env.FRONTEND_URL}/payment-success.html`,
                cancelUrl: `${process.env.FRONTEND_URL}/payment-cancelled.html`,
                failureUrl: `${process.env.FRONTEND_URL}/payment-failed.html`,
                metadata: metadata || {}
            })
        });

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json(data);
        }

        // Save checkout to Firestore (optional but recommended)
        await db.collection('checkouts').doc(data.id).set({
            ...data,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json(data);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Payment API failed' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});