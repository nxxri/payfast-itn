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
        // Save checkout to Firestore with link to booking
        await db.collection('checkouts').doc(data.id).set({
            bookingTicketNumber: metadata.bookingId,  // your booking number
            eventId: metadata.eventId,               // event ID
            checkoutId: data.id,                     // Yoco checkout ID
            ...data,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json(data);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Payment API failed' });
    }
});
// Webhook to handle Yoco payment events
app.post('/yoco-webhook', express.json(), async (req, res) => {
    try {
        const event = req.body;

        console.log('Received webhook:', JSON.stringify(event, null, 2));

        // Only act on successful payments
        if (event.type !== 'payment.succeeded') {
            console.log('Webhook event not a successful payment, ignoring');
            return res.sendStatus(200);
        }

        const checkoutId = event.payload?.metadata?.checkoutId;
        if (!checkoutId) {
            console.warn('Missing checkoutId in webhook payload');
            return res.sendStatus(400);
        }

        // 🔥 Find the booking using checkoutId
        const checkoutSnap = await db.collection('checkouts').doc(checkoutId).get();
        if (!checkoutSnap.exists) {
            console.error("Checkout not found:", checkoutId);
            return res.sendStatus(404);
        }

        const { bookingTicketNumber, eventId } = checkoutSnap.data();

        // 🔥 Update booking
        const bookingsSnapshot = await db.collection('bookings')
            .where('ticketNumber', '==', bookingTicketNumber)
            .get();

        if (!bookingsSnapshot.empty) {
            bookingsSnapshot.forEach(doc => {
                doc.ref.update({
                    status: 'CONFIRMED',
                    paidAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });
            console.log(`Booking ${bookingTicketNumber} confirmed`);
        } else {
            console.warn('No booking found for ticketNumber:', bookingTicketNumber);
        }

        // 🔥 Update event spots
        const eventRef = db.collection('events').doc(eventId);
        await db.runTransaction(async (tx) => {
            const eventSnap = await tx.get(eventRef);
            if (!eventSnap.exists) return;

            const available = eventSnap.data().availableSpots || 0;
            tx.update(eventRef, {
                availableSpots: Math.max(0, available - 1)
            });
        });
        console.log(`Event ${eventId} spots updated`);

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