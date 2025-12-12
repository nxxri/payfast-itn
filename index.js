const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios');
const querystring = require('querystring');
const crypto = require('crypto');

const app = express();
// ===== FIX GLOBAL CORS (must be at the VERY TOP) =====
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }

    next();
});

// ========== MIDDLEWARE ==========
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

// Debug middleware for all requests
app.use((req, res, next) => {
    console.log(`📥 ${req.method} ${req.url}`);
    if (req.body && Object.keys(req.body).length > 0) {
        console.log('📦 Body:', JSON.stringify(req.body, null, 2));
    }
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
    returnUrl: "https://salwacollective.co.za/payment-result.html?payment_return=1",
    cancelUrl: "https://salwacollective.co.za/payment-result.html?payment_return=1",
    productionUrl: "https://www.payfast.co.za/eng/process",
    sandboxUrl: "https://sandbox.payfast.co.za/eng/process"
};

// ========== HELPER FUNCTIONS ==========
function generateSignature(data, passPhrase = null) {
    console.log('🔍 Generating signature with passphrase:', passPhrase || 'NONE');

    // Remove signature from data if present
    const signatureData = { ...data };
    delete signatureData.signature;

    // Create parameter string in alphabetical order
    let pfOutput = '';
    const sortedKeys = Object.keys(signatureData).sort();

    for (let key of sortedKeys) {
        // Only include parameters that are not empty strings
        if (signatureData[key] !== undefined && signatureData[key] !== null && signatureData[key] !== '') {
            const encodedValue = encodeURIComponent(signatureData[key].toString()).replace(/%20/g, '+');
            pfOutput += `${key}=${encodedValue}&`;
        }
    }

    // Remove trailing ampersand
    pfOutput = pfOutput.slice(0, -1);

    // IMPORTANT: Add passphrase if it's provided (even if it's empty string, some PayFast accounts need it)
    if (passPhrase !== null && passPhrase !== undefined) {
        const encodedPassphrase = encodeURIComponent(passPhrase).replace(/%20/g, '+');
        pfOutput += `&passphrase=${encodedPassphrase}`;
    }

    console.log('🔍 Signature string:', pfOutput);

    // Generate MD5 hash
    return crypto.createHash('md5').update(pfOutput).digest('hex');
}

function verifyPayFastSignature(data, passphrase = '') {
    console.log('🔍 Verifying signature with passphrase:', passphrase || 'NONE');

    const submittedSignature = data.signature;

    let pfParamString = '';
    const sortedKeys = Object.keys(data).sort();

    for (const key of sortedKeys) {
        if (key !== 'signature' &&
            data[key] !== undefined &&
            data[key] !== null &&
            data[key] !== '') {
            const encodedValue = encodeURIComponent(data[key].toString()).replace(/%20/g, '+');
            pfParamString += `${key}=${encodedValue}&`;
        }
    }

    pfParamString = pfParamString.slice(0, -1);

    if (passphrase !== null && passphrase !== undefined) {
        const encodedPassphrase = encodeURIComponent(passphrase).replace(/%20/g, '+');
        pfParamString += `&passphrase=${encodedPassphrase}`;
    }

    const calculatedSignature = crypto.createHash('md5').update(pfParamString).digest('hex');

    console.log('🔍 Verification:');
    console.log('Submitted:', submittedSignature);
    console.log('Calculated:', calculatedSignature);
    console.log('Match?', calculatedSignature === submittedSignature);

    return calculatedSignature === submittedSignature;
}

// ========== ROUTE 1: PROCESS PAYMENT (FIXED) ==========
app.post('/process-payment', (req, res) => {
    try {
        console.log('🔵 Payment request received:', req.body);

        const {
            amount, item_name, name_first, name_last, email_address,
            cell_number, event_id, ticket_number, booking_id, ticket_quantity
        } = req.body;

        // Validation
        if (!amount || !item_name || !email_address || !booking_id) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields',
                received: req.body
            });
        }

        // Get current Render URL dynamically
        const renderUrl = process.env.RENDER_EXTERNAL_URL || `https://${req.get('host')}`;

        // Build payment data
        const paymentData = {
            merchant_id: PAYFAST_CONFIG.merchantId,
            merchant_key: PAYFAST_CONFIG.merchantKey,
            return_url: `${PAYFAST_CONFIG.returnUrl}&booking_id=${booking_id}`,
            cancel_url: `${PAYFAST_CONFIG.cancelUrl}&booking_id=${booking_id}`,
            notify_url: `${renderUrl}/payfast-notify`,
            name_first: name_first || '',
            name_last: name_last || '',
            email_address: email_address,
            cell_number: cell_number || '',
            amount: parseFloat(amount).toFixed(2),
            item_name: item_name.substring(0, 100),
            item_description: `Booking ${ticket_number} for ${item_name}`.substring(0, 255),
            email_confirmation: '1',
            confirmation_address: email_address,
            m_payment_id: booking_id,
            custom_str1: event_id || '',
            custom_str2: ticket_number || '',
            custom_str3: booking_id || '',
            custom_int1: ticket_quantity || 1
        };

        // Remove completely empty fields (null or empty string)
        Object.keys(paymentData).forEach(key => {
            if (paymentData[key] === '' || paymentData[key] === null || paymentData[key] === undefined) {
                delete paymentData[key];
            }
        });

        console.log('🟡 Cleaned payment data:', paymentData);

        // CRITICAL FIX: Always use the passphrase from config
        // PayFast expects the passphrase to be included in signature calculation if it's set
        const signature = generateSignature(paymentData, PAYFAST_CONFIG.passphrase);
        paymentData.signature = signature;

        console.log('🔍 Generated signature:', signature);
        console.log('🔍 Mode:', PAYFAST_CONFIG.sandbox ? 'SANDBOX' : 'PRODUCTION');
        console.log('🔍 Merchant ID:', PAYFAST_CONFIG.merchantId);
        console.log('🔍 Has passphrase?', PAYFAST_CONFIG.passphrase ? 'YES' : 'NO');

        // Create redirect URL
        const payfastUrl = PAYFAST_CONFIG.sandbox ? PAYFAST_CONFIG.sandboxUrl : PAYFAST_CONFIG.productionUrl;
        const queryString = new URLSearchParams(paymentData).toString();
        const redirectUrl = `${payfastUrl}?${queryString}`;

        console.log('🟢 Redirect URL (first 200 chars):', redirectUrl.substring(0, 200));

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

// ========== TEST PAYFAST SIGNATURE ENDPOINT ==========
app.get('/test-signature', (req, res) => {
    try {
        const testData = {
            merchant_id: PAYFAST_CONFIG.merchantId || '10000100',
            merchant_key: PAYFAST_CONFIG.merchantKey || '46f0cd694581a',
            amount: '150.00',
            item_name: 'Test Event',
            m_payment_id: 'test-' + Date.now()
        };

        console.log('🧪 TESTING SIGNATURE GENERATION');
        console.log('Sandbox Mode:', PAYFAST_CONFIG.sandbox);
        console.log('Passphrase:', PAYFAST_CONFIG.passphrase || 'EMPTY');

        // Test different scenarios
        const results = {
            withoutPassphrase: generateSignature(testData, null),
            withEmptyPassphrase: generateSignature(testData, ''),
            withConfigPassphrase: generateSignature(testData, PAYFAST_CONFIG.passphrase)
        };

        res.json({
            success: true,
            config: {
                sandbox: PAYFAST_CONFIG.sandbox,
                hasPassphrase: !!PAYFAST_CONFIG.passphrase,
                merchantIdSet: !!PAYFAST_CONFIG.merchantId,
                merchantKeySet: !!PAYFAST_CONFIG.merchantKey
            },
            signatures: results,
            recommendation: PAYFAST_CONFIG.passphrase ?
                'Use withConfigPassphrase (passphrase is set)' :
                'Use withoutPassphrase (no passphrase set)'
        });

    } catch (error) {
        console.error('Test error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== ROUTE 2: ITN HANDLER ==========
app.post('/payfast-notify', async (req, res) => {
    const data = req.body;

    try {
        console.log('🟣 ITN received:', JSON.stringify(data, null, 2));

        // Verify signature with the same passphrase logic
        const isValidSignature = verifyPayFastSignature(data, PAYFAST_CONFIG.passphrase);

        if (!isValidSignature) {
            console.error('🔴 Invalid ITN signature');
            return res.status(400).send('Invalid signature');
        }

        // Verify with PayFast
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
            const paymentStatus = data.payment_status;

            console.log(`🟢 Valid ITN for booking ${bookingId}, status: ${paymentStatus}`);

            // Update Firebase
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

// ========== ROUTE 3: CHECK PAYMENT STATUS ==========
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

        res.json({
            success: true,
            bookingId: bookingId,
            status: bookingData.status || 'pending',
            paymentStatus: bookingData.paymentStatus || 'pending',
            isPaid: bookingData.isPaid || false,
            itnReceived: bookingData.itnReceived || false,
            ticketNumber: bookingData.ticketNumber || '',
            eventName: bookingData.eventName || '',
            eventDate: bookingData.eventDate || '',
            userName: bookingData.userName || '',
            totalAmount: bookingData.totalAmount || 0,
            updatedAt: bookingData.lastUpdated || bookingData.createdAt
        });

    } catch (error) {
        console.error('Error checking payment status:', error);
        res.status(500).json({
            success: false,
            error: 'Server error'
        });
    }
});

// ========== ROUTE 4: HEALTH CHECK ==========
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'Salwa Payment Server',
        endpoints: {
            processPayment: 'POST /process-payment',
            itnHandler: 'POST /payfast-notify',
            checkStatus: 'POST /check-payment-status',
            testSignature: 'GET /test-signature'
        },
        config: {
            merchantId: PAYFAST_CONFIG.merchantId ? 'SET' : 'MISSING',
            merchantKey: PAYFAST_CONFIG.merchantKey ? 'SET' : 'MISSING',
            passphrase: PAYFAST_CONFIG.passphrase ? 'SET' : 'MISSING',
            sandbox: PAYFAST_CONFIG.sandbox,
            firebase: serviceAccount.project_id ? 'CONNECTED' : 'DISCONNECTED'
        }
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
    ├── GET  /test-signature     - Test signature generation
    └── GET  /health             - Server health check
    
    ⚠️  Make sure these env vars are set in Render:
    ├── FIREBASE_KEY
    ├── PAYFAST_MERCHANT_ID
    ├── PAYFAST_MERCHANT_KEY
    ├── PAYFAST_PASSPHRASE
    └── PAYFAST_SANDBOX=true
    `);
});