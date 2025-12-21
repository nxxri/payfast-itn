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
    merchantId: process.env.PAYFAST_MERCHANT_ID,
    merchantKey: process.env.PAYFAST_MERCHANT_KEY,
    passphrase: process.env.PAYFAST_PASSPHRASE || '',
    sandbox: process.env.PAYFAST_SANDBOX === 'false',
    returnUrl: "https://salwacollective.co.za/payment-result.html?payment_return=1",
    cancelUrl: "https://salwacollective.co.za/payment-result.html?payment_return=0",
    productionUrl: " https://www.payfast.co.za/eng/process",
    sandboxUrl: "https://sandbox.payfast.co.za/eng/process"
};

// ========== UPDATED SIGNATURE FUNCTIONS ==========
function generatePayFastSignature(data, passPhrase = null) {
    console.log('🔍 Generating PayFast signature...');
    console.log('🔍 Original data:', JSON.stringify(data, null, 2));

    // Create a clean copy
    const signatureData = {};

    // Only include defined, non-empty values
    Object.keys(data).forEach(key => {
        if (data[key] !== undefined && data[key] !== null && data[key] !== '') {
            signatureData[key] = data[key];
        }
    });

    // Sort keys alphabetically (PayFast requirement)
    const sortedKeys = Object.keys(signatureData).sort();
    console.log('🔍 Sorted keys for signature:', sortedKeys);

    // Build parameter string
    let pfParamString = '';

    sortedKeys.forEach(key => {
        if (key === 'signature') return; // Skip signature field

        const value = signatureData[key].toString();
        const encodedValue = encodeURIComponent(value).replace(/%20/g, '+');
        pfParamString += `${key}=${encodedValue}&`;
    });

    // Remove trailing '&'
    pfParamString = pfParamString.slice(0, -1);

    console.log('🔍 String before passphrase:', pfParamString);

    // Add passphrase if provided (ONLY if it exists and not empty)
    if (passPhrase && passPhrase.trim() !== '') {
        const encodedPassphrase = encodeURIComponent(passPhrase.trim()).replace(/%20/g, '+');
        pfParamString += `&passphrase=${encodedPassphrase}`;
        console.log('🔍 String after passphrase:', pfParamString);
        console.log('🔍 Passphrase used:', passPhrase.trim());
    } else {
        console.log('🔍 No passphrase used');
    }

    // Generate MD5 hash
    const signature = crypto.createHash('md5').update(pfParamString).digest('hex');
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
    pfParamString = pfParamString.slice(0, -1);

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
        return_url: PAYFAST_CONFIG.returnUrl + '&booking_id=test123',
        cancel_url: PAYFAST_CONFIG.cancelUrl + '&booking_id=test123',
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
    const testUrl = `${PAYFAST_CONFIG.sandboxUrl}?${queryString}`;

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

// ========== PROCESS PAYMENT (UPDATED) ==========
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
                error: 'Missing required fields: amount, email_address, or booking_id',
                received: req.body
            });
        }

        // Basic payment data (minimal fields)
        const paymentData = {
            merchant_id: PAYFAST_CONFIG.merchantId,
            merchant_key: PAYFAST_CONFIG.merchantKey,
            return_url: PAYFAST_CONFIG.returnUrl + '&booking_id=' + booking_id,
            cancel_url: PAYFAST_CONFIG.cancelUrl + '&booking_id=' + booking_id,
            notify_url: `https://payfast-itn.onrender.com/payfast-notify`,
            email_address: email_address,
            amount: parseFloat(amount).toFixed(2),
            item_name: (item_name || 'Salwa Event Ticket').substring(0, 100),
            m_payment_id: booking_id
        };

        // Optional fields (only if provided)
        if (name_first) paymentData.name_first = name_first;
        if (name_last) paymentData.name_last = name_last;
        if (cell_number) paymentData.cell_number = cell_number;

        // Remove any empty fields
        Object.keys(paymentData).forEach(key => {
            if (paymentData[key] === null || paymentData[key] === undefined || paymentData[key] === '') {
                delete paymentData[key];
            }
        });

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
                paymentGateway: 'payfast',
                gatewayData: {
                    merchantId: PAYFAST_CONFIG.merchantId,
                    sandbox: PAYFAST_CONFIG.sandbox,
                    signature: signature
                }
            };

            await db.collection('bookings').doc(booking_id).set(bookingData);
            console.log(`✅ Booking ${booking_id} stored in Firestore`);

        } catch (firestoreError) {
            console.error('🔴 Firestore save error:', firestoreError);
            // Continue anyway - don't fail the payment if Firestore has issues
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
            debug: {
                paymentData: paymentData,
                paramCount: Object.keys(paymentData).length,
                sandbox: PAYFAST_CONFIG.sandbox
            }
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

// ========== ITN HANDLER ==========
app.post('/payfast-notify', async (req, res) => {
    const data = req.body;
    console.log('🟣 ITN received:', JSON.stringify(data, null, 2));

    try {
        // First, validate signature
        const isValidSignature = verifyPayFastSignature(data, PAYFAST_CONFIG.passphrase);

        if (!isValidSignature) {
            console.error('🔴 Invalid ITN signature');

            // Log for debugging
            console.log('🔍 ITN Data for debugging:', {
                merchant_id: data.merchant_id,
                signature_received: data.signature,
                payment_status: data.payment_status,
                m_payment_id: data.m_payment_id
            });

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

        console.log('🔍 PayFast verification response:', response.data);

        if (response.data.trim() === 'VALID') {
            const bookingId = data.m_payment_id;
            const paymentStatus = data.payment_status?.toUpperCase() || '';

            console.log(`🟢 Valid ITN for booking ${bookingId}, status: ${paymentStatus}`);

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
                itnData: data
            };

            // Update booking status based on payment status
            if (paymentStatus === 'COMPLETE') {
                updateData.status = 'confirmed';
                updateData.paymentDate = admin.firestore.FieldValue.serverTimestamp();
                updateData.isPaid = true;
                console.log(`✅ Payment COMPLETE for booking ${bookingId}`);
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
                console.log(`❌ Payment FAILED for booking ${bookingId}`);
            } else {
                updateData.status = paymentStatus.toLowerCase();
                updateData.isPaid = false;
                console.log(`ℹ️  Payment status ${paymentStatus} for booking ${bookingId}`);
            }

            await db.collection('bookings').doc(bookingId).update(updateData);
            console.log(`✅ Booking ${bookingId} updated in Firestore`);

        } else {
            console.error('🔴 Invalid ITN response from PayFast:', response.data);
        }

        res.status(200).send('OK');

    } catch (err) {
        console.error('🔴 ITN processing error:', err);

        // Try to update Firestore with error
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

        // Check for timeout
        if (bookingData.paymentTimeout) {
            const timeoutDate = convertFirestoreTimestamp(bookingData.paymentTimeout);
            const now = new Date();

            if (timeoutDate < now && (bookingData.status === 'pending_payment' || bookingData.status === 'pending')) {
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
                    autoCancelled: true
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

// ========== DIRECT CANCELLATION ==========
app.post('/direct-cancel', async (req, res) => {
    try {
        const { bookingId } = req.body;

        if (!bookingId) {
            return res.status(400).json({ success: false, error: 'Booking ID required' });
        }

        const updateData = {
            paymentStatus: 'CANCELLED',
            status: 'cancelled',
            isPaid: false,
            cancellationReason: 'user_cancelled',
            cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        };

        await db.collection('bookings').doc(bookingId).update(updateData);

        res.json({
            success: true,
            message: 'Booking cancelled',
            bookingId: bookingId
        });

    } catch (error) {
        console.error('Direct cancellation error:', error);
        res.status(500).json({
            success: false,
            error: 'Cancellation failed'
        });
    }
});

// ========== VERIFY PAYMENT (NEW) ==========
app.post('/verify-payment', async (req, res) => {
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

        // Check if ITN has already been received
        if (bookingData.itnReceived) {
            return res.json({
                success: true,
                valid: true,
                booking: bookingData,
                message: 'Payment already verified via ITN'
            });
        }

        // If payment is marked as complete but no ITN yet, still valid
        if (bookingData.paymentStatus === 'COMPLETE' || bookingData.isPaid) {
            return res.json({
                success: true,
                valid: true,
                booking: bookingData,
                message: 'Payment confirmed'
            });
        }

        // Payment not yet confirmed
        return res.json({
            success: true,
            valid: false,
            booking: bookingData,
            message: 'Payment not yet confirmed'
        });

    } catch (error) {
        console.error('Verify payment error:', error);
        res.status(500).json({
            success: false,
            error: 'Verification failed'
        });
    }
});

// ========== MANUAL TEST PAGE ==========
app.get('/manual-test', (req, res) => {
    const testData = {
        merchant_id: PAYFAST_CONFIG.merchantId,
        merchant_key: PAYFAST_CONFIG.merchantKey,
        return_url: PAYFAST_CONFIG.returnUrl + '&booking_id=test123',
        cancel_url: PAYFAST_CONFIG.cancelUrl + '&booking_id=test123',
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
    const testUrl = `${PAYFAST_CONFIG.sandboxUrl}?${queryString}`;

    const testUrlNoPassphrase = testUrl.replace(/passphrase=[^&]*/, 'passphrase=REMOVED_FOR_DISPLAY');

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>PayFast Manual Test</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; max-width: 1000px; margin: 0 auto; }
                .container { background: #f5f5f5; padding: 30px; border-radius: 10px; }
                .card { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #4CAF50; }
                .url-box { background: #f8f9fa; padding: 15px; border: 1px solid #ddd; border-radius: 5px; word-break: break-all; font-family: monospace; font-size: 12px; }
                .btn { background: #4CAF50; color: white; padding: 12px 24px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; text-decoration: none; display: inline-block; }
                .btn-test { background: #2196F3; }
                .config-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
                .config-table th, .config-table td { padding: 10px; border: 1px solid #ddd; text-align: left; }
                .config-table th { background: #e3f2fd; }
                .debug-info { background: #fff3cd; padding: 15px; border-radius: 5px; margin: 15px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🧪 PayFast Integration Test</h1>
                
                <div class="card">
                    <h2>Configuration Status</h2>
                    <table class="config-table">
                        <tr>
                            <th>Setting</th>
                            <th>Status</th>
                            <th>Value</th>
                        </tr>
                        <tr>
                            <td>Merchant ID</td>
                            <td>${PAYFAST_CONFIG.merchantId ? '✅ SET' : '❌ MISSING'}</td>
                            <td>${PAYFAST_CONFIG.merchantId || 'Not configured'}</td>
                        </tr>
                        <tr>
                            <td>Merchant Key</td>
                            <td>${PAYFAST_CONFIG.merchantKey ? '✅ SET' : '❌ MISSING'}</td>
                            <td>${PAYFAST_CONFIG.merchantKey ? PAYFAST_CONFIG.merchantKey.substring(0, 4) + '...' : 'Not configured'}</td>
                        </tr>
                        <tr>
                            <td>Passphrase</td>
                            <td>${PAYFAST_CONFIG.passphrase ? '✅ SET' : '⚠️ NOT SET'}</td>
                            <td>${PAYFAST_CONFIG.passphrase ? 'Length: ' + PAYFAST_CONFIG.passphrase.length + ' chars' : 'No passphrase'}</td>
                        </tr>
                        <tr>
                            <td>Environment</td>
                            <td>${PAYFAST_CONFIG.sandbox ? '🧪 SANDBOX' : '🏢 PRODUCTION'}</td>
                            <td>${PAYFAST_CONFIG.sandbox ? 'Test mode - no real money' : 'Live mode - real money'}</td>
                        </tr>
                    </table>
                </div>

                <div class="card">
                    <h2>Test Payment Link</h2>
                    <p><strong>Generated Signature:</strong> ${signature}</p>
                    <div class="url-box">${testUrlNoPassphrase}</div>
                    
                    <p style="margin-top: 20px;">
                        <a href="${testUrl}" target="_blank" class="btn">Open PayFast Payment Page</a>
                        <a href="/debug-signature" target="_blank" class="btn btn-test">View Debug Info</a>
                    </p>
                </div>

                <div class="card">
                    <h2>💳 Test Card Details (Sandbox)</h2>
                    <table class="config-table">
                        <tr>
                            <td><strong>Card Number</strong></td>
                            <td>4000 0000 0000 0002</td>
                        </tr>
                        <tr>
                            <td><strong>Expiry Date</strong></td>
                            <td>Any future date (e.g., 12/30)</td>
                        </tr>
                        <tr>
                            <td><strong>CVV</strong></td>
                            <td>123</td>
                        </tr>
                        <tr>
                            <td><strong>3D Secure Password</strong></td>
                            <td>payfast</td>
                        </tr>
                    </table>
                    <p><em>This is a test payment - no real money will be charged.</em></p>
                </div>

                <div class="debug-info">
                    <h3>🔧 Troubleshooting Signature Mismatch</h3>
                    <p>If you get "signature mismatch" error:</p>
                    <ol>
                        <li>Check your PayFast dashboard → Settings → Integration → Security</li>
                        <li>If "Passphrase" is enabled, use the EXACT passphrase</li>
                        <li>If "Passphrase" is disabled, set PAYFAST_PASSPHRASE="" in Render</li>
                        <li>Visit <a href="/debug-signature" target="_blank">/debug-signature</a> to see signature details</li>
                        <li>Test with our <a href="https://sandbox.payfast.co.za/eng/tools/signature-generator" target="_blank">PayFast Signature Generator</a></li>
                    </ol>
                </div>

                <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd;">
                    <h3>📋 Available Endpoints</h3>
                    <ul>
                        <li><strong>POST /process-payment</strong> - Create payment link</li>
                        <li><strong>POST /payfast-notify</strong> - ITN handler (PayFast calls this)</li>
                        <li><strong>POST /check-payment-status</strong> - Check booking status</li>
                        <li><strong>POST /verify-payment</strong> - Immediate payment verification</li>
                        <li><strong>GET /debug-signature</strong> - Debug signature generation</li>
                        <li><strong>GET /manual-test</strong> - This test page</li>
                        <li><strong>GET /health</strong> - Server health check</li>
                    </ul>
                </div>
            </div>
        </body>
        </html>
    `);
});

// ========== HEALTH CHECK ==========
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'Salwa Payment Server',
        version: '2.0.0',
        endpoints: {
            processPayment: 'POST /process-payment',
            payfastNotify: 'POST /payfast-notify',
            checkPaymentStatus: 'POST /check-payment-status',
            verifyPayment: 'POST /verify-payment',
            directCancel: 'POST /direct-cancel',
            debugSignature: 'GET /debug-signature',
            manualTest: 'GET /manual-test',
            health: 'GET /health'
        },
        config: {
            merchantId: PAYFAST_CONFIG.merchantId || 'MISSING',
            merchantKey: PAYFAST_CONFIG.merchantKey ? 'SET' : 'MISSING',
            passphrase: PAYFAST_CONFIG.passphrase ? 'SET' : 'NOT SET',
            sandbox: PAYFAST_CONFIG.sandbox,
            firebase: serviceAccount.project_id ? 'CONNECTED' : 'DISCONNECTED'
        },
        notes: PAYFAST_CONFIG.sandbox ?
            '✅ SANDBOX MODE - Test payments only' :
            '⚠️ PRODUCTION MODE - Real payments'
    });
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
    🚀 Salwa Payment Server Started!
    📍 Port: ${PORT}
    🔒 Mode: ${PAYFAST_CONFIG.sandbox ? 'SANDBOX 🧪' : 'PRODUCTION 🏢'}
    🔑 Merchant ID: ${PAYFAST_CONFIG.merchantId || 'MISSING'}
    📝 Passphrase: ${PAYFAST_CONFIG.passphrase ? 'SET (' + PAYFAST_CONFIG.passphrase.length + ' chars)' : 'NOT SET'}
    🌐 External URL: https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost:' + PORT}
    
    📋 Critical Checkpoints:
    ├── 1. Visit /manual-test to run payment test
    ├── 2. Check /debug-signature if signature mismatch
    ├── 3. Verify ITN at /payfast-notify is working
    └── 4. Test frontend integration
    
    ⚠️  Environment Variables Required:
    ├── FIREBASE_KEY (Firebase service account JSON)
    ├── PAYFAST_MERCHANT_ID=10044213
    ├── PAYFAST_MERCHANT_KEY=9s7vajpkdyycf
    ├── PAYFAST_PASSPHRASE=salwa20242024 (or empty if not set)
    └── PAYFAST_SANDBOX=true (set to false for production)
    `);
});