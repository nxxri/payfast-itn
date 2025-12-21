const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios');
const querystring = require('querystring');
const crypto = require('crypto');

const app = express();

// ===== CORS =====
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");

    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }
    next();
});

// ========== MIDDLEWARE ==========
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

// Debug middleware
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
    merchantId: process.env.PAYFAST_MERCHANT_ID || '32449257',
    merchantKey: process.env.PAYFAST_MERCHANT_KEY || '4wkknlvwwll3x',
    passphrase: process.env.PAYFAST_PASSPHRASE || 'Salwa20242024',
    sandbox: process.env.PAYFAST_SANDBOX !== 'false', // Fixed: Default to true unless explicitly false
    returnUrl: "https://salwacollective.co.za/payment-result.html?payment_return=1",
    cancelUrl: "https://salwacollective.co.za/payment-result.html?payment_return=0",
    productionUrl: "https://www.payfast.co.za/eng/process", // Fixed: Removed space
    sandboxUrl: "https://sandbox.payfast.co.za/eng/process"
};

// ========== CORRECT SIGNATURE FUNCTION (TESTED AND WORKING) ==========
function generatePayFastSignature(data, passPhrase = null) {
    console.log('🔍 Generating PayFast signature...');

    // Remove signature if present
    const signatureData = { ...data };
    delete signatureData.signature;

    // Filter out empty/null/undefined values
    Object.keys(signatureData).forEach(key => {
        if (signatureData[key] === null || signatureData[key] === undefined || signatureData[key] === '') {
            delete signatureData[key];
        }
    });

    // Sort keys alphabetically (PayFast requirement)
    const sortedKeys = Object.keys(signatureData).sort();
    let pfOutput = '';

    // Build parameter string
    sortedKeys.forEach(key => {
        const value = String(signatureData[key]);
        // PayFast uses encodeURIComponent with %20 replaced by +
        const encodedValue = encodeURIComponent(value).replace(/%20/g, '+');
        pfOutput += `${key}=${encodedValue}&`;
    });

    // Remove trailing '&'
    if (pfOutput.endsWith('&')) {
        pfOutput = pfOutput.slice(0, -1);
    }

    console.log('📝 String before passphrase:', pfOutput);

    // Add passphrase if provided
    if (passPhrase && passPhrase.trim() !== '') {
        const encodedPassphrase = encodeURIComponent(passPhrase.trim()).replace(/%20/g, '+');
        pfOutput += `&passphrase=${encodedPassphrase}`;
        console.log('📝 String with passphrase:', pfOutput);
    }

    // Generate MD5 hash
    const signature = crypto.createHash('md5').update(pfOutput).digest('hex');
    console.log('✅ Generated signature:', signature);

    return signature;
}

function verifyPayFastSignature(data, passphrase = '') {
    console.log('🔍 Verifying PayFast signature...');

    const submittedSignature = data.signature;

    // Create a clean copy without signature
    const signatureData = {};
    Object.keys(data).forEach(key => {
        if (key !== 'signature' && data[key] !== undefined && data[key] !== null && data[key] !== '') {
            signatureData[key] = data[key];
        }
    });

    // Sort keys alphabetically
    const sortedKeys = Object.keys(signatureData).sort();
    let pfParamString = '';

    sortedKeys.forEach(key => {
        const value = signatureData[key].toString();
        const encodedValue = encodeURIComponent(value).replace(/%20/g, '+');
        pfParamString += `${key}=${encodedValue}&`;
    });

    // Remove trailing '&'
    if (pfParamString.endsWith('&')) {
        pfParamString = pfParamString.slice(0, -1);
    }

    // Add passphrase if provided
    if (passphrase && passphrase.trim() !== '') {
        const encodedPassphrase = encodeURIComponent(passphrase.trim()).replace(/%20/g, '+');
        pfParamString += `&passphrase=${encodedPassphrase}`;
    }

    const calculatedSignature = crypto.createHash('md5').update(pfParamString).digest('hex');

    console.log('🔍 Signature comparison:');
    console.log('Submitted:', submittedSignature);
    console.log('Calculated:', calculatedSignature);
    console.log('Match?', calculatedSignature === submittedSignature);

    return calculatedSignature === submittedSignature;
}

// Helper function
function convertFirestoreTimestamp(timestamp) {
    if (!timestamp) return new Date();
    if (timestamp.toDate) return timestamp.toDate();
    if (timestamp.seconds) return new Date(timestamp.seconds * 1000);
    if (timestamp._seconds) return new Date(timestamp._seconds * 1000);
    return new Date(timestamp);
}

// ========== DEBUG SIGNATURE ENDPOINT ==========
app.get('/debug-signature', (req, res) => {
    const testData = {
        merchant_id: PAYFAST_CONFIG.merchantId,
        merchant_key: PAYFAST_CONFIG.merchantKey,
        return_url: 'https://salwacollective.co.za/payment-result.html?payment_return=1&booking_id=test123',
        cancel_url: 'https://salwacollective.co.za/payment-result.html?payment_return=0&booking_id=test123',
        notify_url: 'https://payfast-itn.onrender.com/payfast-notify',
        name_first: 'Test',
        name_last: 'User',
        email_address: 'test@example.com',
        amount: '5.00',
        item_name: 'Salwa Collective Test',
        m_payment_id: 'test-' + Date.now()
    };

    const signature = generatePayFastSignature(testData, PAYFAST_CONFIG.passphrase);
    testData.signature = signature;

    const queryString = new URLSearchParams(testData).toString();
    const testUrl = PAYFAST_CONFIG.sandbox
        ? `${PAYFAST_CONFIG.sandboxUrl}?${queryString}`
        : `${PAYFAST_CONFIG.productionUrl}?${queryString}`;

    res.json({
        success: true,
        testData: testData,
        signature: signature,
        passphrase: PAYFAST_CONFIG.passphrase || 'NOT SET',
        testUrl: testUrl,
        config: {
            merchantId: PAYFAST_CONFIG.merchantId,
            merchantKey: PAYFAST_CONFIG.merchantKey ? PAYFAST_CONFIG.merchantKey.substring(0, 4) + '...' : 'MISSING',
            sandbox: PAYFAST_CONFIG.sandbox,
            passphraseLength: PAYFAST_CONFIG.passphrase ? PAYFAST_CONFIG.passphrase.length : 0
        }
    });
});

// ========== SIMPLE TEST ENDPOINT ==========
app.get('/simple-test', (req, res) => {
    const testData = {
        merchant_id: PAYFAST_CONFIG.merchantId,
        merchant_key: PAYFAST_CONFIG.merchantKey,
        return_url: 'https://salwacollective.co.za',
        cancel_url: 'https://salwacollective.co.za',
        notify_url: 'https://payfast-itn.onrender.com/payfast-notify',
        name_first: 'Test',
        name_last: 'User',
        email_address: 'test@example.com',
        amount: '5.00',
        item_name: 'Salwa Collective Test',
        m_payment_id: 'test-' + Date.now()
    };

    const signature = generatePayFastSignature(testData, PAYFAST_CONFIG.passphrase);
    testData.signature = signature;

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Simple PayFast Test</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; }
                pre { background: #f5f5f5; padding: 15px; border-radius: 5px; }
                .btn { background: #4CAF50; color: white; padding: 12px 24px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; margin-top: 20px; display: inline-block; }
            </style>
        </head>
        <body>
            <h1>🧪 Simple PayFast Test</h1>
            <h3>Signature: ${signature}</h3>
            <pre>${JSON.stringify(testData, null, 2)}</pre>
            
            <form action="${PAYFAST_CONFIG.sandbox ? PAYFAST_CONFIG.sandboxUrl : PAYFAST_CONFIG.productionUrl}" method="post">
                ${Object.entries(testData).map(([key, value]) =>
        `<input type="hidden" name="${key}" value="${value}">`
    ).join('')}
                <button type="submit" class="btn">Test PayFast Payment</button>
            </form>
        </body>
        </html>
    `);
});

// ========== PROCESS PAYMENT ==========
app.post('/process-payment', async (req, res) => {
    try {
        console.log('🔵 Payment request received:', req.body);

        const {
            amount, item_name, name_first, name_last, email_address,
            cell_number, event_id, ticket_number, booking_id, ticket_quantity,
            event_name, event_date
        } = req.body;

        // Validation
        if (!amount || !email_address || !booking_id) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields',
                received: req.body
            });
        }

        // Basic payment data
        const paymentData = {
            merchant_id: PAYFAST_CONFIG.merchantId,
            merchant_key: PAYFAST_CONFIG.merchantKey,
            return_url: `${PAYFAST_CONFIG.returnUrl}&booking_id=${booking_id}`,
            cancel_url: `${PAYFAST_CONFIG.cancelUrl}&booking_id=${booking_id}`,
            notify_url: `https://payfast-itn.onrender.com/payfast-notify`,
            email_address: email_address,
            amount: parseFloat(amount).toFixed(2),
            item_name: (item_name || 'Salwa Event').substring(0, 100),
            m_payment_id: booking_id
        };

        // Optional fields
        if (name_first) paymentData.name_first = name_first;
        if (name_last) paymentData.name_last = name_last;
        if (cell_number) paymentData.cell_number = cell_number;

        console.log('🟡 Clean payment data:', paymentData);

        // Generate signature
        const signature = generatePayFastSignature(paymentData, PAYFAST_CONFIG.passphrase);
        paymentData.signature = signature;

        // Store booking in Firestore
        try {
            const bookingData = {
                bookingId: booking_id,
                eventId: event_id || '',
                ticketNumber: ticket_number || '',
                ticketQuantity: ticket_quantity || 1,
                totalAmount: parseFloat(amount),
                itemName: item_name || 'Salwa Event',
                eventName: event_name || item_name || 'Salwa Event',
                eventDate: event_date || '',
                customerEmail: email_address,
                customerFirstName: name_first || '',
                customerLastName: name_last || '',
                customerPhone: cell_number || '',
                userName: `${name_first || ''} ${name_last || ''}`.trim(),
                status: 'pending_payment',
                paymentStatus: 'PENDING',
                isPaid: false,
                itnReceived: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                paymentTimeout: new Date(Date.now() + 30 * 60 * 1000),
                paymentMethod: 'payfast',
                gatewayData: {
                    merchantId: PAYFAST_CONFIG.merchantId,
                    sandbox: PAYFAST_CONFIG.sandbox,
                    signature: signature
                }
            };

            await db.collection('bookings').doc(booking_id).set(bookingData);
            console.log(`✅ Booking ${booking_id} stored`);

        } catch (firestoreError) {
            console.error('🔴 Firestore error:', firestoreError);
        }

        // Create redirect URL
        const payfastUrl = PAYFAST_CONFIG.sandbox ? PAYFAST_CONFIG.sandboxUrl : PAYFAST_CONFIG.productionUrl;
        const queryString = new URLSearchParams(paymentData).toString();
        const redirectUrl = `${payfastUrl}?${queryString}`;

        console.log('🟢 Redirect URL:', redirectUrl);

        res.json({
            success: true,
            redirectUrl: redirectUrl,
            bookingId: booking_id,
            signature: signature
        });

    } catch (error) {
        console.error('🔴 Payment error:', error);
        res.status(500).json({
            success: false,
            error: 'Payment processing failed',
            message: error.message
        });
    }
});

// ========== ITN HANDLER ==========
app.post('/payfast-notify', async (req, res) => {
    const data = req.body;
    console.log('🟣 ITN received:', JSON.stringify(data, null, 2));

    try {
        // Validate signature
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

        console.log('🔍 PayFast response:', response.data);

        if (response.data.trim() === 'VALID') {
            const bookingId = data.m_payment_id;
            const paymentStatus = data.payment_status?.toUpperCase() || '';

            console.log(`🟢 Valid ITN for ${bookingId}, status: ${paymentStatus}`);

            const updateData = {
                paymentStatus: paymentStatus,
                payfastPaymentId: data.pf_payment_id,
                amountPaid: parseFloat(data.amount_gross || 0),
                fee: parseFloat(data.amount_fee || 0),
                itnReceived: true,
                itnTimestamp: admin.firestore.FieldValue.serverTimestamp(),
                payerEmail: data.email_address,
                payerPhone: data.cell_number || '',
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
                updateData.cancellationReason = 'user_cancelled';
            } else if (paymentStatus === 'FAILED') {
                updateData.status = 'failed';
                updateData.isPaid = false;
                updateData.cancellationReason = 'payment_failed';
            }

            await db.collection('bookings').doc(bookingId).update(updateData);
            console.log(`✅ Booking ${bookingId} updated`);

        } else {
            console.error('🔴 Invalid ITN:', response.data);
        }

        res.status(200).send('OK');

    } catch (err) {
        console.error('🔴 ITN error:', err);
        res.status(500).send('Server error');
    }
});

// ========== CHECK PAYMENT STATUS ==========
app.post('/check-payment-status', async (req, res) => {
    try {
        const { bookingId } = req.body;

        if (!bookingId) {
            return res.status(400).json({ success: false, error: 'Booking ID required' });
        }

        const bookingDoc = await db.collection('bookings').doc(bookingId).get();

        if (!bookingDoc.exists) {
            return res.status(404).json({ success: false, error: 'Booking not found' });
        }

        const bookingData = bookingDoc.data();

        res.json({
            success: true,
            bookingId: bookingId,
            status: bookingData.status || 'pending',
            paymentStatus: bookingData.paymentStatus || 'pending',
            isPaid: bookingData.isPaid || false,
            itnReceived: bookingData.itnReceived || false,
            eventName: bookingData.eventName || '',
            totalAmount: bookingData.totalAmount || 0
        });

    } catch (error) {
        console.error('Status check error:', error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// ========== VERIFY PAYMENT ==========
app.post('/verify-payment', async (req, res) => {
    try {
        const { bookingId } = req.body;

        if (!bookingId) {
            return res.status(400).json({ success: false, error: 'Booking ID required' });
        }

        const bookingDoc = await db.collection('bookings').doc(bookingId).get();

        if (!bookingDoc.exists) {
            return res.status(404).json({ success: false, error: 'Booking not found' });
        }

        const bookingData = bookingDoc.data();

        res.json({
            success: true,
            valid: bookingData.isPaid || bookingData.status === 'confirmed',
            booking: bookingData
        });

    } catch (error) {
        console.error('Verify error:', error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// ========== HEALTH CHECK ==========
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'Salwa Payment Server',
        mode: PAYFAST_CONFIG.sandbox ? 'SANDBOX' : 'PRODUCTION',
        merchantId: PAYFAST_CONFIG.merchantId,
        passphrase: PAYFAST_CONFIG.passphrase ? 'SET' : 'NOT SET'
    });
});

// ========== TEST WITH PAYFAST SIGNATURE GENERATOR ==========
app.get('/test-signature', (req, res) => {
    // Same data as PayFast's signature generator
    const testData = {
        merchant_id: '10000100', // PayFast test merchant
        merchant_key: '46f0cd694581a',
        return_url: 'http://www.example.com/return',
        cancel_url: 'http://www.example.com/cancel',
        notify_url: 'http://www.example.com/notify',
        name_first: 'First Name',
        name_last: 'Last Name',
        email_address: 'test@example.com',
        m_payment_id: '1234',
        amount: '100.00',
        item_name: 'Test Item',
        item_description: 'Description'
    };

    // Test with and without passphrase
    const signatureNoPassphrase = generatePayFastSignature({ ...testData }, '');
    const signatureWithPassphrase = generatePayFastSignature({ ...testData }, 'jt7NOE43F5Pn');

    res.json({
        testData: testData,
        signatureNoPassphrase: signatureNoPassphrase,
        signatureWithPassphrase: signatureWithPassphrase,
        expectedNoPassphrase: '5e715ace54207fe9b294977d5c12db5c',
        expectedWithPassphrase: '251dbb005d1d7d06239e2565e0c57a5d'
    });
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
    🚀 Salwa Payment Server Started!
    📍 Port: ${PORT}
    🔒 Mode: ${PAYFAST_CONFIG.sandbox ? 'SANDBOX 🧪' : 'PRODUCTION 🏢'}
    🔑 Merchant ID: ${PAYFAST_CONFIG.merchantId}
    📝 Passphrase: ${PAYFAST_CONFIG.passphrase ? 'SET' : 'NOT SET'}
    
    📋 Test Endpoints:
    -----------------
    GET  /health          - Health check
    GET  /debug-signature - Debug signature
    GET  /simple-test     - Simple test form
    GET  /test-signature  - Compare with PayFast generator
    POST /process-payment - Process payment
    POST /payfast-notify  - ITN handler
    POST /check-payment-status - Check status
    
    ⚠️  For LIVE Production:
    ---------------------
    1. Set PAYFAST_SANDBOX=false in Render
    2. Verify LIVE credentials in PayFast dashboard
    3. Enable ITN in PayFast settings
    4. Test with small amount first
    
    🌐 External URL: https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost:' + PORT}
    `);
});