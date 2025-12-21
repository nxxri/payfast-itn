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

// Body parsers - CRITICAL FOR ITN: PayFast sends URL-encoded data
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Add explicit preflight handler
app.options('*', cors(corsOptions));

// ========== FIREBASE INIT ==========
let db;
try {
    const firebaseConfig = JSON.parse(process.env.FIREBASE_KEY || '{}');

    if (Object.keys(firebaseConfig).length === 0) {
        console.error('❌ FIREBASE_KEY environment variable is empty or not set');
        throw new Error('Firebase config missing');
    }

    // Initialize Firebase only if not already initialized
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(firebaseConfig),
        });
        console.log('✅ Firebase initialized successfully');
    } else {
        console.log('✅ Firebase already initialized');
    }

    db = admin.firestore();
} catch (error) {
    console.error('❌ Firebase initialization error:', error.message);
    // Continue without Firebase for testing
    db = null;
}

// ========== PAYFAST CONFIG ==========
const PAYFAST_CONFIG = {
    merchantId: process.env.PAYFAST_MERCHANT_ID || '10000100',
    merchantKey: process.env.PAYFAST_MERCHANT_KEY || '46f0cd694581a',
    passphrase: process.env.PAYFAST_PASSPHRASE || '',
    sandbox: process.env.PAYFAST_SANDBOX !== 'false', // Default to true
    productionUrl: "https://www.payfast.co.za/eng/process",
    sandboxUrl: "https://sandbox.payfast.co.za/eng/process",
    queryUrl: "https://sandbox.payfast.co.za/eng/query/validate"
};

console.log('🔧 PayFast Config:', {
    merchantId: PAYFAST_CONFIG.merchantId,
    merchantKey: PAYFAST_CONFIG.merchantKey.substring(0, 4) + '...',
    passphrase: PAYFAST_CONFIG.passphrase ? 'SET' : 'NOT SET',
    sandbox: PAYFAST_CONFIG.sandbox,
    queryUrl: PAYFAST_CONFIG.queryUrl
});

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
    console.log('🔍 Data received:', data);

    const submittedSignature = data.signature;
    if (!submittedSignature) {
        console.error('❌ No signature provided in ITN');
        return false;
    }

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
    console.log('🔍 Param string for MD5:', pfParamString);

    return calculatedSignature === submittedSignature;
}

// ========== CRITICAL: GET CORRECT NOTIFY URL ==========
function getNotifyUrl() {
    // Try multiple methods to get the correct URL
    const renderUrl = process.env.RENDER_EXTERNAL_URL;
    const renderHostname = process.env.RENDER_EXTERNAL_HOSTNAME;

    let baseUrl;

    if (renderUrl) {
        baseUrl = renderUrl;
    } else if (renderHostname) {
        baseUrl = `https://${renderHostname}`;
    } else {
        // Fallback for local development
        baseUrl = 'https://salwa-payment.onrender.com'; // Your actual Render service name
    }

    const notifyUrl = `${baseUrl}/payfast-notify`;
    console.log('🔗 Notify URL configured:', notifyUrl);
    return notifyUrl;
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

        const returnUrl = `https://salwacollective.co.za/payment-result.html?pf_status=success&booking_id=${booking_id}`;
        const cancelUrl = `https://salwacollective.co.za/payment-result.html?pf_status=cancelled&booking_id=${booking_id}`;
        const notifyUrl = getNotifyUrl(); // Use the new function

        console.log('🔗 URLs:', { returnUrl, cancelUrl, notifyUrl });

        // SIMPLIFIED payment data - PayFast prefers minimal fields
        const paymentData = {
            merchant_id: PAYFAST_CONFIG.merchantId,
            merchant_key: PAYFAST_CONFIG.merchantKey,
            return_url: returnUrl,
            cancel_url: cancelUrl,
            notify_url: notifyUrl, // This is CRITICAL
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

        // Remove any null/undefined values
        Object.keys(paymentData).forEach(key => {
            if (paymentData[key] === null || paymentData[key] === undefined || paymentData[key] === '') {
                delete paymentData[key];
            }
        });

        console.log('🟡 Payment data for signature:', paymentData);

        const signature = generatePayFastSignature(paymentData, PAYFAST_CONFIG.passphrase);
        paymentData.signature = signature;

        console.log('🔍 Generated signature:', signature);
        console.log('🔍 Mode:', PAYFAST_CONFIG.sandbox ? 'SANDBOX' : 'PRODUCTION');

        // Store booking with timeout tracking in Firestore
        if (db) {
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
                        signature: signature,
                        notifyUrl: notifyUrl // Store for debugging
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
        } else {
            console.warn('⚠️ Firebase not available, skipping Firestore save');
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
            signature: signature,
            notifyUrl: notifyUrl // Return for debugging
        });

    } catch (error) {
        console.error('🔴 Payment processing error:', error);
        res.status(500).json({
            success: false,
            error: 'Payment processing failed',
            message: error.message,
            stack: error.stack
        });
    }
});

// ========== FIXED ITN HANDLER ==========
app.post('/payfast-notify', async (req, res) => {
    console.log('\n' + '='.repeat(50));
    console.log('🟣🟣🟣 ITN RECEIVED AT:', new Date().toISOString());
    console.log('='.repeat(50));

    // IMPORTANT: Log everything about the request
    console.log('📦 Request Headers:', req.headers);
    console.log('📦 Request Method:', req.method);
    console.log('📦 Request IP:', req.ip);
    console.log('📦 Request Body Type:', typeof req.body);
    console.log('📦 Raw Body:', req.body);

    const data = req.body;

    try {
        console.log('📋 Parsed ITN Data:', JSON.stringify(data, null, 2));

        if (!data || Object.keys(data).length === 0) {
            console.error('❌ Empty ITN data received');
            return res.status(400).send('Empty data');
        }

        // Verify signature
        const isValidSignature = verifyPayFastSignature(data, PAYFAST_CONFIG.passphrase);

        if (!isValidSignature) {
            console.error('🔴 Invalid ITN signature - possible tampering');

            // Log what we have for debugging
            if (data.m_payment_id && db) {
                try {
                    await db.collection('bookings').doc(data.m_payment_id).update({
                        paymentStatus: 'SIGNATURE_MISMATCH',
                        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                        itnError: 'Invalid signature',
                        itnData: data
                    });
                } catch (firestoreErr) {
                    console.error('Could not update Firestore:', firestoreErr);
                }
            }

            return res.status(400).send('INVALID SIGNATURE');
        }

        console.log('✅ ITN signature verified successfully');

        // IMPORTANT: Verify with PayFast
        const verifyUrl = PAYFAST_CONFIG.sandbox
            ? 'https://sandbox.payfast.co.za/eng/query/validate'
            : 'https://www.payfast.co.za/eng/query/validate';

        console.log('🔍 Verifying with PayFast at:', verifyUrl);

        const response = await axios.post(
            verifyUrl,
            querystring.stringify(data),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Salwa-Collective-ITN/1.0'
                },
                timeout: 15000
            }
        );

        console.log('🔍 PayFast verification response:', response.data);

        if (response.data.trim() === 'VALID') {
            const bookingId = data.m_payment_id;
            const paymentStatus = data.payment_status?.toUpperCase() || '';

            console.log(`🎉 🎉 🎉 VALID ITN for booking ${bookingId}, status: ${paymentStatus}`);

            if (!db) {
                console.error('❌ Firebase not available, cannot update booking');
                return res.status(500).send('DATABASE_UNAVAILABLE');
            }

            const updateData = {
                paymentStatus: paymentStatus,
                payfastPaymentId: data.pf_payment_id,
                amountPaid: parseFloat(data.amount_gross || 0),
                fee: parseFloat(data.amount_fee || 0),
                itnReceived: true,
                itnTimestamp: admin.firestore.FieldValue.serverTimestamp(),
                payerEmail: data.email_address,
                payerPhone: data.cell_number || '',
                payerName: `${data.name_first || ''} ${data.name_last || ''}`.trim(),
                lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                itnData: data,
                itnValidated: true
            };

            if (paymentStatus === 'COMPLETE') {
                updateData.status = 'confirmed';
                updateData.paymentDate = admin.firestore.FieldValue.serverTimestamp();
                updateData.isPaid = true;
                console.log(`💰 Payment COMPLETE for booking ${bookingId}`);
            } else if (paymentStatus === 'CANCELLED' || paymentStatus === 'USER_CANCELLED') {
                updateData.status = 'cancelled';
                updateData.isPaid = false;
                updateData.cancellationReason = 'user_cancelled_on_payfast';
                updateData.cancelledAt = admin.firestore.FieldValue.serverTimestamp();
                console.log(`❌ Payment CANCELLED for booking ${bookingId}`);
            } else if (paymentStatus === 'FAILED') {
                updateData.status = 'failed';
                updateData.isPaid = false;
                updateData.cancellationReason = 'payment_failed';
                updateData.cancelledAt = admin.firestore.FieldValue.serverTimestamp();
                console.log(`⚠️ Payment FAILED for booking ${bookingId}`);
            } else {
                updateData.status = paymentStatus.toLowerCase();
                updateData.isPaid = false;
                console.log(`ℹ️ Payment status ${paymentStatus} for booking ${bookingId}`);
            }

            // Update Firestore
            try {
                await db.collection('bookings').doc(bookingId).update(updateData);
                console.log(`✅✅✅ Booking ${bookingId} updated in Firebase with status: ${paymentStatus}`);

                // Also log to a separate ITN log collection for debugging
                await db.collection('itn_logs').add({
                    bookingId: bookingId,
                    paymentStatus: paymentStatus,
                    pfPaymentId: data.pf_payment_id,
                    amount: data.amount_gross,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    data: data
                });

            } catch (firestoreError) {
                console.error('🔴 Firestore update error:', firestoreError);
                // Log the error but still respond OK to PayFast
                await db.collection('itn_errors').add({
                    bookingId: bookingId,
                    error: firestoreError.message,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    data: data
                });
            }

            res.status(200).send('OK');

        } else {
            console.error('🔴 Invalid ITN response from PayFast:', response.data);

            if (data.m_payment_id && db) {
                try {
                    await db.collection('bookings').doc(data.m_payment_id).update({
                        paymentStatus: 'ITN_VALIDATION_FAILED',
                        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                        itnError: 'PayFast validation failed: ' + response.data
                    });
                } catch (firestoreErr) {
                    console.error('Could not update Firestore:', firestoreErr);
                }
            }

            res.status(400).send('INVALID ITN');
        }

    } catch (err) {
        console.error('🔴🔴🔴 ITN processing error:', err.message);
        console.error('Stack:', err.stack);

        // Log the error
        if (data && data.m_payment_id && db) {
            try {
                await db.collection('bookings').doc(data.m_payment_id).update({
                    paymentStatus: 'ITN_ERROR',
                    lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                    itnError: err.message
                });

                await db.collection('itn_errors').add({
                    bookingId: data.m_payment_id,
                    error: err.message,
                    stack: err.stack,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    data: data
                });
            } catch (firestoreErr) {
                console.error('Could not log ITN error:', firestoreErr);
            }
        }

        // Still respond with 200 to prevent PayFast from retrying
        res.status(200).send('OK - Error logged');
    }
});

// ========== TEST ITN ENDPOINT ==========
app.post('/test-itn', async (req, res) => {
    console.log('🧪 Test ITN endpoint hit');
    res.json({
        success: true,
        message: 'ITN endpoint is accessible',
        timestamp: new Date().toISOString(),
        url: getNotifyUrl()
    });
});

// ========== MANUAL TEST ENDPOINT ==========
app.get('/manual-test', (req, res) => {
    // Use a test booking ID
    const testBookingId = 'test-' + Date.now();
    const returnUrl = `https://salwacollective.co.za/payment-result.html?pf_status=success&booking_id=${testBookingId}`;
    const cancelUrl = `https://salwacollective.co.za/payment-result.html?pf_status=cancelled&booking_id=${testBookingId}`;
    const notifyUrl = getNotifyUrl();

    const testData = {
        merchant_id: PAYFAST_CONFIG.merchantId,
        merchant_key: PAYFAST_CONFIG.merchantKey,
        return_url: returnUrl,
        cancel_url: cancelUrl,
        notify_url: notifyUrl,
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
                .info-box { background: #e3f2fd; padding: 15px; border-radius: 5px; margin-top: 20px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🧪 PayFast Sandbox Test</h1>
                
                <div class="info-box">
                    <h3>🔧 Configuration:</h3>
                    <p><strong>Merchant ID:</strong> ${PAYFAST_CONFIG.merchantId}</p>
                    <p><strong>Merchant Key:</strong> ${PAYFAST_CONFIG.merchantKey.substring(0, 4)}...</p>
                    <p><strong>Passphrase:</strong> ${PAYFAST_CONFIG.passphrase ? 'SET (' + PAYFAST_CONFIG.passphrase.substring(0, 4) + '...)' : 'NOT SET'}</p>
                    <p><strong>Sandbox Mode:</strong> ${PAYFAST_CONFIG.sandbox ? 'YES 🧪' : 'NO 🏢'}</p>
                    <p><strong>Notify URL:</strong> <br><small>${notifyUrl}</small></p>
                    <p><strong>Firebase:</strong> ${db ? '✅ CONNECTED' : '❌ DISCONNECTED'}</p>
                </div>
                
                <h3>🔗 Test Payment Link:</h3>
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
                    <h3>⚠️ ITN Debugging</h3>
                    <p>To test if PayFast can reach your ITN endpoint:</p>
                    <ol>
                        <li>Click the payment link above</li>
                        <li>Complete the payment with test card details</li>
                        <li>Check Render logs for "🟣 ITN RECEIVED" message</li>
                        <li>If no ITN is received, check:
                            <ul>
                                <li>Firewall settings on Render</li>
                                <li>PayFast merchant settings for notify_url</li>
                                <li>Network tab in Render dashboard</li>
                            </ul>
                        </li>
                    </ol>
                    <p><a href="/test-itn" target="_blank">Test ITN endpoint manually</a></p>
                </div>
            </div>
        </body>
        </html>
    `);
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

        if (!db) {
            return res.status(500).json({
                success: false,
                error: 'Database unavailable'
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

// ========== HEALTH CHECK ==========
app.get('/health', (req, res) => {
    const firebaseConfig = JSON.parse(process.env.FIREBASE_KEY || '{}');
    const isDemoAccount = PAYFAST_CONFIG.merchantId === '10000100';

    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'Salwa Payment Server',
        endpoints: {
            processPayment: 'POST /process-payment',
            itnHandler: 'POST /payfast-notify',
            testItn: 'POST /test-itn',
            checkStatus: 'POST /check-payment-status',
            manualTest: 'GET /manual-test',
            health: 'GET /health'
        },
        config: {
            merchantId: PAYFAST_CONFIG.merchantId ? PAYFAST_CONFIG.merchantId.substring(0, 4) + '...' : 'MISSING',
            merchantKey: PAYFAST_CONFIG.merchantKey ? PAYFAST_CONFIG.merchantKey.substring(0, 4) + '...' : 'MISSING',
            passphrase: PAYFAST_CONFIG.passphrase ? 'SET (' + PAYFAST_CONFIG.passphrase.substring(0, 4) + '...)' : 'MISSING',
            sandbox: PAYFAST_CONFIG.sandbox,
            firebase: firebaseConfig.project_id ? 'CONNECTED' : 'DISCONNECTED',
            notifyUrl: getNotifyUrl()
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
    🌐 External URL: ${process.env.RENDER_EXTERNAL_URL || 'Not set'}
    🌐 Hostname: ${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost:' + PORT}
    
    📋 Endpoints:
    ├── POST /process-payment    - Create payment links
    ├── POST /payfast-notify     - Receive ITN notifications (CRITICAL)
    ├── POST /test-itn           - Test ITN endpoint
    ├── POST /check-payment-status - Check booking status
    ├── GET  /manual-test        - Manual PayFast test page
    └── GET  /health             - Server health check
    
    🔗 ITN Notify URL: ${getNotifyUrl()}
    
    ⚠️  IMPORTANT: Make sure these env vars are set in Render:
    ├── FIREBASE_KEY             - Your Firebase service account key
    ├── PAYFAST_MERCHANT_ID      - Your PayFast merchant ID
    ├── PAYFAST_MERCHANT_KEY     - Your PayFast merchant key
    ├── PAYFAST_PASSPHRASE       - Your PayFast passphrase
    ├── PAYFAST_SANDBOX=true     - Set to false for production
    ├── RENDER_EXTERNAL_URL      - Should be auto-set by Render
    └── RENDER_EXTERNAL_HOSTNAME - Should be auto-set by Render
    
    🐛 Debug ITN Issues:
    1. Visit /manual-test to create a test payment
    2. Complete the payment in sandbox
    3. Check Render logs for "🟣 ITN RECEIVED"
    4. If no ITN, check if PayFast can reach ${getNotifyUrl()}
    `);
});