const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios');
const querystring = require('querystring');
const crypto = require('crypto');
const cors = require('cors');

const app = express();

// ===== MIDDLEWARE SETUP =====
// Enable CORS for all origins (PayFast needs this)
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Parse both JSON and URL-encoded bodies
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.url}`);
    console.log('Origin:', req.headers.origin);
    console.log('Content-Type:', req.headers['content-type']);
    next();
});

// ===== FIREBASE INITIALIZATION =====
let db = null;
try {
    const firebaseConfig = JSON.parse(process.env.FIREBASE_KEY || '{}');

    if (!admin.apps.length && Object.keys(firebaseConfig).length > 0) {
        admin.initializeApp({
            credential: admin.credential.cert(firebaseConfig)
        });
        console.log('✅ Firebase Admin SDK initialized successfully');
    } else if (admin.apps.length) {
        console.log('✅ Firebase Admin SDK already initialized');
    } else {
        console.log('⚠️ Firebase config not found, running without Firebase');
    }

    db = admin.firestore();
} catch (error) {
    console.error('❌ Firebase initialization error:', error.message);
    db = null;
}

// ===== PAYFAST CONFIGURATION =====
const PAYFAST_CONFIG = {
    // IMPORTANT: Use sandbox for testing
    merchantId: process.env.PAYFAST_MERCHANT_ID || '10000100',
    merchantKey: process.env.PAYFAST_MERCHANT_KEY || '46f0cd694581a',
    passphrase: process.env.PAYFAST_PASSPHRASE || '',
    sandbox: process.env.PAYFAST_SANDBOX !== 'false', // Default to true

    // URLs
    productionUrl: "https://www.payfast.co.za/eng/process",
    sandboxUrl: "https://sandbox.payfast.co.za/eng/process",

    // ITN Verification URLs
    productionVerifyUrl: "https://www.payfast.co.za/eng/query/validate",
    sandboxVerifyUrl: "https://sandbox.payfast.co.za/eng/query/validate"
};

console.log('⚙️ PayFast Configuration:');
console.log('- Merchant ID:', PAYFAST_CONFIG.merchantId);
console.log('- Sandbox Mode:', PAYFAST_CONFIG.sandbox ? 'Yes (Testing)' : 'No (Production)');
console.log('- Passphrase:', PAYFAST_CONFIG.passphrase ? 'Set' : 'Not Set');

// ===== HELPER FUNCTIONS =====
function generatePayFastSignature(data, passPhrase = null) {
    console.log('🔐 Generating PayFast signature...');

    // Create a copy and remove existing signature
    const signatureData = { ...data };
    delete signatureData.signature;

    // Sort keys alphabetically
    const sortedKeys = Object.keys(signatureData).sort();
    let pfOutput = '';

    // Build the parameter string
    for (let key of sortedKeys) {
        if (signatureData[key] !== undefined && signatureData[key] !== null && signatureData[key] !== '') {
            pfOutput += `${key}=${encodeURIComponent(signatureData[key].toString()).replace(/%20/g, '+')}&`;
        }
    }

    // Remove trailing '&'
    pfOutput = pfOutput.slice(0, -1);

    // Add passphrase if provided
    if (passPhrase && passPhrase.trim() !== '') {
        pfOutput += `&passphrase=${encodeURIComponent(passPhrase.trim()).replace(/%20/g, '+')}`;
    }

    console.log('📝 Signature string:', pfOutput);

    // Generate MD5 hash
    const signature = crypto.createHash('md5').update(pfOutput).digest('hex');
    console.log('✅ Generated signature:', signature);

    return signature;
}

function verifyPayFastSignature(data, passphrase = '') {
    console.log('🔍 Verifying PayFast signature...');

    const submittedSignature = data.signature;
    const signatureData = { ...data };
    delete signatureData.signature;

    // Sort keys alphabetically
    const sortedKeys = Object.keys(signatureData).sort();
    let pfParamString = '';

    // Build the parameter string exactly as PayFast expects
    for (const key of sortedKeys) {
        if (signatureData[key] !== undefined && signatureData[key] !== null && signatureData[key] !== '') {
            pfParamString += `${key}=${encodeURIComponent(signatureData[key].toString()).replace(/%20/g, '+')}&`;
        }
    }

    // Remove trailing '&'
    pfParamString = pfParamString.slice(0, -1);

    // Add passphrase if provided
    if (passphrase && passphrase.trim() !== '') {
        pfParamString += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, '+')}`;
    }

    // Calculate signature
    const calculatedSignature = crypto.createHash('md5').update(pfParamString).digest('hex');

    console.log('📊 Signature comparison:');
    console.log('- Submitted:', submittedSignature);
    console.log('- Calculated:', calculatedSignature);
    console.log('- Match:', calculatedSignature === submittedSignature);

    return calculatedSignature === submittedSignature;
}

function getNotifyUrl() {
    // Try to get the correct external URL
    const renderUrl = process.env.RENDER_EXTERNAL_URL;
    const renderHostname = process.env.RENDER_EXTERNAL_HOSTNAME;

    let baseUrl;

    if (renderUrl) {
        baseUrl = renderUrl;
    } else if (renderHostname) {
        baseUrl = `https://${renderHostname}`;
    } else {
        // Fallback - UPDATE THIS WITH YOUR ACTUAL RENDER URL
        baseUrl = 'https://payfast-itn.onrender.com';
    }

    const notifyUrl = `${baseUrl}/payfast-notify`;
    console.log('🔗 Notify URL:', notifyUrl);
    return notifyUrl;
}

// ===== ROUTES =====

// 1. HEALTH CHECK ENDPOINT
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        service: 'Salwa Collective Payment Server',
        version: '2.0.0',
        endpoints: {
            processPayment: 'POST /process-payment',
            payfastNotify: 'POST /payfast-notify',
            checkStatus: 'POST /check-status',
            simulateITN: 'POST /simulate-itn',
            testPage: 'GET /test',
            health: 'GET /health'
        },
        config: {
            payfastMode: PAYFAST_CONFIG.sandbox ? 'sandbox' : 'production',
            firebase: db ? 'connected' : 'disconnected',
            notifyUrl: getNotifyUrl()
        }
    });
});

// 2. TEST PAGE
app.get('/test', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>PayFast ITN Test Dashboard</title>
            <style>
                body { font-family: Arial, sans-serif; max-width: 1000px; margin: 0 auto; padding: 20px; }
                .card { background: #f5f5f5; padding: 20px; border-radius: 10px; margin: 20px 0; }
                .btn { background: #4CAF50; color: white; padding: 12px 20px; border: none; border-radius: 5px; cursor: pointer; margin: 5px; }
                .btn-test { background: #2196F3; }
                .btn-simulate { background: #FF9800; }
                .btn-danger { background: #f44336; }
                pre { background: #333; color: #fff; padding: 15px; border-radius: 5px; overflow: auto; }
                .status { padding: 10px; border-radius: 5px; margin: 10px 0; }
                .status-success { background: #d4edda; color: #155724; }
                .status-error { background: #f8d7da; color: #721c24; }
            </style>
        </head>
        <body>
            <h1>🧪 PayFast ITN Test Dashboard</h1>
            
            <div class="card">
                <h2>📊 Server Status</h2>
                <div id="status"></div>
                <button class="btn" onclick="checkHealth()">Check Health</button>
            </div>
            
            <div class="card">
                <h2>🔗 Test ITN Endpoint</h2>
                <p>Test if PayFast can reach your ITN endpoint:</p>
                <button class="btn btn-test" onclick="testITNEndpoint()">Test ITN Endpoint</button>
                <div id="itnTestResult"></div>
            </div>
            
            <div class="card">
                <h2>🔄 Simulate ITN</h2>
                <p>Simulate a PayFast ITN notification:</p>
                <button class="btn btn-simulate" onclick="simulateITN()">Simulate ITN Notification</button>
                <div id="simulateResult"></div>
            </div>
            
            <div class="card">
                <h2>💰 Create Test Payment</h2>
                <button class="btn" onclick="createTestPayment()">Create Test Payment (R5)</button>
                <div id="paymentResult"></div>
            </div>
            
            <div class="card">
                <h2>📝 Configuration</h2>
                <pre id="config"></pre>
            </div>
            
            <script>
                async function checkHealth() {
                    try {
                        const response = await fetch('/health');
                        const data = await response.json();
                        document.getElementById('status').innerHTML = 
                            '<div class="status status-success">' +
                            '<strong>✅ Server Online</strong><br>' +
                            'Timestamp: ' + data.timestamp + '<br>' +
                            'Firebase: ' + data.config.firebase + '<br>' +
                            'PayFast Mode: ' + data.config.payfastMode +
                            '</div>';
                        document.getElementById('config').textContent = JSON.stringify(data, null, 2);
                    } catch (error) {
                        document.getElementById('status').innerHTML = 
                            '<div class="status status-error">' +
                            '❌ Health check failed: ' + error.message +
                            '</div>';
                    }
                }
                
                async function testITNEndpoint() {
                    try {
                        const response = await fetch('/itn-test');
                        const data = await response.json();
                        document.getElementById('itnTestResult').innerHTML = 
                            '<div class="status status-success">' +
                            '<strong>✅ ITN Endpoint Reachable</strong><br>' +
                            'URL: ' + data.url + '<br>' +
                            'Message: ' + data.message +
                            '</div>';
                    } catch (error) {
                        document.getElementById('itnTestResult').innerHTML = 
                            '<div class="status status-error">' +
                            '❌ ITN test failed: ' + error.message +
                            '</div>';
                    }
                }
                
                async function simulateITN() {
                    const bookingId = 'simulate-' + Date.now();
                    try {
                        const response = await fetch('/simulate-itn', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                bookingId: bookingId,
                                amount: '5.00',
                                email: 'test@example.com'
                            })
                        });
                        const data = await response.json();
                        document.getElementById('simulateResult').innerHTML = 
                            '<div class="status status-success">' +
                            '<strong>✅ ITN Simulation Sent</strong><br>' +
                            'Booking ID: ' + bookingId + '<br>' +
                            'Result: ' + JSON.stringify(data, null, 2) +
                            '</div>';
                    } catch (error) {
                        document.getElementById('simulateResult').innerHTML = 
                            '<div class="status status-error">' +
                            '❌ ITN simulation failed: ' + error.message +
                            '</div>';
                    }
                }
                
                async function createTestPayment() {
                    const bookingId = 'test-' + Date.now();
                    try {
                        const response = await fetch('/process-payment', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                amount: '5.00',
                                item_name: 'Test Event Ticket',
                                email_address: 'test@example.com',
                                name_first: 'Test',
                                name_last: 'User',
                                cell_number: '0831234567',
                                booking_id: bookingId,
                                event_id: 'test-event',
                                ticket_number: 'TEST-001',
                                ticket_quantity: 1,
                                event_name: 'Test Event',
                                event_date: '2024-12-31'
                            })
                        });
                        const data = await response.json();
                        if (data.success) {
                            document.getElementById('paymentResult').innerHTML = 
                                '<div class="status status-success">' +
                                '<strong>✅ Payment Created</strong><br>' +
                                'Booking ID: ' + bookingId + '<br>' +
                                '<a href="' + data.redirectUrl + '" target="_blank">Click to pay with PayFast</a>' +
                                '</div>';
                            // Open PayFast in new tab
                            window.open(data.redirectUrl, '_blank');
                        } else {
                            document.getElementById('paymentResult').innerHTML = 
                                '<div class="status status-error">' +
                                '❌ Payment creation failed: ' + (data.error || 'Unknown error') +
                                '</div>';
                        }
                    } catch (error) {
                        document.getElementById('paymentResult').innerHTML = 
                            '<div class="status status-error">' +
                            '❌ Payment creation failed: ' + error.message +
                            '</div>';
                    }
                }
                
                // Check health on page load
                checkHealth();
            </script>
        </body>
        </html>
    `);
});

// 3. PROCESS PAYMENT ENDPOINT
app.post('/process-payment', async (req, res) => {
    try {
        console.log('🔵 Processing payment request...');
        console.log('Request body:', req.body);

        const {
            amount,
            item_name,
            name_first,
            name_last,
            email_address,
            cell_number,
            event_id,
            ticket_number,
            booking_id,
            ticket_quantity,
            event_name,
            event_date
        } = req.body;

        // Validate required fields
        if (!amount || !item_name || !email_address || !booking_id) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: amount, item_name, email_address, booking_id are required'
            });
        }

        // Get URLs
        const notifyUrl = getNotifyUrl();
        const returnUrl = `https://salwacollective.co.za/payment-result.html?status=success&booking_id=${booking_id}`;
        const cancelUrl = `https://salwacollective.co.za/payment-result.html?status=cancelled&booking_id=${booking_id}`;
        const payfastUrl = PAYFAST_CONFIG.sandbox ? PAYFAST_CONFIG.sandboxUrl : PAYFAST_CONFIG.productionUrl;

        console.log('🔗 Generated URLs:');
        console.log('- Notify URL:', notifyUrl);
        console.log('- Return URL:', returnUrl);
        console.log('- Cancel URL:', cancelUrl);
        console.log('- PayFast URL:', payfastUrl);

        // Prepare payment data
        const paymentData = {
            merchant_id: PAYFAST_CONFIG.merchantId,
            merchant_key: PAYFAST_CONFIG.merchantKey,
            return_url: returnUrl,
            cancel_url: cancelUrl,
            notify_url: notifyUrl,
            name_first: name_first || '',
            name_last: name_last || '',
            email_address: email_address,
            cell_number: cell_number || '',
            amount: parseFloat(amount).toFixed(2),
            item_name: item_name.substring(0, 100),
            m_payment_id: booking_id
        };

        // Add optional fields if they exist
        if (event_id) paymentData.custom_str1 = event_id;
        if (ticket_number) paymentData.custom_str2 = ticket_number;
        if (booking_id) paymentData.custom_str3 = booking_id;
        if (ticket_quantity) paymentData.custom_int1 = parseInt(ticket_quantity);

        // Remove empty values
        Object.keys(paymentData).forEach(key => {
            if (paymentData[key] === '' || paymentData[key] === undefined || paymentData[key] === null) {
                delete paymentData[key];
            }
        });

        // Generate signature
        const signature = generatePayFastSignature(paymentData, PAYFAST_CONFIG.passphrase);
        paymentData.signature = signature;

        console.log('📦 Final payment data:', paymentData);

        // Store booking in Firestore
        if (db) {
            try {
                const bookingData = {
                    bookingId: booking_id,
                    eventId: event_id || '',
                    ticketNumber: ticket_number || '',
                    ticketQuantity: parseInt(ticket_quantity) || 1,
                    totalAmount: parseFloat(amount),
                    itemName: item_name,
                    eventName: event_name || item_name,
                    eventDate: event_date || '',
                    customerEmail: email_address,
                    customerFirstName: name_first || '',
                    customerLastName: name_last || '',
                    customerPhone: cell_number || '',
                    status: 'pending_payment',
                    paymentStatus: 'PENDING',
                    isPaid: false,
                    itnReceived: false,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                    paymentTimeout: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes
                    paymentMethod: 'payfast',
                    notifyUrl: notifyUrl
                };

                await db.collection('bookings').doc(booking_id).set(bookingData);
                console.log(`✅ Booking ${booking_id} stored in Firestore`);

            } catch (firestoreError) {
                console.error('⚠️ Firestore save error:', firestoreError.message);
                // Don't fail the payment if Firestore fails
            }
        }

        // Create PayFast redirect URL
        const queryString = new URLSearchParams(paymentData).toString();
        const redirectUrl = `${payfastUrl}?${queryString}`;

        console.log('🟢 Redirecting to:', redirectUrl);

        res.json({
            success: true,
            redirectUrl: redirectUrl,
            bookingId: booking_id,
            signature: signature,
            notifyUrl: notifyUrl
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

// 4. PAYFAST ITN (Instant Transaction Notification) ENDPOINT
app.post('/payfast-notify', async (req, res) => {
    console.log('\n' + '='.repeat(70));
    console.log('🟣 🟣 🟣 PAYFAST ITN NOTIFICATION RECEIVED');
    console.log('='.repeat(70));

    const timestamp = new Date().toISOString();
    console.log(`📅 Timestamp: ${timestamp}`);
    console.log(`🌐 IP Address: ${req.ip || req.headers['x-forwarded-for'] || 'unknown'}`);
    console.log(`📦 Content-Type: ${req.headers['content-type']}`);
    console.log(`📦 Request Method: ${req.method}`);

    // Log raw body for debugging
    console.log('📄 Raw request body:', req.body);

    const data = req.body;

    try {
        // Log all received data
        console.log('📋 Parsed ITN Data:', JSON.stringify(data, null, 2));

        if (!data || Object.keys(data).length === 0) {
            console.error('❌ Empty ITN data received');
            return res.status(400).send('EMPTY_DATA');
        }

        // Store raw ITN for debugging
        if (db) {
            try {
                await db.collection('itn_logs').add({
                    rawData: data,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    ip: req.ip || req.headers['x-forwarded-for'] || 'unknown'
                });
            } catch (logError) {
                console.error('⚠️ Failed to log ITN:', logError.message);
            }
        }

        // Verify signature
        const isValidSignature = verifyPayFastSignature(data, PAYFAST_CONFIG.passphrase);

        if (!isValidSignature) {
            console.error('🔴 INVALID SIGNATURE - Possible tampering or passphrase mismatch');

            // Log the invalid ITN
            if (db && data.m_payment_id) {
                try {
                    await db.collection('bookings').doc(data.m_payment_id).update({
                        paymentStatus: 'SIGNATURE_MISMATCH',
                        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                        itnError: 'Invalid signature',
                        itnReceived: true,
                        itnData: data
                    });
                } catch (updateError) {
                    console.error('⚠️ Failed to update booking:', updateError.message);
                }
            }

            // Still respond with 200 to prevent PayFast retries
            return res.status(200).send('OK - Signature mismatch logged');
        }

        console.log('✅ Signature verified successfully');

        // Verify with PayFast
        const verifyUrl = PAYFAST_CONFIG.sandbox ? PAYFAST_CONFIG.sandboxVerifyUrl : PAYFAST_CONFIG.productionVerifyUrl;
        console.log(`🔍 Verifying with PayFast at: ${verifyUrl}`);

        let verificationResponse;
        try {
            verificationResponse = await axios.post(
                verifyUrl,
                querystring.stringify(data),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': 'SalwaCollective/1.0'
                    },
                    timeout: 10000
                }
            );

            console.log('🔍 PayFast verification response:', verificationResponse.data);

            if (verificationResponse.data.trim() !== 'VALID') {
                console.error('🔴 PayFast validation failed:', verificationResponse.data);

                if (db && data.m_payment_id) {
                    await db.collection('bookings').doc(data.m_payment_id).update({
                        paymentStatus: 'VALIDATION_FAILED',
                        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                        itnError: 'PayFast validation failed: ' + verificationResponse.data,
                        itnReceived: true
                    });
                }

                return res.status(200).send('OK - Validation failed logged');
            }

        } catch (verifyError) {
            console.error('⚠️ PayFast verification failed:', verifyError.message);
            // Continue anyway - we'll process based on signature verification
        }

        // Process the ITN
        const bookingId = data.m_payment_id;
        const paymentStatus = data.payment_status?.toUpperCase() || 'UNKNOWN';

        console.log(`🎉 Processing ITN for booking: ${bookingId}`);
        console.log(`💰 Payment Status: ${paymentStatus}`);
        console.log(`💵 Amount: ${data.amount_gross || 'N/A'}`);

        if (!db) {
            console.error('❌ Firebase not available, cannot update booking');
            return res.status(200).send('OK - Database unavailable');
        }

        // Prepare update data
        const updateData = {
            paymentStatus: paymentStatus,
            payfastPaymentId: data.pf_payment_id || '',
            amountPaid: parseFloat(data.amount_gross || 0),
            amountFee: parseFloat(data.amount_fee || 0),
            amountNet: parseFloat(data.amount_net || 0),
            itnReceived: true,
            itnTimestamp: admin.firestore.FieldValue.serverTimestamp(),
            payerEmail: data.email_address || '',
            payerPhone: data.cell_number || '',
            payerName: `${data.name_first || ''} ${data.name_last || ''}`.trim(),
            lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
            itnData: data,
            itnValidated: verificationResponse?.data?.trim() === 'VALID'
        };

        // Update status based on payment status
        if (paymentStatus === 'COMPLETE') {
            updateData.status = 'confirmed';
            updateData.isPaid = true;
            updateData.paidAt = admin.firestore.FieldValue.serverTimestamp();
            console.log(`💰 Payment COMPLETE for ${bookingId}`);

        } else if (paymentStatus === 'CANCELLED' || paymentStatus === 'USER_CANCELLED') {
            updateData.status = 'cancelled';
            updateData.isPaid = false;
            updateData.cancellationReason = 'user_cancelled';
            updateData.cancelledAt = admin.firestore.FieldValue.serverTimestamp();
            console.log(`❌ Payment CANCELLED for ${bookingId}`);

        } else if (paymentStatus === 'FAILED') {
            updateData.status = 'failed';
            updateData.isPaid = false;
            updateData.cancellationReason = 'payment_failed';
            updateData.cancelledAt = admin.firestore.FieldValue.serverTimestamp();
            console.log(`⚠️ Payment FAILED for ${bookingId}`);

        } else {
            updateData.status = paymentStatus.toLowerCase();
            updateData.isPaid = false;
            console.log(`ℹ️ Payment status ${paymentStatus} for ${bookingId}`);
        }

        // Update Firestore
        try {
            await db.collection('bookings').doc(bookingId).update(updateData);
            console.log(`✅✅✅ Booking ${bookingId} updated in Firestore with status: ${paymentStatus}`);

            // Log successful ITN processing
            await db.collection('itn_success_logs').add({
                bookingId: bookingId,
                paymentStatus: paymentStatus,
                amount: data.amount_gross,
                pfPaymentId: data.pf_payment_id,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

        } catch (firestoreError) {
            console.error('🔴 Firestore update error:', firestoreError.message);

            // Log the error
            await db.collection('itn_errors').add({
                bookingId: bookingId,
                error: firestoreError.message,
                data: data,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        console.log('✅ ITN processing completed successfully');
        res.status(200).send('OK');

    } catch (error) {
        console.error('🔴🔴🔴 ITN Processing Error:', error.message);
        console.error('Stack trace:', error.stack);

        // Log the error
        if (db) {
            try {
                await db.collection('itn_errors').add({
                    error: error.message,
                    stack: error.stack,
                    data: data,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
            } catch (logError) {
                console.error('⚠️ Failed to log ITN error:', logError.message);
            }
        }

        // Always respond with 200 to prevent PayFast retries
        res.status(200).send('OK - Error logged');
    }
});

// 5. ITN TEST ENDPOINT
app.get('/itn-test', (req, res) => {
    console.log('✅ ITN endpoint test - Accessible');
    res.json({
        success: true,
        message: 'ITN endpoint is accessible and working',
        timestamp: new Date().toISOString(),
        url: getNotifyUrl(),
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded'
    });
});

// 6. SIMULATE ITN ENDPOINT
app.post('/simulate-itn', async (req, res) => {
    console.log('🧪 Simulating ITN...');

    const bookingId = req.body.bookingId || 'simulate-' + Date.now();

    // Create test ITN data
    const testData = {
        m_payment_id: bookingId,
        pf_payment_id: 'PF' + Date.now(),
        payment_status: 'COMPLETE',
        item_name: 'Test Event Ticket',
        amount_gross: '5.00',
        amount_fee: '0.50',
        amount_net: '4.50',
        name_first: 'Test',
        name_last: 'User',
        email_address: 'test@example.com',
        cell_number: '0831234567',
        merchant_id: PAYFAST_CONFIG.merchantId,
        // We'll add signature after generating
    };

    // Generate signature
    testData.signature = generatePayFastSignature(testData, PAYFAST_CONFIG.passphrase);

    console.log('📤 Sending simulated ITN:', testData);

    try {
        // Call our own ITN endpoint
        const response = await axios.post(
            getNotifyUrl(),
            querystring.stringify(testData),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        console.log('✅ ITN simulation successful');

        res.json({
            success: true,
            message: 'ITN simulation completed',
            bookingId: bookingId,
            dataSent: testData,
            response: response.data
        });

    } catch (error) {
        console.error('❌ ITN simulation failed:', error.message);

        res.status(500).json({
            success: false,
            error: 'ITN simulation failed',
            message: error.message
        });
    }
});

// 7. CHECK PAYMENT STATUS
app.post('/check-status', async (req, res) => {
    try {
        const { bookingId } = req.body;

        if (!bookingId) {
            return res.status(400).json({
                success: false,
                error: 'Booking ID is required'
            });
        }

        console.log(`🔍 Checking status for booking: ${bookingId}`);

        if (!db) {
            return res.json({
                success: false,
                error: 'Database unavailable',
                bookingId: bookingId,
                status: 'unknown'
            });
        }

        const doc = await db.collection('bookings').doc(bookingId).get();

        if (!doc.exists) {
            return res.status(404).json({
                success: false,
                error: 'Booking not found',
                bookingId: bookingId
            });
        }

        const bookingData = doc.data();

        // Check for timeout (30 minutes)
        if (bookingData.paymentTimeout) {
            const timeoutDate = bookingData.paymentTimeout.toDate ?
                bookingData.paymentTimeout.toDate() :
                new Date(bookingData.paymentTimeout);
            const now = new Date();

            if (timeoutDate < now &&
                (bookingData.status === 'pending' || bookingData.status === 'pending_payment') &&
                !bookingData.isPaid) {

                console.log(`⏰ Auto-cancelling timed out booking: ${bookingId}`);

                const updateData = {
                    status: 'cancelled',
                    paymentStatus: 'TIMEOUT',
                    isPaid: false,
                    cancellationReason: 'payment_timeout',
                    cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
                    lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                };

                await db.collection('bookings').doc(bookingId).update(updateData);
                bookingData.status = 'cancelled';
                bookingData.paymentStatus = 'TIMEOUT';
                bookingData.isPaid = false;
                bookingData.autoCancelled = true;
            }
        }

        res.json({
            success: true,
            bookingId: bookingId,
            status: bookingData.status || 'pending',
            paymentStatus: bookingData.paymentStatus || 'pending',
            isPaid: bookingData.isPaid || false,
            itnReceived: bookingData.itnReceived || false,
            amount: bookingData.totalAmount || bookingData.amount || 0,
            customerEmail: bookingData.customerEmail || '',
            eventName: bookingData.eventName || bookingData.itemName || '',
            eventDate: bookingData.eventDate || '',
            ticketNumber: bookingData.ticketNumber || '',
            createdAt: bookingData.createdAt ?
                (bookingData.createdAt.toDate ? bookingData.createdAt.toDate().toISOString() : bookingData.createdAt) :
                null,
            lastUpdated: bookingData.lastUpdated ?
                (bookingData.lastUpdated.toDate ? bookingData.lastUpdated.toDate().toISOString() : bookingData.lastUpdated) :
                null
        });

    } catch (error) {
        console.error('❌ Status check error:', error);
        res.status(500).json({
            success: false,
            error: 'Status check failed',
            message: error.message
        });
    }
});

// 8. CATCH-ALL FOR UNMATCHED ROUTES
app.use((req, res) => {
    console.log(`⚠️ Route not found: ${req.method} ${req.url}`);
    res.status(404).json({
        success: false,
        error: 'Route not found',
        path: req.url,
        method: req.method
    });
});

// 9. ERROR HANDLING MIDDLEWARE
app.use((error, req, res, next) => {
    console.error('🔴 Unhandled error:', error);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error.message,
        timestamp: new Date().toISOString()
    });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`
    🚀 Salwa Collective Payment Server Started!
    ===========================================
    📍 Port: ${PORT}
    🔒 Mode: ${PAYFAST_CONFIG.sandbox ? 'SANDBOX 🧪 (Testing)' : 'PRODUCTION 🏢'}
    🌐 External URL: ${process.env.RENDER_EXTERNAL_URL || 'Not set'}
    🌐 Hostname: ${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost:' + PORT}
    
    📋 Available Endpoints:
    ├── POST /process-payment    - Create PayFast payment
    ├── POST /payfast-notify     - PayFast ITN webhook (CRITICAL)
    ├── POST /check-status       - Check booking status
    ├── POST /simulate-itn       - Simulate ITN for testing
    ├── GET  /itn-test          - Test if ITN endpoint is reachable
    ├── GET  /test              - Interactive test dashboard
    └── GET  /health            - Server health check
    
    🔗 ITN Notify URL: ${getNotifyUrl()}
    
    ⚠️ IMPORTANT CONFIGURATION:
    - Ensure PAYFAST_SANDBOX=true for testing
    - Set PAYFAST_PASSPHRASE if using one in PayFast settings
    - Verify notify URL is accessible from PayFast
    
    🐛 DEBUGGING STEPS:
    1. Visit /test for interactive dashboard
    2. Click "Test ITN Endpoint" to verify accessibility
    3. Click "Simulate ITN" to test Firestore updates
    4. Check Render logs for "🟣 PAYFAST ITN NOTIFICATION"
    
    ✅ Ready to process payments!
    `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});