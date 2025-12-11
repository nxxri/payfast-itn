const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios');
const querystring = require('querystring');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json()); // Add JSON parsing

// Initialize Firebase using environment variable from Render
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const bookingsCollection = 'bookings';

// Use sandbox or live URL based on environment variable
const PAYFAST_URL = process.env.PAYFAST_SANDBOX === 'true'
    ? 'https://sandbox.payfast.co.za/eng/query/validate'
    : 'https://www.payfast.co.za/eng/query/validate';

// Function to verify PayFast signature
function verifyPayFastSignature(data, passphrase = '') {
    let pfParamString = '';

    // Sort parameters alphabetically
    const sortedKeys = Object.keys(data).sort();

    // Concatenate parameters
    for (const key of sortedKeys) {
        if (key !== 'signature') {
            pfParamString += `${key}=${encodeURIComponent(data[key]).replace(/%20/g, '+')}&`;
        }
    }

    // Remove last ampersand
    pfParamString = pfParamString.slice(0, -1);

    // Add passphrase if provided
    if (passphrase) {
        pfParamString += `&passphrase=${encodeURIComponent(passphrase).replace(/%20/g, '+')}`;
    }

    // Calculate MD5 hash
    const calculatedSignature = crypto.createHash('md5').update(pfParamString).digest('hex');

    return calculatedSignature === data.signature;
}

app.post('/payfast-notify', async (req, res) => {
    const data = req.body;

    try {
        console.log('ITN received:', JSON.stringify(data, null, 2));

        // Verify signature first
        const isValidSignature = verifyPayFastSignature(data, process.env.PAYFAST_PASSPHRASE || '');

        if (!isValidSignature) {
            console.error('Invalid ITN signature');
            return res.status(400).send('Invalid signature');
        }

        // Verify ITN with PayFast
        const response = await axios.post(
            PAYFAST_URL,
            querystring.stringify(data),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Salwa-Collective-ITN/1.0'
                },
                timeout: 10000 // 10 second timeout
            }
        );

        if (response.data.trim() === 'VALID') {
            const bookingId = data.m_payment_id;
            const paymentStatus = data.payment_status;

            // Prepare update data
            const updateData = {
                paymentStatus: paymentStatus,
                payfastPaymentId: data.pf_payment_id,
                amountPaid: parseFloat(data.amount_gross),
                fee: parseFloat(data.amount_fee || 0),
                itnReceived: true,
                itnTimestamp: admin.firestore.FieldValue.serverTimestamp(),
                payerEmail: data.email_address,
                payerPhone: data.cell_number || '',
                payerName: data.name_first + ' ' + (data.name_last || ''),
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            };

            // Set main status based on payment status
            if (paymentStatus === 'COMPLETE') {
                updateData.status = 'confirmed';
                updateData.paymentDate = admin.firestore.FieldValue.serverTimestamp();
                updateData.isPaid = true;
            } else if (paymentStatus === 'CANCELLED') {
                updateData.status = 'cancelled';
                updateData.isPaid = false;
            } else if (paymentStatus === 'FAILED') {
                updateData.status = 'failed';
                updateData.isPaid = false;
            } else {
                updateData.status = paymentStatus.toLowerCase();
                updateData.isPaid = false;
            }

            // Store the full ITN data for reference
            updateData.itnData = data;

            // Update booking in Firestore
            await db.collection(bookingsCollection).doc(bookingId).update(updateData);

            console.log(`✅ ITN processed: Booking ${bookingId} - Status: ${paymentStatus}`);

            // TODO: Send confirmation email if payment is complete
            if (paymentStatus === 'COMPLETE') {
                // Add email sending logic here
                console.log(`📧 Email should be sent for booking ${bookingId}`);
            }

        } else {
            console.error('Invalid ITN response from PayFast:', response.data);
            // Still update Firestore for tracking
            const bookingId = data.m_payment_id;
            await db.collection(bookingsCollection).doc(bookingId).update({
                paymentStatus: 'validation_failed',
                lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                itnData: data
            });
        }

        // Always respond 200 to PayFast
        res.status(200).send('OK');
    } catch (err) {
        console.error('Error processing ITN:', err);

        // Try to log which booking failed
        if (data && data.m_payment_id) {
            console.error(`Failed booking ID: ${data.m_payment_id}`);
            // Mark as errored in Firestore
            try {
                await db.collection(bookingsCollection).doc(data.m_payment_id).update({
                    paymentStatus: 'itn_error',
                    lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                    itnError: err.message
                });
            } catch (firestoreErr) {
                console.error('Could not update Firestore with error:', firestoreErr);
            }
        }

        res.status(500).send('Server error');
    }
});

// Add endpoint to check payment status (for frontend polling)
app.post('/check-payment-status', async (req, res) => {
    try {
        const { bookingId } = req.body;

        if (!bookingId) {
            return res.status(400).json({ error: 'Booking ID required' });
        }

        const bookingDoc = await db.collection(bookingsCollection).doc(bookingId).get();

        if (!bookingDoc.exists) {
            return res.status(404).json({ error: 'Booking not found' });
        }

        const bookingData = bookingDoc.data();

        res.json({
            success: true,
            bookingId: bookingId,
            status: bookingData.status || 'pending',
            paymentStatus: bookingData.paymentStatus || 'pending',
            isPaid: bookingData.isPaid || false,
            itnReceived: bookingData.itnReceived || false,
            ticketNumber: bookingData.ticketNumber || '',
            eventName: bookingData.eventName || '',
            updatedAt: bookingData.lastUpdated || bookingData.createdAt
        });

    } catch (error) {
        console.error('Error checking payment status:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'PayFast ITN Handler',
        timestamp: new Date().toISOString()
    });
});

// Start server on Render assigned PORT
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));