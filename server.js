const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const querystring = require('querystring');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();

// Enable CORS
app.use((req, res, next) => {
    const allowedOrigins = [
        'https://salwacollective.co.za',
        'https://www.salwacollective.co.za',
        'http://localhost:3000',
        'http://127.0.0.1:5500'
    ];

    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    next();
});

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

console.log('🚀 Salwa PayFast Backend Starting...');

// Initialize Firebase if key is available
if (process.env.FIREBASE_KEY) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
        console.log('✅ Firebase initialized');
    } catch (error) {
        console.error('❌ Firebase init error:', error.message);
    }
}

const db = process.env.FIREBASE_KEY ? admin.firestore() : null;
const BOOKINGS_COLLECTION = 'bookings';
const MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID || '10044213';
const PASSPHRASE = process.env.PAYFAST_PASSPHRASE || 'Salwa20242024';

// ==================== ENDPOINTS ====================

// 1. Root endpoint
app.get('/', (req, res) => {
    res.json({
        service: 'Salwa PayFast Backend',
        status: 'running',
        endpoints: {
            health: 'GET /health',
            createBooking: 'POST /bookings',
            simulatePayment: 'POST /simulate-payfast',
            payfastITN: 'POST /payfast/itn',
            checkBooking: 'GET /bookings/:id'
        },
        cors: 'enabled',
        frontend: 'https://salwacollective.co.za'
    });
});

// 2. Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        firebase: db ? 'connected' : 'disabled',
        merchantId: MERCHANT_ID,
        environment: process.env.PAYFAST_SANDBOX === 'true' ? 'sandbox' : 'production'
    });
});

// 3. Create booking (frontend calls this first)
app.post('/bookings', async (req, res) => {
    try {
        console.log('Creating booking:', req.body);

        const { eventId, eventName, customerName, customerEmail, customerPhone, ticketQuantity, amount } = req.body;

        // Generate booking ID
        const bookingId = 'BK-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9).toUpperCase();

        const bookingData = {
            bookingId: bookingId,
            eventId: eventId,
            eventName: eventName,
            customer: {
                name: customerName,
                email: customerEmail,
                phone: customerPhone
            },
            ticketQuantity: ticketQuantity,
            amount: amount,
            status: 'pending',
            createdAt: new Date().toISOString(),
            paymentStatus: 'pending'
        };

        // Save to Firebase if available
        if (db) {
            await db.collection(BOOKINGS_COLLECTION).doc(bookingId).set(bookingData);
            console.log('✅ Booking saved to Firebase:', bookingId);
        }

        res.json({
            success: true,
            bookingId: bookingId,
            bookingData: bookingData,
            payment: {
                merchantId: MERCHANT_ID,
                amount: amount,
                itemName: `Salwa Event: ${eventName}`,
                returnUrl: 'https://salwacollective.co.za/booking-success.html',
                cancelUrl: 'https://salwacollective.co.za/booking-cancel.html',
                notifyUrl: `https://payfast-backend-o9gn.onrender.com/payfast/itn`
            }
        });

    } catch (error) {
        console.error('Booking creation error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 4. Simulate PayFast payment (for testing)
app.post('/simulate-payfast', async (req, res) => {
    try {
        console.log('Simulating PayFast payment:', req.body);

        const { bookingId, amount, customerEmail, eventName } = req.body;

        // In sandbox mode, simulate successful payment
        const paymentResult = {
            success: true,
            paymentId: 'PF-' + Date.now(),
            bookingId: bookingId,
            amount: amount,
            status: 'COMPLETE',
            message: 'Payment simulated successfully (sandbox mode)',
            sandbox: true,
            redirectUrl: 'https://sandbox.payfast.co.za/eng/process/pay', // Example PayFast URL
            timestamp: new Date().toISOString()
        };

        // If Firebase is available, update booking
        if (db && bookingId) {
            try {
                await db.collection(BOOKINGS_COLLECTION).doc(bookingId).update({
                    status: 'paid',
                    paymentStatus: 'complete',
                    paidAt: new Date().toISOString(),
                    paymentId: paymentResult.paymentId
                });
                console.log('✅ Booking updated in Firebase');
            } catch (firebaseError) {
                console.error('Firebase update error:', firebaseError);
            }
        }

        res.json(paymentResult);

    } catch (error) {
        console.error('Payment simulation error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 5. Real PayFast ITN endpoint
app.post('/payfast/itn', async (req, res) => {
    console.log('📥 Real PayFast ITN received');

    try {
        const data = req.body;
        console.log('ITN Data:', data);

        // Build signature
        const buildSignature = (data) => {
            const filtered = Object.keys(data)
                .filter(key => key !== 'signature' && data[key] !== '' && data[key] !== undefined)
                .sort()
                .map(key => `${key}=${encodeURIComponent(data[key].toString().trim()).replace(/%20/g, '+')}`)
                .join('&');

            const stringToHash = PASSPHRASE
                ? `${filtered}&passphrase=${encodeURIComponent(PASSPHRASE)}`
                : filtered;

            return crypto.createHash('md5').update(stringToHash).digest('hex');
        };

        // Validate signature
        const calculatedSignature = buildSignature(data);
        if (calculatedSignature !== data.signature) {
            console.error('Signature mismatch');
            return res.status(200).send('Invalid signature');
        }

        // Update booking in Firebase
        const bookingId = data.m_payment_id;
        if (db && bookingId) {
            await db.collection(BOOKINGS_COLLECTION).doc(bookingId).update({
                status: 'paid',
                paymentStatus: 'complete',
                payfastPaymentId: data.pf_payment_id,
                payerEmail: data.email_address,
                amountPaid: data.amount_gross,
                paidAt: new Date().toISOString()
            });
            console.log('✅ Real payment recorded for booking:', bookingId);
        }

        res.status(200).send('OK');

    } catch (error) {
        console.error('ITN processing error:', error);
        res.status(200).send('ERROR');
    }
});

// 6. Check booking status
app.get('/bookings/:id', async (req, res) => {
    try {
        const bookingId = req.params.id;

        if (!db) {
            return res.json({
                bookingId: bookingId,
                status: 'unknown',
                message: 'Firebase not connected'
            });
        }

        const bookingRef = db.collection(BOOKINGS_COLLECTION).doc(bookingId);
        const bookingSnap = await bookingRef.get();

        if (!bookingSnap.exists) {
            return res.status(404).json({
                error: 'Booking not found',
                bookingId: bookingId
            });
        }

        const booking = bookingSnap.data();
        res.json(booking);

    } catch (error) {
        console.error('Booking check error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 7. Generate PayFast form data (for direct PayFast integration)
app.post('/generate-payfast-data', (req, res) => {
    try {
        const { bookingId, amount, customerEmail, customerName, eventName } = req.body;

        const nameParts = customerName.split(' ');
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || '';

        // Generate PayFast signature
        const generateSignature = (data) => {
            const filtered = Object.keys(data)
                .filter(key => data[key] !== '' && data[key] !== undefined)
                .sort()
                .map(key => `${key}=${encodeURIComponent(data[key].toString().trim()).replace(/%20/g, '+')}`)
                .join('&');

            const stringToHash = PASSPHRASE
                ? `${filtered}&passphrase=${encodeURIComponent(PASSPHRASE)}`
                : filtered;

            return crypto.createHash('md5').update(stringToHash).digest('hex');
        };

        const payfastData = {
            merchant_id: MERCHANT_ID,
            merchant_key: process.env.PAYFAST_MERCHANT_KEY || '9s7vajpkdyycf',
            return_url: 'https://salwacollective.co.za/booking-success.html',
            cancel_url: 'https://salwacollective.co.za/booking-cancel.html',
            notify_url: 'https://payfast-backend-o9gn.onrender.com/payfast/itn',
            name_first: firstName.substring(0, 100),
            name_last: lastName.substring(0, 100),
            email_address: customerEmail.substring(0, 100),
            m_payment_id: bookingId,
            amount: parseFloat(amount).toFixed(2),
            item_name: `Salwa Event: ${eventName}`.substring(0, 100),
            item_description: `Ticket booking for ${eventName}`.substring(0, 255),
            email_confirmation: '1',
            confirmation_address: customerEmail.substring(0, 100)
        };

        // Generate signature
        payfastData.signature = generateSignature(payfastData);

        // Determine PayFast URL
        const payfastUrl = process.env.PAYFAST_SANDBOX === 'true'
            ? 'https://sandbox.payfast.co.za/eng/process'
            : 'https://www.payfast.co.za/eng/process';

        res.json({
            success: true,
            payfastUrl: payfastUrl,
            formData: payfastData,
            method: 'POST'
        });

    } catch (error) {
        console.error('PayFast data generation error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
    ┌─────────────────────────────────────────────────┐
    │     Salwa PayFast Backend                       │
    │                                                 │
    │  ✅ Server: https://payfast-backend-o9gn.onrender.com
    │  🔧 Port: ${PORT}                                 │
    │  💰 Merchant ID: ${MERCHANT_ID}                    │
    │  🌐 Frontend: https://salwacollective.co.za     │
    │  🔥 Firebase: ${db ? '✅ Connected' : '❌ Disabled'}
    │                                                 │
    │  📍 Test Endpoints:                             │
    │     • POST /bookings      - Create booking      │
    │     • POST /simulate-payfast - Test payment     │
    │     • GET  /bookings/:id  - Check booking       │
    │                                                 │
    │  🌐 Health: /health                             │
    └─────────────────────────────────────────────────┘
    `);
});