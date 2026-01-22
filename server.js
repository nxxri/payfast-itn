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
// Send yoco webhook
app.post('/yoco-webhook', express.json(), async (req, res) => {
    try {
        const event = req.body;

        if (event.type !== 'payment.succeeded') {
            return res.sendStatus(200);
        }

        const metadata = event?.data?.metadata;

        if (!metadata?.bookingId || !metadata?.eventId) {
            console.error('Missing metadata:', metadata);
            return res.sendStatus(400);
        }

        const { bookingId, eventId } = metadata;

        const bookingSnap = await db
            .collection('bookings')
            .where('ticketNumber', '==', bookingId)
            .limit(1)
            .get();

        if (bookingSnap.empty) {
            console.error('Booking not found:', bookingId);
            return res.sendStatus(404);
        }

        const bookingDoc = bookingSnap.docs[0];
        const bookingData = bookingDoc.data();

        // ✅ Prevent double processing
        if (bookingData.status === 'CONFIRMED') {
            console.log('Booking already confirmed:', bookingId);
            return res.sendStatus(200);
        }

        // 🔥 Transaction for consistency
        await db.runTransaction(async (tx) => {
            const eventRef = db.collection('events').doc(eventId);
            const eventSnap = await tx.get(eventRef);

            if (!eventSnap.exists) {
                throw new Error('Event not found');
            }

            const available = eventSnap.data().availableSpots;

            if (available <= 0) {
                throw new Error('No spots left');
            }

            tx.update(bookingDoc.ref, {
                status: 'CONFIRMED',
                paidAt: admin.firestore.FieldValue.serverTimestamp()
            });

            tx.update(eventRef, {
                availableSpots: available - 1
            });
        });

        res.sendStatus(200);

    } catch (err) {
        console.error('Webhook error:', err);
        res.sendStatus(500);
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});