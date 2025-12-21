const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios');
const querystring = require('querystring');
const crypto = require('crypto');
const cors = require('cors');

const app = express();

// ===== CORS Configuration =====
const corsOptions = {
    origin: function (origin, callback) {
        console.log('🌍 CORS Origin check:', origin);

        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) {
            console.log('🌍 No origin, allowing');
            return callback(null, true);
        }

        const express = require('express');
        const bodyParser = require('body-parser');
        const admin = require('firebase-admin');
        const axios = require('axios');
        const querystring = require('querystring');
        const crypto = require('crypto');
        const cors = require('cors');

        const app = express();

        // ===== CORS Configuration =====
        const allowedOrigins = [
            "https://salwacollective.co.za",
            "http://localhost:3000",
            "http://localhost:5500",
            "http://127.0.0.1:5500"
        ];

        const corsOptions = {
            origin: function (origin, callback) {
                console.log('🌍 CORS Origin check:', origin);

                // Allow requests with no origin (like mobile apps or curl requests)
                if (!origin || allowedOrigins.includes(origin)) {
                    console.log('🌍 Origin allowed:', origin || 'no origin');
                    callback(null, true);
                } else {
                    console.log('❌ Origin blocked:', origin);
                    callback(new Error('Not allowed by CORS'));
                }
            },
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
            allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Origin', 'Accept', 'x-requested-with'],
            exposedHeaders: ['Content-Range', 'X-Content-Range'],
            maxAge: 86400 // 24 hours
        };

        // Apply CORS middleware FIRST
        app.use(cors(corsOptions));

        // Body parsers
        app.use(bodyParser.urlencoded({ extended: true }));
        app.use(bodyParser.json());

        // Add explicit preflight handler
        app.options('*', cors(corsOptions));

        // Debug middleware
        app.use((req, res, next) => {
            console.log(`📥 ${req.method} ${req.url}`);
            console.log('📦 Request Body:', req.body);
            console.log('📦 Content-Type:', req.headers['content-type']);
            console.log('🌍 Origin:', req.headers.origin);
            next();
        });

        // ========== FIREBASE INIT ==========
        const serviceAccount = JSON.parse(process.env.FIREBASE_KEY || '{}');
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
        const db = admin.firestore();

        // ========== PAYFAST CONFIG ==========
        const PAYFAST_CONFIG = {
            merchantId: process.env.PAYFAST_MERCHANT_ID,
            merchantKey: process.env.PAYFAST_MERCHANT_KEY,
            passphrase: process.env.PAYFAST_PASSPHRASE || '',
            sandbox: process.env.PAYFAST_SANDBOX === 'true',
            productionUrl: "https://www.payfast.co.za/eng/process",
            sandboxUrl: "https://sandbox.payfast.co.za/eng/process"
        };

        // ========== HELPER FUNCTIONS ==========
        function convertFirestoreTimestamp(timestamp) {
            if (!timestamp) return new Date();
            if (timestamp.toDate) return timestamp.toDate();
            if (timestamp.seconds) return new Date(timestamp.seconds * 1000);
            if (timestamp._seconds) return new Date(timestamp._seconds * 1000);
            return new Date(timestamp);
        }

        function generatePayFastSignature(data, passPhrase = null) {
            console.log('🔍 Generating PayFast signature...');

            const signatureData = { ...data };
            delete signatureData.signature;

            const sortedKeys = Object.keys(signatureData).sort();
            let pfOutput = '';

            for (let key of sortedKeys) {
                if (signatureData[key] !== undefined && signatureData[key] !== null) {
                    const value = signatureData[key].toString();
                    const encodedValue = encodeURIComponent(value)
                        .replace(/%20/g, '+')
                        .replace(/'/g, '%27')
                        .replace(/"/g, '%22')
                        .replace(/\(/g, '%28')
                        .replace(/\)/g, '%29')
                        .replace(/\*/g, '%2A')
                        .replace(/!/g, '%21');
                    pfOutput += `${key}=${encodedValue}&`;
                }
            }

            if (pfOutput.endsWith('&')) {
                pfOutput = pfOutput.slice(0, -1);
            }

            if (passPhrase !== null && passPhrase !== undefined && passPhrase !== '') {
                const encodedPassphrase = encodeURIComponent(passPhrase)
                    .replace(/%20/g, '+')
                    .replace(/'/g, '%27')
                    .replace(/"/g, '%22')
                    .replace(/\(/g, '%28')
                    .replace(/\)/g, '%29')
                    .replace(/\*/g, '%2A')
                    .replace(/!/g, '%21');
                pfOutput += `&passphrase=${encodedPassphrase}`;
            }

            console.log('🔍 Signature string for MD5:', pfOutput);
            console.log('🔍 Passphrase used:', passPhrase || 'NONE');

            return crypto.createHash('md5').update(pfOutput).digest('hex');
        }

        function verifyPayFastSignature(data, passphrase = '') {
            console.log('🔍 Verifying PayFast signature...');

            const submittedSignature = data.signature;
            const signatureData = { ...data };
            delete signatureData.signature;

            const sortedKeys = Object.keys(signatureData).sort();
            let pfParamString = '';

            for (const key of sortedKeys) {
                if (signatureData[key] !== undefined && signatureData[key] !== null) {
                    const value = signatureData[key].toString();
                    const encodedValue = encodeURIComponent(value)
                        .replace(/%20/g, '+')
                        .replace(/'/g, '%27')
                        .replace(/"/g, '%22')
                        .replace(/\(/g, '%28')
                        .replace(/\)/g, '%29')
                        .replace(/\*/g, '%2A')
                        .replace(/!/g, '%21');
                    pfParamString += `${key}=${encodedValue}&`;
                }
            }

            if (pfParamString.endsWith('&')) {
                pfParamString = pfParamString.slice(0, -1);
            }

            if (passphrase !== null && passphrase !== undefined && passphrase !== '') {
                const encodedPassphrase = encodeURIComponent(passphrase)
                    .replace(/%20/g, '+')
                    .replace(/'/g, '%27')
                    .replace(/"/g, '%22')
                    .replace(/\(/g, '%28')
                    .replace(/\)/g, '%29')
                    .replace(/\*/g, '%2A')
                    .replace(/!/g, '%21');
                pfParamString += `&passphrase=${encodedPassphrase}`;
            }

            const calculatedSignature = crypto.createHash('md5').update(pfParamString).digest('hex');

            console.log('🔍 Signature comparison:');
            console.log('Submitted:', submittedSignature);
            console.log('Calculated:', calculatedSignature);
            console.log('Match?', calculatedSignature === submittedSignature);

            return calculatedSignature === submittedSignature;
        }

        // ========== SIMPLIFIED PROCESS PAYMENT ==========
        app.post('/process-payment', async (req, res) => {
            try {
                console.log('🔵 Payment request received:', req.body);

                const {
                    amount, item_name, name_first, name_last, email_address,
                    cell_number, event_id, ticket_number, booking_id, ticket_quantity,
                    event_name, event_date
                } = req.body;

                // Basic validation
                if (!amount || !item_name || !email_address || !booking_id) {
                    return res.status(400).json({
                        success: false,
                        error: 'Missing required fields',
                        received: req.body
                    });
                }

                const renderUrl = process.env.RENDER_EXTERNAL_URL || `https://${req.get('host')}`;

                // Build URLs dynamically with booking_id
                const returnUrl = `https://salwacollective.co.za/payment-result.html?pf_status=success&booking_id=${booking_id}`;
                const cancelUrl = `https://salwacollective.co.za/payment-result.html?pf_status=cancelled&booking_id=${booking_id}`;

                // SIMPLIFIED payment data - PayFast prefers minimal fields
                const paymentData = {
                    merchant_id: PAYFAST_CONFIG.merchantId,
                    merchant_key: PAYFAST_CONFIG.merchantKey,
                    return_url: returnUrl,
                    cancel_url: cancelUrl,
                    notify_url: `${renderUrl}/payfast-notify`,
                    name_first: name_first || '',
                    name_last: name_last || '',
                    email_address: email_address,
                    cell_number: cell_number || '',
                    amount: parseFloat(amount).toFixed(2),
                    item_name: item_name.substring(0, 100),
                    m_payment_id: booking_id,
                    custom_str1: event_id || '',
                    custom_str2: ticket_number || '',
                    custom_str3: booking_id || '',
                    custom_int1: ticket_quantity || 1
                };

                Object.keys(paymentData).forEach(key => {
                    if (paymentData[key] === null || paymentData[key] === undefined) {
                        delete paymentData[key];
                    }
                });

                console.log('🟡 Payment data for signature:', paymentData);

                const signature = generatePayFastSignature(paymentData, PAYFAST_CONFIG.passphrase);
                paymentData.signature = signature;

                console.log('🔍 Generated signature:', signature);
                console.log('🔍 Mode:', PAYFAST_CONFIG.sandbox ? 'SANDBOX' : 'PRODUCTION');

                // Store booking with timeout tracking in Firestore
                try {
                    const bookingData = {
                        // Core booking info from frontend
                        bookingId: booking_id,
                        eventId: event_id || '',
                        ticketNumber: ticket_number || '',
                        ticketQuantity: ticket_quantity || 1,
                        totalAmount: parseFloat(amount),
                        itemName: item_name,
                        eventName: event_name || item_name,
                        eventDate: event_date || '',

                        // Customer info
                        customerEmail: email_address,
                        customerFirstName: name_first || '',
                        customerLastName: name_last || '',
                        customerPhone: cell_number || '',
                        userName: `${name_first || ''} ${name_last || ''}`.trim(),

                        // Payment tracking
                        status: 'pending_payment',
                        paymentStatus: 'PENDING',
                        isPaid: false,
                        itnReceived: false,

                        // Timestamps
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),

                        // Timeout tracking - 30 minutes from now
                        paymentTimeout: new Date(Date.now() + 30 * 60 * 1000),

                        // Payment method info
                        paymentMethod: 'payfast',
                        paymentGateway: 'payfast',
                        gatewayData: {
                            merchantId: PAYFAST_CONFIG.merchantId,
                            sandbox: PAYFAST_CONFIG.sandbox,
                            signature: signature
                        },

                        // Additional metadata
                        ipAddress: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
                        userAgent: req.headers['user-agent'] || ''
                    };

                    await db.collection('bookings').doc(booking_id).set(bookingData, { merge: true });
                    console.log(`✅ Booking ${booking_id} stored in Firestore with 30-minute timeout`);

                } catch (firestoreError) {
                    console.error('🔴 Firestore save error:', firestoreError);
                }

                // Create redirect URL
                const payfastUrl = PAYFAST_CONFIG.sandbox ? PAYFAST_CONFIG.sandboxUrl : PAYFAST_CONFIG.productionUrl;
                const queryString = new URLSearchParams(paymentData).toString();
                const redirectUrl = `${payfastUrl}?${queryString}`;

                console.log('🟢 Full redirect URL:', redirectUrl);

                res.json({
                    success: true,
                    redirectUrl: redirectUrl,
                    bookingId: booking_id,
                    signature: signature
                });

            } catch (error) {
                console.error('🔴 Payment processing error:', error);
                res.status(500).json({
                    success: false,
                    error: 'Payment processing failed',
                    message: error.message
                });
            }
        });

        // ========== MANUAL TEST ENDPOINT ==========
        app.get('/manual-test', (req, res) => {
            // Use a test booking ID
            const testBookingId = 'test-' + Date.now();
            const returnUrl = `https://salwacollective.co.za/payment-result.html?pf_status=success&booking_id=${testBookingId}`;
            const cancelUrl = `https://salwacollective.co.za/payment-result.html?pf_status=cancelled&booking_id=${testBookingId}`;

            const testData = {
                merchant_id: PAYFAST_CONFIG.merchantId,
                merchant_key: PAYFAST_CONFIG.merchantKey,
                return_url: returnUrl,
                cancel_url: cancelUrl,
                notify_url: 'https://salwa-payment-backend-1.onrender.com/payfast-notify',
                name_first: 'Test',
                name_last: 'User',
                email_address: 'test@example.com',
                amount: '5.00',
                item_name: 'Salwa Collective Test',
                m_payment_id: testBookingId
            };

            const signature = generatePayFastSignature(testData, PAYFAST_CONFIG.passphrase);
            testData.signature = signature;

            const queryString = new URLSearchParams(testData).toString();
            const testUrl = `${PAYFAST_CONFIG.sandboxUrl}?${queryString}`;

            res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>PayFast Manual Test</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; }
                .container { background: #f5f5f5; padding: 20px; border-radius: 10px; }
                .url-box { background: white; padding: 15px; border: 1px solid #ddd; border-radius: 5px; word-break: break-all; }
                .btn { background: #4CAF50; color: white; padding: 12px 24px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; }
                .test-card { background: #e8f5e9; padding: 15px; border-radius: 5px; margin-top: 20px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🧪 PayFast Sandbox Test</h1>
                <p><strong>Status:</strong> Using merchant ID: ${PAYFAST_CONFIG.merchantId}</p>
                <p><strong>Passphrase:</strong> ${PAYFAST_CONFIG.passphrase ? 'SET' : 'NOT SET'}</p>
                <p><strong>Signature:</strong> ${signature.substring(0, 20)}...</p>
                
                <h3>Test Payment Link:</h3>
                <div class="url-box">${testUrl}</div>
                
                <p style="margin-top: 20px;">
                    <a href="${testUrl}" target="_blank" class="btn">Open PayFast Payment Page</a>
                </p>
                
                <div class="test-card">
                    <h3>💳 Test Card Details:</h3>
                    <ul>
                        <li><strong>Card Number:</strong> 4000 0000 0000 0002</li>
                        <li><strong>Expiry Date:</strong> Any future date (e.g., 12/30)</li>
                        <li><strong>CVV:</strong> 123</li>
                        <li><strong>3D Secure Password:</strong> payfast</li>
                    </ul>
                    <p><em>This is a test payment - no real money will be charged.</em></p>
                </div>
                
                <div style="margin-top: 30px; padding: 15px; background: #fff3cd; border-radius: 5px;">
                    <h3>⚠️ Troubleshooting</h3>
                    <p>If you get "signature mismatch":</p>
                    <ol>
                        <li>Check your PayFast merchant dashboard passphrase setting</li>
                        <li>Verify merchant ID and key in Render environment variables</li>
                        <li>Try clearing browser cache and cookies</li>
                    </ol>
                </div>
            </div>
        </body>
        </html>
    `);
        });

        // ========== ITN HANDLER ==========
        app.post('/payfast-notify', async (req, res) => {
            const data = req.body;

            try {
                console.log('🟣 ITN received:', JSON.stringify(data, null, 2));

                const isValidSignature = verifyPayFastSignature(data, PAYFAST_CONFIG.passphrase);

                if (!isValidSignature) {
                    console.error('🔴 Invalid ITN signature');
                    return res.status(400).send('Invalid signature');
                }

                const verifyUrl = PAYFAST_CONFIG.sandbox
                    ? 'https://sandbox.payfast.co.za/eng/query/validate'
                    : 'https://www.payfast.co.za/eng/query/validate';

                const response = await axios.post(
                    verifyUrl,
                    querystring.stringify(data),
                    {
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'User-Agent': 'Salwa-Collective-ITN/1.0'
                        },
                        timeout: 10000
                    }
                );

                if (response.data.trim() === 'VALID') {
                    const bookingId = data.m_payment_id;
                    const paymentStatus = data.payment_status?.toUpperCase() || '';

                    console.log(`🟢 Valid ITN for booking ${bookingId}, status: ${paymentStatus}`);

                    const updateData = {
                        paymentStatus: paymentStatus,
                        payfastPaymentId: data.pf_payment_id,
                        amountPaid: parseFloat(data.amount_gross),
                        fee: parseFloat(data.amount_fee || 0),
                        itnReceived: true,
                        itnTimestamp: admin.firestore.FieldValue.serverTimestamp(),
                        payerEmail: data.email_address,
                        payerPhone: data.cell_number || '',
                        payerName: `${data.name_first || ''} ${data.name_last || ''}`.trim(),
                        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                        itnData: data
                    };

                    if (paymentStatus === 'COMPLETE') {
                        updateData.status = 'confirmed';
                        updateData.paymentDate = admin.firestore.FieldValue.serverTimestamp();
                        updateData.isPaid = true;
                    } else if (paymentStatus === 'CANCELLED' || paymentStatus === 'USER_CANCELLED') {
                        updateData.status = 'cancelled';
                        updateData.isPaid = false;
                        updateData.cancellationReason = 'user_cancelled_on_payfast';
                        updateData.cancelledAt = admin.firestore.FieldValue.serverTimestamp();
                    } else if (paymentStatus === 'FAILED') {
                        updateData.status = 'failed';
                        updateData.isPaid = false;
                        updateData.cancellationReason = 'payment_failed';
                        updateData.cancelledAt = admin.firestore.FieldValue.serverTimestamp();
                    } else {
                        updateData.status = paymentStatus.toLowerCase();
                        updateData.isPaid = false;
                    }

                    await db.collection('bookings').doc(bookingId).update(updateData);
                    console.log(`✅ Booking ${bookingId} updated in Firebase`);

                } else {
                    console.error('🔴 Invalid ITN response from PayFast:', response.data);
                }

                res.status(200).send('OK');

            } catch (err) {
                console.error('🔴 ITN processing error:', err);

                if (data && data.m_payment_id) {
                    try {
                        await db.collection('bookings').doc(data.m_payment_id).update({
                            paymentStatus: 'itn_error',
                            lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                            itnError: err.message
                        });
                    } catch (firestoreErr) {
                        console.error('Could not update Firestore:', firestoreErr);
                    }
                }

                res.status(500).send('Server error');
            }
        });

        // ========== CHECK PAYMENT STATUS ==========
        app.post('/check-payment-status', async (req, res) => {
            try {
                const { bookingId } = req.body;

                if (!bookingId) {
                    return res.status(400).json({
                        success: false,
                        error: 'Booking ID required'
                    });
                }

                const bookingDoc = await db.collection('bookings').doc(bookingId).get();

                if (!bookingDoc.exists) {
                    return res.status(404).json({
                        success: false,
                        error: 'Booking not found'
                    });
                }

                const bookingData = bookingDoc.data();

                // Auto-cancel if payment has timed out
                if (bookingData.paymentTimeout) {
                    const timeoutDate = convertFirestoreTimestamp(bookingData.paymentTimeout);
                    const now = new Date();

                    if (timeoutDate < now &&
                        (bookingData.status === 'pending' || bookingData.status === 'pending_payment')) {

                        console.log(`⏰ Auto-cancelling timed out booking: ${bookingId}`);

                        const updateData = {
                            status: 'cancelled',
                            paymentStatus: 'TIMEOUT_AUTO_CANCELLED',
                            isPaid: false,
                            cancellationReason: 'payment_timeout',
                            cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
                            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                        };

                        await db.collection('bookings').doc(bookingId).update(updateData);

                        return res.json({
                            success: true,
                            bookingId: bookingId,
                            status: 'cancelled',
                            paymentStatus: 'TIMEOUT_AUTO_CANCELLED',
                            isPaid: false,
                            autoCancelled: true,
                            itnReceived: bookingData.itnReceived || false,
                            ticketNumber: bookingData.ticketNumber || '',
                            eventName: bookingData.eventName || bookingData.itemName || '',
                            eventDate: bookingData.eventDate || '',
                            userName: bookingData.userName || `${bookingData.customerFirstName || ''} ${bookingData.customerLastName || ''}`.trim(),
                            totalAmount: bookingData.totalAmount || 0,
                            updatedAt: bookingData.lastUpdated || bookingData.createdAt
                        });
                    }
                }

                res.json({
                    success: true,
                    bookingId: bookingId,
                    status: bookingData.status || 'pending',
                    paymentStatus: bookingData.paymentStatus || 'pending',
                    isPaid: bookingData.isPaid || false,
                    itnReceived: bookingData.itnReceived || false,
                    ticketNumber: bookingData.ticketNumber || '',
                    eventName: bookingData.eventName || bookingData.itemName || '',
                    eventDate: bookingData.eventDate || '',
                    userName: bookingData.userName || `${bookingData.customerFirstName || ''} ${bookingData.customerLastName || ''}`.trim(),
                    totalAmount: bookingData.totalAmount || 0,
                    updatedAt: bookingData.lastUpdated || bookingData.createdAt,
                    autoCancelled: false
                });

            } catch (error) {
                console.error('Error checking payment status:', error);
                res.status(500).json({
                    success: false,
                    error: 'Server error'
                });
            }
        });

        // ========== DIRECT CANCELLATION ENDPOINT ==========
        app.post('/direct-cancel', async (req, res) => {
            try {
                const { bookingId, reason = 'user_cancelled' } = req.body;

                console.log(`❌ Direct cancellation for booking: ${bookingId}`);

                if (!bookingId) {
                    return res.status(400).json({ success: false, error: 'Booking ID required' });
                }

                const updateData = {
                    paymentStatus: 'CANCELLED',
                    status: 'cancelled',
                    isPaid: false,
                    cancellationReason: reason,
                    cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
                    lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                    itnReceived: false,
                    directCancel: true
                };

                await db.collection('bookings').doc(bookingId).update(updateData);

                console.log(`✅ Booking ${bookingId} marked as cancelled`);

                res.json({
                    success: true,
                    message: 'Booking cancelled',
                    bookingId: bookingId
                });

            } catch (error) {
                console.error('🔴 Direct cancellation error:', error);
                res.status(500).json({
                    success: false,
                    error: 'Cancellation failed'
                });
            }
        });

        // ========== CLEANUP STALE PAYMENTS ==========
        app.post('/cleanup-stale-payments', async (req, res) => {
            try {
                const hoursAgo = 24;
                const cutoffTime = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);

                console.log(`🕒 Cleaning up payments older than ${hoursAgo} hours...`);

                const bookingsRef = db.collection('bookings');
                const query = bookingsRef
                    .where('status', 'in', ['pending', 'pending_payment'])
                    .where('createdAt', '<', cutoffTime);

                const snapshot = await query.get();

                let cancelledCount = 0;
                const batch = db.batch();

                snapshot.forEach(doc => {
                    const updateData = {
                        status: 'cancelled',
                        paymentStatus: 'TIMEOUT_CANCELLED',
                        isPaid: false,
                        cancellationReason: 'stale_payment_cleanup',
                        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
                        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                    };

                    batch.update(doc.ref, updateData);
                    cancelledCount++;
                });

                await batch.commit();

                console.log(`✅ Cancelled ${cancelledCount} stale payments`);

                res.json({
                    success: true,
                    cancelledCount: cancelledCount,
                    message: `Cancelled ${cancelledCount} stale payments`
                });

            } catch (error) {
                console.error('🔴 Cleanup error:', error);
                res.status(500).json({
                    success: false,
                    error: 'Cleanup failed'
                });
            }
        });

        // ========== TEST CANCELLATION ENDPOINT ==========
        app.post('/test-cancel/:bookingId', async (req, res) => {
            const bookingId = req.params.bookingId;

            const updateData = {
                paymentStatus: 'CANCELLED',
                status: 'cancelled',
                isPaid: false,
                cancellationReason: 'test_cancellation',
                cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
                lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                testMode: true
            };

            await db.collection('bookings').doc(bookingId).update(updateData);

            res.json({
                success: true,
                message: `Booking ${bookingId} cancelled for testing`,
                bookingId: bookingId
            });
        });

        // ========== HEALTH CHECK ==========
        app.get('/health', (req, res) => {
            const isDemoAccount = PAYFAST_CONFIG.merchantId === '10000100';

            res.json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                service: 'Salwa Payment Server',
                endpoints: {
                    processPayment: 'POST /process-payment',
                    itnHandler: 'POST /payfast-notify',
                    checkStatus: 'POST /check-payment-status',
                    directCancel: 'POST /direct-cancel',
                    cleanup: 'POST /cleanup-stale-payments',
                    testCancel: 'POST /test-cancel/:bookingId',
                    manualTest: 'GET /manual-test',
                    health: 'GET /health'
                },
                config: {
                    merchantId: PAYFAST_CONFIG.merchantId ? PAYFAST_CONFIG.merchantId.substring(0, 4) + '...' : 'MISSING',
                    merchantKey: PAYFAST_CONFIG.merchantKey ? PAYFAST_CONFIG.merchantKey.substring(0, 4) + '...' : 'MISSING',
                    passphrase: PAYFAST_CONFIG.passphrase ? 'SET (' + PAYFAST_CONFIG.passphrase.substring(0, 4) + '...)' : 'MISSING',
                    sandbox: PAYFAST_CONFIG.sandbox,
                    firebase: serviceAccount.project_id ? 'CONNECTED' : 'DISCONNECTED'
                },
                warning: isDemoAccount ?
                    '⚠️ USING PAYFAST DEMO ACCOUNT! Update with YOUR merchant ID' :
                    '✅ Using your merchant account'
            });
        });

        // ========== START SERVER ==========
        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            console.log(`
    🚀 Salwa Payment Server Started!
    📍 Port: ${PORT}
    🔒 Mode: ${PAYFAST_CONFIG.sandbox ? 'SANDBOX 🧪' : 'PRODUCTION 🏢'}
    🌐 URL: https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost:' + PORT}
    
    📋 Endpoints:
    ├── POST /process-payment    - Create payment links
    ├── POST /payfast-notify     - Receive ITN notifications
    ├── POST /check-payment-status - Check booking status
    ├── POST /direct-cancel      - Manual cancellation
    ├── POST /cleanup-stale-payments - Cleanup old payments
    ├── POST /test-cancel/:id    - Test cancellation
    ├── GET  /manual-test        - Manual PayFast test page
    └── GET  /health             - Server health check
    
    ⚠️  Make sure these env vars are set in Render:
    ├── FIREBASE_KEY
    ├── PAYFAST_MERCHANT_ID=10044213
    ├── PAYFAST_MERCHANT_KEY=9s7vajpkdyycf
    ├── PAYFAST_PASSPHRASE=salwa20242024
    └── PAYFAST_SANDBOX=true
    `);
        });
// ========== BODY PARSER MIDDLEWARE ==========
// CRITICAL: Parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: true }));

// Parse application/json
app.use(bodyParser.json());

// Debug middleware - should come AFTER body parsers
app.use((req, res, next) => {
    console.log(`📥 ${req.method} ${req.url}`);
    console.log('📦 Request Body:', req.body);
    console.log('📦 Content-Type:', req.headers['content-type']);
    next();
});

// ========== FIREBASE INIT ==========
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY || '{}');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// ========== PAYFAST CONFIG ==========
const PAYFAST_CONFIG = {
    merchantId: process.env.PAYFAST_MERCHANT_ID,
    merchantKey: process.env.PAYFAST_MERCHANT_KEY,
    passphrase: process.env.PAYFAST_PASSPHRASE || '',
    sandbox: process.env.PAYFAST_SANDBOX === 'true',
    productionUrl: "https://www.payfast.co.za/eng/process",
    sandboxUrl: "https://sandbox.payfast.co.za/eng/process"
};

// ========== HELPER FUNCTIONS ==========
function convertFirestoreTimestamp(timestamp) {
    if (!timestamp) return new Date();
    if (timestamp.toDate) return timestamp.toDate();
    if (timestamp.seconds) return new Date(timestamp.seconds * 1000);
    if (timestamp._seconds) return new Date(timestamp._seconds * 1000);
    return new Date(timestamp);
}

function generatePayFastSignature(data, passPhrase = null) {
    console.log('🔍 Generating PayFast signature...');

    const signatureData = { ...data };
    delete signatureData.signature;

    const sortedKeys = Object.keys(signatureData).sort();
    let pfOutput = '';

    for (let key of sortedKeys) {
        if (signatureData[key] !== undefined && signatureData[key] !== null) {
            const value = signatureData[key].toString();
            const encodedValue = encodeURIComponent(value)
                .replace(/%20/g, '+')
                .replace(/'/g, '%27')
                .replace(/"/g, '%22')
                .replace(/\(/g, '%28')
                .replace(/\)/g, '%29')
                .replace(/\*/g, '%2A')
                .replace(/!/g, '%21');
            pfOutput += `${key}=${encodedValue}&`;
        }
    }

    if (pfOutput.endsWith('&')) {
        pfOutput = pfOutput.slice(0, -1);
    }

    if (passPhrase !== null && passPhrase !== undefined && passPhrase !== '') {
        const encodedPassphrase = encodeURIComponent(passPhrase)
            .replace(/%20/g, '+')
            .replace(/'/g, '%27')
            .replace(/"/g, '%22')
            .replace(/\(/g, '%28')
            .replace(/\)/g, '%29')
            .replace(/\*/g, '%2A')
            .replace(/!/g, '%21');
        pfOutput += `&passphrase=${encodedPassphrase}`;
    }

    console.log('🔍 Signature string for MD5:', pfOutput);
    console.log('🔍 Passphrase used:', passPhrase || 'NONE');

    return crypto.createHash('md5').update(pfOutput).digest('hex');
}

function verifyPayFastSignature(data, passphrase = '') {
    console.log('🔍 Verifying PayFast signature...');

    const submittedSignature = data.signature;
    const signatureData = { ...data };
    delete signatureData.signature;

    const sortedKeys = Object.keys(signatureData).sort();
    let pfParamString = '';

    for (const key of sortedKeys) {
        if (signatureData[key] !== undefined && signatureData[key] !== null) {
            const value = signatureData[key].toString();
            const encodedValue = encodeURIComponent(value)
                .replace(/%20/g, '+')
                .replace(/'/g, '%27')
                .replace(/"/g, '%22')
                .replace(/\(/g, '%28')
                .replace(/\)/g, '%29')
                .replace(/\*/g, '%2A')
                .replace(/!/g, '%21');
            pfParamString += `${key}=${encodedValue}&`;
        }
    }

    if (pfParamString.endsWith('&')) {
        pfParamString = pfParamString.slice(0, -1);
    }

    if (passphrase !== null && passphrase !== undefined && passphrase !== '') {
        const encodedPassphrase = encodeURIComponent(passphrase)
            .replace(/%20/g, '+')
            .replace(/'/g, '%27')
            .replace(/"/g, '%22')
            .replace(/\(/g, '%28')
            .replace(/\)/g, '%29')
            .replace(/\*/g, '%2A')
            .replace(/!/g, '%21');
        pfParamString += `&passphrase=${encodedPassphrase}`;
    }

    const calculatedSignature = crypto.createHash('md5').update(pfParamString).digest('hex');

    console.log('🔍 Signature comparison:');
    console.log('Submitted:', submittedSignature);
    console.log('Calculated:', calculatedSignature);
    console.log('Match?', calculatedSignature === submittedSignature);

    return calculatedSignature === submittedSignature;
}

// ========== SIMPLIFIED PROCESS PAYMENT ==========
app.post('/process-payment', async (req, res) => {
    try {
        console.log('🔵 Payment request received:', req.body);

        const {
            amount, item_name, name_first, name_last, email_address,
            cell_number, event_id, ticket_number, booking_id, ticket_quantity,
            event_name, event_date
        } = req.body;

        // Basic validation
        if (!amount || !item_name || !email_address || !booking_id) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields',
                received: req.body
            });
        }

        const renderUrl = process.env.RENDER_EXTERNAL_URL || `https://${req.get('host')}`;

        // Build URLs dynamically with booking_id
        const returnUrl = `https://salwacollective.co.za/payment-result.html?pf_status=success&booking_id=${booking_id}`;
        const cancelUrl = `https://salwacollective.co.za/payment-result.html?pf_status=cancelled&booking_id=${booking_id}`;

        // SIMPLIFIED payment data - PayFast prefers minimal fields
        const paymentData = {
            merchant_id: PAYFAST_CONFIG.merchantId,
            merchant_key: PAYFAST_CONFIG.merchantKey,
            return_url: returnUrl,
            cancel_url: cancelUrl,
            notify_url: `${renderUrl}/payfast-notify`,
            name_first: name_first || '',
            name_last: name_last || '',
            email_address: email_address,
            cell_number: cell_number || '',
            amount: parseFloat(amount).toFixed(2),
            item_name: item_name.substring(0, 100),
            m_payment_id: booking_id,
            custom_str1: event_id || '',
            custom_str2: ticket_number || '',
            custom_str3: booking_id || '',
            custom_int1: ticket_quantity || 1
        };

        Object.keys(paymentData).forEach(key => {
            if (paymentData[key] === null || paymentData[key] === undefined) {
                delete paymentData[key];
            }
        });

        console.log('🟡 Payment data for signature:', paymentData);

        const signature = generatePayFastSignature(paymentData, PAYFAST_CONFIG.passphrase);
        paymentData.signature = signature;

        console.log('🔍 Generated signature:', signature);
        console.log('🔍 Mode:', PAYFAST_CONFIG.sandbox ? 'SANDBOX' : 'PRODUCTION');

        // Store booking with timeout tracking in Firestore
        try {
            const bookingData = {
                // Core booking info from frontend
                bookingId: booking_id,
                eventId: event_id || '',
                ticketNumber: ticket_number || '',
                ticketQuantity: ticket_quantity || 1,
                totalAmount: parseFloat(amount),
                itemName: item_name,
                eventName: event_name || item_name,
                eventDate: event_date || '',

                // Customer info
                customerEmail: email_address,
                customerFirstName: name_first || '',
                customerLastName: name_last || '',
                customerPhone: cell_number || '',
                userName: `${name_first || ''} ${name_last || ''}`.trim(),

                // Payment tracking
                status: 'pending_payment',
                paymentStatus: 'PENDING',
                isPaid: false,
                itnReceived: false,

                // Timestamps
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                lastUpdated: admin.firestore.FieldValue.serverTimestamp(),

                // Timeout tracking - 30 minutes from now
                paymentTimeout: new Date(Date.now() + 30 * 60 * 1000),

                // Payment method info
                paymentMethod: 'payfast',
                paymentGateway: 'payfast',
                gatewayData: {
                    merchantId: PAYFAST_CONFIG.merchantId,
                    sandbox: PAYFAST_CONFIG.sandbox,
                    signature: signature
                },

                // Additional metadata
                ipAddress: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
                userAgent: req.headers['user-agent'] || ''
            };

            await db.collection('bookings').doc(booking_id).set(bookingData, { merge: true });
            console.log(`✅ Booking ${booking_id} stored in Firestore with 30-minute timeout`);

        } catch (firestoreError) {
            console.error('🔴 Firestore save error:', firestoreError);
        }

        // Create redirect URL
        const payfastUrl = PAYFAST_CONFIG.sandbox ? PAYFAST_CONFIG.sandboxUrl : PAYFAST_CONFIG.productionUrl;
        const queryString = new URLSearchParams(paymentData).toString();
        const redirectUrl = `${payfastUrl}?${queryString}`;

        console.log('🟢 Full redirect URL:', redirectUrl);

        res.json({
            success: true,
            redirectUrl: redirectUrl,
            bookingId: booking_id,
            signature: signature
        });

    } catch (error) {
        console.error('🔴 Payment processing error:', error);
        res.status(500).json({
            success: false,
            error: 'Payment processing failed',
            message: error.message
        });
    }
});

// ========== MANUAL TEST ENDPOINT ==========
app.get('/manual-test', (req, res) => {
    // Use a test booking ID
    const testBookingId = 'test-' + Date.now();
    const returnUrl = `https://salwacollective.co.za/payment-result.html?pf_status=success&booking_id=${testBookingId}`;
    const cancelUrl = `https://salwacollective.co.za/payment-result.html?pf_status=cancelled&booking_id=${testBookingId}`;

    const testData = {
        merchant_id: PAYFAST_CONFIG.merchantId,
        merchant_key: PAYFAST_CONFIG.merchantKey,
        return_url: returnUrl,
        cancel_url: cancelUrl,
        notify_url: 'https://salwa-payment-backend-1.onrender.com/payfast-notify',
        name_first: 'Test',
        name_last: 'User',
        email_address: 'test@example.com',
        amount: '5.00',
        item_name: 'Salwa Collective Test',
        m_payment_id: testBookingId
    };

    const signature = generatePayFastSignature(testData, PAYFAST_CONFIG.passphrase);
    testData.signature = signature;

    const queryString = new URLSearchParams(testData).toString();
    const testUrl = `${PAYFAST_CONFIG.sandboxUrl}?${queryString}`;

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>PayFast Manual Test</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; }
                .container { background: #f5f5f5; padding: 20px; border-radius: 10px; }
                .url-box { background: white; padding: 15px; border: 1px solid #ddd; border-radius: 5px; word-break: break-all; }
                .btn { background: #4CAF50; color: white; padding: 12px 24px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; }
                .test-card { background: #e8f5e9; padding: 15px; border-radius: 5px; margin-top: 20px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🧪 PayFast Sandbox Test</h1>
                <p><strong>Status:</strong> Using merchant ID: ${PAYFAST_CONFIG.merchantId}</p>
                <p><strong>Passphrase:</strong> ${PAYFAST_CONFIG.passphrase ? 'SET' : 'NOT SET'}</p>
                <p><strong>Signature:</strong> ${signature.substring(0, 20)}...</p>
                
                <h3>Test Payment Link:</h3>
                <div class="url-box">${testUrl}</div>
                
                <p style="margin-top: 20px;">
                    <a href="${testUrl}" target="_blank" class="btn">Open PayFast Payment Page</a>
                </p>
                
                <div class="test-card">
                    <h3>💳 Test Card Details:</h3>
                    <ul>
                        <li><strong>Card Number:</strong> 4000 0000 0000 0002</li>
                        <li><strong>Expiry Date:</strong> Any future date (e.g., 12/30)</li>
                        <li><strong>CVV:</strong> 123</li>
                        <li><strong>3D Secure Password:</strong> payfast</li>
                    </ul>
                    <p><em>This is a test payment - no real money will be charged.</em></p>
                </div>
                
                <div style="margin-top: 30px; padding: 15px; background: #fff3cd; border-radius: 5px;">
                    <h3>⚠️ Troubleshooting</h3>
                    <p>If you get "signature mismatch":</p>
                    <ol>
                        <li>Check your PayFast merchant dashboard passphrase setting</li>
                        <li>Verify merchant ID and key in Render environment variables</li>
                        <li>Try clearing browser cache and cookies</li>
                    </ol>
                </div>
            </div>
        </body>
        </html>
    `);
});

// ========== ITN HANDLER ==========
app.post('/payfast-notify', async (req, res) => {
    const data = req.body;

    try {
        console.log('🟣 ITN received:', JSON.stringify(data, null, 2));

        const isValidSignature = verifyPayFastSignature(data, PAYFAST_CONFIG.passphrase);

        if (!isValidSignature) {
            console.error('🔴 Invalid ITN signature');
            return res.status(400).send('Invalid signature');
        }

        const verifyUrl = PAYFAST_CONFIG.sandbox
            ? 'https://sandbox.payfast.co.za/eng/query/validate'
            : 'https://www.payfast.co.za/eng/query/validate';

        const response = await axios.post(
            verifyUrl,
            querystring.stringify(data),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Salwa-Collective-ITN/1.0'
                },
                timeout: 10000
            }
        );

        if (response.data.trim() === 'VALID') {
            const bookingId = data.m_payment_id;
            const paymentStatus = data.payment_status?.toUpperCase() || '';

            console.log(`🟢 Valid ITN for booking ${bookingId}, status: ${paymentStatus}`);

            const updateData = {
                paymentStatus: paymentStatus,
                payfastPaymentId: data.pf_payment_id,
                amountPaid: parseFloat(data.amount_gross),
                fee: parseFloat(data.amount_fee || 0),
                itnReceived: true,
                itnTimestamp: admin.firestore.FieldValue.serverTimestamp(),
                payerEmail: data.email_address,
                payerPhone: data.cell_number || '',
                payerName: `${data.name_first || ''} ${data.name_last || ''}`.trim(),
                lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                itnData: data
            };

            if (paymentStatus === 'COMPLETE') {
                updateData.status = 'confirmed';
                updateData.paymentDate = admin.firestore.FieldValue.serverTimestamp();
                updateData.isPaid = true;
            } else if (paymentStatus === 'CANCELLED' || paymentStatus === 'USER_CANCELLED') {
                updateData.status = 'cancelled';
                updateData.isPaid = false;
                updateData.cancellationReason = 'user_cancelled_on_payfast';
                updateData.cancelledAt = admin.firestore.FieldValue.serverTimestamp();
            } else if (paymentStatus === 'FAILED') {
                updateData.status = 'failed';
                updateData.isPaid = false;
                updateData.cancellationReason = 'payment_failed';
                updateData.cancelledAt = admin.firestore.FieldValue.serverTimestamp();
            } else {
                updateData.status = paymentStatus.toLowerCase();
                updateData.isPaid = false;
            }

            await db.collection('bookings').doc(bookingId).update(updateData);
            console.log(`✅ Booking ${bookingId} updated in Firebase`);

        } else {
            console.error('🔴 Invalid ITN response from PayFast:', response.data);
        }

        res.status(200).send('OK');

    } catch (err) {
        console.error('🔴 ITN processing error:', err);

        if (data && data.m_payment_id) {
            try {
                await db.collection('bookings').doc(data.m_payment_id).update({
                    paymentStatus: 'itn_error',
                    lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                    itnError: err.message
                });
            } catch (firestoreErr) {
                console.error('Could not update Firestore:', firestoreErr);
            }
        }

        res.status(500).send('Server error');
    }
});

// ========== CHECK PAYMENT STATUS ==========
app.post('/check-payment-status', async (req, res) => {
    try {
        const { bookingId } = req.body;

        if (!bookingId) {
            return res.status(400).json({
                success: false,
                error: 'Booking ID required'
            });
        }

        const bookingDoc = await db.collection('bookings').doc(bookingId).get();

        if (!bookingDoc.exists) {
            return res.status(404).json({
                success: false,
                error: 'Booking not found'
            });
        }

        const bookingData = bookingDoc.data();

        // Auto-cancel if payment has timed out
        if (bookingData.paymentTimeout) {
            const timeoutDate = convertFirestoreTimestamp(bookingData.paymentTimeout);
            const now = new Date();

            if (timeoutDate < now &&
                (bookingData.status === 'pending' || bookingData.status === 'pending_payment')) {

                console.log(`⏰ Auto-cancelling timed out booking: ${bookingId}`);

                const updateData = {
                    status: 'cancelled',
                    paymentStatus: 'TIMEOUT_AUTO_CANCELLED',
                    isPaid: false,
                    cancellationReason: 'payment_timeout',
                    cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
                    lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                };

                await db.collection('bookings').doc(bookingId).update(updateData);

                return res.json({
                    success: true,
                    bookingId: bookingId,
                    status: 'cancelled',
                    paymentStatus: 'TIMEOUT_AUTO_CANCELLED',
                    isPaid: false,
                    autoCancelled: true,
                    itnReceived: bookingData.itnReceived || false,
                    ticketNumber: bookingData.ticketNumber || '',
                    eventName: bookingData.eventName || bookingData.itemName || '',
                    eventDate: bookingData.eventDate || '',
                    userName: bookingData.userName || `${bookingData.customerFirstName || ''} ${bookingData.customerLastName || ''}`.trim(),
                    totalAmount: bookingData.totalAmount || 0,
                    updatedAt: bookingData.lastUpdated || bookingData.createdAt
                });
            }
        }

        res.json({
            success: true,
            bookingId: bookingId,
            status: bookingData.status || 'pending',
            paymentStatus: bookingData.paymentStatus || 'pending',
            isPaid: bookingData.isPaid || false,
            itnReceived: bookingData.itnReceived || false,
            ticketNumber: bookingData.ticketNumber || '',
            eventName: bookingData.eventName || bookingData.itemName || '',
            eventDate: bookingData.eventDate || '',
            userName: bookingData.userName || `${bookingData.customerFirstName || ''} ${bookingData.customerLastName || ''}`.trim(),
            totalAmount: bookingData.totalAmount || 0,
            updatedAt: bookingData.lastUpdated || bookingData.createdAt,
            autoCancelled: false
        });

    } catch (error) {
        console.error('Error checking payment status:', error);
        res.status(500).json({
            success: false,
            error: 'Server error'
        });
    }
});

// ========== DIRECT CANCELLATION ENDPOINT ==========
app.post('/direct-cancel', async (req, res) => {
    try {
        const { bookingId, reason = 'user_cancelled' } = req.body;

        console.log(`❌ Direct cancellation for booking: ${bookingId}`);

        if (!bookingId) {
            return res.status(400).json({ success: false, error: 'Booking ID required' });
        }

        const updateData = {
            paymentStatus: 'CANCELLED',
            status: 'cancelled',
            isPaid: false,
            cancellationReason: reason,
            cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
            lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
            itnReceived: false,
            directCancel: true
        };

        await db.collection('bookings').doc(bookingId).update(updateData);

        console.log(`✅ Booking ${bookingId} marked as cancelled`);

        res.json({
            success: true,
            message: 'Booking cancelled',
            bookingId: bookingId
        });

    } catch (error) {
        console.error('🔴 Direct cancellation error:', error);
        res.status(500).json({
            success: false,
            error: 'Cancellation failed'
        });
    }
});

// ========== CLEANUP STALE PAYMENTS ==========
app.post('/cleanup-stale-payments', async (req, res) => {
    try {
        const hoursAgo = 24;
        const cutoffTime = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);

        console.log(`🕒 Cleaning up payments older than ${hoursAgo} hours...`);

        const bookingsRef = db.collection('bookings');
        const query = bookingsRef
            .where('status', 'in', ['pending', 'pending_payment'])
            .where('createdAt', '<', cutoffTime);

        const snapshot = await query.get();

        let cancelledCount = 0;
        const batch = db.batch();

        snapshot.forEach(doc => {
            const updateData = {
                status: 'cancelled',
                paymentStatus: 'TIMEOUT_CANCELLED',
                isPaid: false,
                cancellationReason: 'stale_payment_cleanup',
                cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            };

            batch.update(doc.ref, updateData);
            cancelledCount++;
        });

        await batch.commit();

        console.log(`✅ Cancelled ${cancelledCount} stale payments`);

        res.json({
            success: true,
            cancelledCount: cancelledCount,
            message: `Cancelled ${cancelledCount} stale payments`
        });

    } catch (error) {
        console.error('🔴 Cleanup error:', error);
        res.status(500).json({
            success: false,
            error: 'Cleanup failed'
        });
    }
});

// ========== TEST CANCELLATION ENDPOINT ==========
app.post('/test-cancel/:bookingId', async (req, res) => {
    const bookingId = req.params.bookingId;

    const updateData = {
        paymentStatus: 'CANCELLED',
        status: 'cancelled',
        isPaid: false,
        cancellationReason: 'test_cancellation',
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        testMode: true
    };

    await db.collection('bookings').doc(bookingId).update(updateData);

    res.json({
        success: true,
        message: `Booking ${bookingId} cancelled for testing`,
        bookingId: bookingId
    });
});

// ========== HEALTH CHECK ==========
app.get('/health', (req, res) => {
    const isDemoAccount = PAYFAST_CONFIG.merchantId === '10000100';

    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'Salwa Payment Server',
        endpoints: {
            processPayment: 'POST /process-payment',
            itnHandler: 'POST /payfast-notify',
            checkStatus: 'POST /check-payment-status',
            directCancel: 'POST /direct-cancel',
            cleanup: 'POST /cleanup-stale-payments',
            testCancel: 'POST /test-cancel/:bookingId',
            manualTest: 'GET /manual-test',
            health: 'GET /health'
        },
        config: {
            merchantId: PAYFAST_CONFIG.merchantId ? PAYFAST_CONFIG.merchantId.substring(0, 4) + '...' : 'MISSING',
            merchantKey: PAYFAST_CONFIG.merchantKey ? PAYFAST_CONFIG.merchantKey.substring(0, 4) + '...' : 'MISSING',
            passphrase: PAYFAST_CONFIG.passphrase ? 'SET (' + PAYFAST_CONFIG.passphrase.substring(0, 4) + '...)' : 'MISSING',
            sandbox: PAYFAST_CONFIG.sandbox,
            firebase: serviceAccount.project_id ? 'CONNECTED' : 'DISCONNECTED'
        },
        warning: isDemoAccount ?
            '⚠️ USING PAYFAST DEMO ACCOUNT! Update with YOUR merchant ID' :
            '✅ Using your merchant account'
    });
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
    🚀 Salwa Payment Server Started!
    📍 Port: ${PORT}
    🔒 Mode: ${PAYFAST_CONFIG.sandbox ? 'SANDBOX 🧪' : 'PRODUCTION 🏢'}
    🌐 URL: https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost:' + PORT}
    
    📋 Endpoints:
    ├── POST /process-payment    - Create payment links
    ├── POST /payfast-notify     - Receive ITN notifications
    ├── POST /check-payment-status - Check booking status
    ├── POST /direct-cancel      - Manual cancellation
    ├── POST /cleanup-stale-payments - Cleanup old payments
    ├── POST /test-cancel/:id    - Test cancellation
    ├── GET  /manual-test        - Manual PayFast test page
    └── GET  /health             - Server health check
    
    ⚠️  Make sure these env vars are set in Render:
    ├── FIREBASE_KEY
    ├── PAYFAST_MERCHANT_ID=10044213
    ├── PAYFAST_MERCHANT_KEY=9s7vajpkdyycf
    ├── PAYFAST_PASSPHRASE=salwa20242024
    └── PAYFAST_SANDBOX=true
    `);
});