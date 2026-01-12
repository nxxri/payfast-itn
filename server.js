
const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios');
const querystring = require('querystring');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Firebase init
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const BOOKINGS_COLLECTION = 'bookings';
const MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID;
const PASSPHRASE = process.env.PAYFAST_PASSPHRASE;

// PayFast URLs
const PAYFAST_VALIDATE_URL =
    process.env.PAYFAST_SANDBOX === 'true'
        ? 'https://sandbox.payfast.co.za/eng/query/validate'
        : 'https://www.payfast.co.za/eng/query/validate';

//Build PayFast signature string

function buildSignature(data) {
    const filtered = Object.keys(data)
        .filter(key => key !== 'signature' && data[key] !== '')
        .sort()
        .map(key => `${key}=${encodeURIComponent(data[key].trim()).replace(/%20/g, '+')}`)
        .join('&');

    const stringToHash = PASSPHRASE
        ? `${filtered}&passphrase=${encodeURIComponent(PASSPHRASE)}`
        : filtered;

    return crypto.createHash('md5').update(stringToHash).digest('hex');
}

//PayFast ITN endpoint
app.post('/payfast/itn', async (req, res) => {
    const data = req.body;

    try {
        // Merchant validation
        if (data.merchant_id !== MERCHANT_ID) {
            console.error('Invalid merchant ID');
            return res.status(200).send('Invalid merchant');
        }

        // Signature validation
        const calculatedSignature = buildSignature(data);
        if (calculatedSignature !== data.signature) {
            console.error('Signature mismatch');
            return res.status(200).send('Invalid signature');
        }

        // Validate with PayFast
        const pfResponse = await axios.post(
            PAYFAST_VALIDATE_URL,
            querystring.stringify(data),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        if (pfResponse.data !== 'VALID') {
            console.error('PayFast validation failed');
            return res.status(200).send('Invalid ITN');
        }

        // Booking verification
        const bookingId = data.m_payment_id;
        const bookingRef = db.collection(BOOKINGS_COLLECTION).doc(bookingId);
        const bookingSnap = await bookingRef.get();

        if (!bookingSnap.exists) {
            console.error('Booking not found');
            return res.status(200).send('Booking missing');
        }

        const booking = bookingSnap.data();

        if (Number(booking.amount) !== Number(data.amount_gross)) {
            console.error('Amount mismatch');
            return res.status(200).send('Amount mismatch');
        }

        // Update booking
        await bookingRef.update({
            status: 'paid',
            payfast_payment_id: data.pf_payment_id,
            payer_email: data.email_address,
            paid_at: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`Payment verified for booking ${bookingId}`);
        res.status(200).send('OK');

    } catch (err) {
        console.error('ITN Error:', err);
        res.status(500).send('Server error');
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));