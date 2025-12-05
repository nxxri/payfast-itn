const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios');
const querystring = require('querystring');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Initialize Firebase using environment variable from Render
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const bookingsCollection = 'bookings'; // Change to your Firestore collection name

app.post('/payfast-notify', async (req, res) => {
    const data = req.body;

    try {
        // Verify ITN with PayFast
        const response = await axios.post(
            'https://www.payfast.co.za/eng/query/validate',
            querystring.stringify(data),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        if (response.data === 'VALID') {
            const bookingId = data.m_payment_id;

            // Update booking in Firestore
            await db.collection(bookingsCollection).doc(bookingId).set({
                status: 'paid',
                amount: data.amount_gross,
                payer_email: data.email_address,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            console.log('Payment verified and booking updated');
            res.status(200).send('OK');
        } else {
            console.error('Invalid ITN');
            res.status(400).send('Invalid ITN');
        }
    } catch (err) {
        console.error('Error processing ITN:', err);
        res.status(500).send('Server error');
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
