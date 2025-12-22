const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios');
const querystring = require('querystring');
const crypto = require('crypto');
const cors = require('cors');
const app = express();

// ===== CONFIGURATION =====
const CONFIG = {
    port: process.env.PORT || 3000,
    payfast: {
        merchantId: process.env.PAYFAST_MERCHANT_ID || '10000100',
        merchantKey: process.env.PAYFAST_MERCHANT_KEY || '46f0cd694581a',
        passphrase: process.env.PAYFAST_PASSPHRASE || '',
        sandbox: process.env.PAYFAST_SANDBOX !== 'false',
        processUrl: {
            live: "https://www.payfast.co.za/eng/process",
            sandbox: "https://sandbox.payfast.co.za/eng/process"
        },
        validateUrl: {
            live: "https://www.payfast.co.za/eng/query/validate",
            sandbox: "https://sandbox.payfast.co.za/eng/query/validate"
        }
    },
    allowedOrigins: process.env.ALLOWED_ORIGINS ?
        process.env.ALLOWED_ORIGINS.split(',') : [
            'https://salwacollective.co.za',
            'https://www.salwacollective.co.za',
            'http://localhost:3000',
            'http://localhost:5173',
            'http://localhost:8080'
        ]
};

// ===== SIMPLE CORS CONFIG =====
const corsConfig = {
    origin: function (origin, callback) {
        if (!origin || CONFIG.allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('CORS not allowed'));
        }
    },
    credentials: true
};

// ===== SIMPLE FIREBASE SETUP =====
let firestore = null;
if (process.env.FIREBASE_KEY) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        firestore = admin.firestore();
        console.log('✓ Firebase connected');
    } catch (error) {
        console.log('✗ Firebase error:', error.message);
    }
}

// ===== SIMPLE SIGNATURE UTILITIES =====
class PayFastSignature {
    static create(data, passphrase = '') {
        // Remove signature and merchant_key from hash
        const hashData = { ...data };
        delete hashData.signature;
        delete hashData.merchant_key;

        // Sort keys alphabetically
        const sortedKeys = Object.keys(hashData).sort();

        // Build string for hashing
        let hashString = '';
        for (const key of sortedKeys) {
            const value = hashData[key];
            if (value !== undefined && value !== null && value !== '') {
                hashString += `${key}=${encodeURIComponent(value.toString().trim())}&`;
            }
        }

        // Remove trailing &
        hashString = hashString.slice(0, -1);

        // Add passphrase if provided
        if (passphrase && passphrase.trim() !== '') {
            hashString += `&passphrase=${encodeURIComponent(passphrase.trim())}`;
        }

        return crypto.createHash('md5').update(hashString).digest('hex');
    }

    static verifyITN(data, passphrase = '') {
        const submittedSignature = data.signature;
        if (!submittedSignature) return false;

        // Clone and remove signature
        const checkData = { ...data };
        delete checkData.signature;

        // Sort keys
        const sortedKeys = Object.keys(checkData).sort();

        // Build hash string using raw values (PayFast sends them encoded)
        let hashString = '';
        for (const key of sortedKeys) {
            const value = checkData[key];
            if (value !== undefined && value !== null && value !== '') {
                hashString += `${key}=${value}&`;
            }
        }

        hashString = hashString.slice(0, -1);

        if (passphrase && passphrase.trim() !== '') {
            hashString += `&passphrase=${encodeURIComponent(passphrase.trim())}`;
        }

        const calculated = crypto.createHash('md5').update(hashString).digest('hex');
        return calculated === submittedSignature;
    }
}

// ===== NOTIFY URL =====
function getNotifyUrl() {
    const externalUrl = process.env.RENDER_EXTERNAL_URL;
    const hostname = process.env.RENDER_EXTERNAL_HOSTNAME;

    if (externalUrl) return `${externalUrl}/payfast-notify`;
    if (hostname) return `https://${hostname}/payfast-notify`;
    return 'https://payfast-itn.onrender.com/payfast-notify';
}

// ===== MIDDLEWARE - ITN FIRST =====
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// ===== PAYFAST ITN WEBHOOK =====
app.post('/payfast-notify', async (req, res) => {
    console.log('📨 ITN Received:', Object.keys(req.body).length, 'parameters');

    const data = req.body;
    let responseSent = false;

    try {
        // 1. Verify signature locally
        const validSignature = PayFastSignature.verifyITN(data, CONFIG.payfast.passphrase);

        if (!validSignature) {
            console.log('✗ Invalid signature');
            await logToFirestore('itn_errors', {
                type: 'signature_mismatch',
                data: data,
                time: new Date().toISOString()
            });
            return res.status(200).send('OK');
        }
        console.log('✓ Signature verified');

        // 2. Validate with PayFast server
        const validateUrl = CONFIG.payfast.sandbox ?
            CONFIG.payfast.validateUrl.sandbox :
            CONFIG.payfast.validateUrl.live;

        try {
            const validation = await axios.post(validateUrl, querystring.stringify(data), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 10000
            });

            if (validation.data.trim() !== 'VALID') {
                console.log('✗ PayFast validation failed:', validation.data);
                await logToFirestore('itn_errors', {
                    type: 'payfast_invalid',
                    response: validation.data,
                    data: data
                });
                return res.status(200).send('OK');
            }
            console.log('✓ PayFast validation passed');
        } catch (error) {
            console.log('⚠️ Validation error:', error.message);
        }

        // 3. Process the ITN
        const bookingId = data.m_payment_id;
        const status = data.payment_status?.toUpperCase() || 'UNKNOWN';
        const amount = parseFloat(data.amount_gross) || 0;

        // Validate merchant ID
        if (data.merchant_id !== CONFIG.payfast.merchantId) {
            console.log('✗ Merchant ID mismatch');
            return res.status(200).send('OK');
        }

        // Update/create booking in Firestore
        if (firestore) {
            const bookingRef = firestore.collection('bookings').doc(bookingId);
            const exists = (await bookingRef.get()).exists;

            const bookingData = {
                paymentStatus: status,
                amountPaid: amount,
                itnReceived: true,
                payfastId: data.pf_payment_id || '',
                lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                itnData: data
            };

            if (status === 'COMPLETE') {
                bookingData.status = 'confirmed';
                bookingData.isPaid = true;
                bookingData.paymentDate = admin.firestore.FieldValue.serverTimestamp();
            } else if (status === 'CANCELLED' || status === 'FAILED') {
                bookingData.status = 'failed';
                bookingData.isPaid = false;
            }

            if (exists) {
                await bookingRef.update(bookingData);
                console.log(`✓ Updated booking ${bookingId}`);
            } else {
                // Create new booking
                await bookingRef.set({
                    bookingId: bookingId,
                    status: status === 'COMPLETE' ? 'confirmed' : 'pending',
                    totalAmount: amount,
                    customerEmail: data.email_address || '',
                    customerName: `${data.name_first || ''} ${data.name_last || ''}`.trim(),
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    ...bookingData
                });
                console.log(`✓ Created booking ${bookingId}`);
            }

            // Log successful ITN
            await logToFirestore('itn_logs', {
                bookingId: bookingId,
                status: status,
                amount: amount,
                time: new Date().toISOString()
            });
        }

        console.log('✓ ITN processing complete');
        res.status(200).send('OK');

    } catch (error) {
        console.error('💥 ITN Error:', error.message);
        if (!responseSent) {
            res.status(200).send('OK');
        }
    }
});

// ===== APPLY CORS TO OTHER ROUTES =====
app.use(cors(corsConfig));
app.options('*', cors(corsConfig));

// ===== HELPER FUNCTION =====
async function logToFirestore(collection, data) {
    if (!firestore) return;
    try {
        await firestore.collection(collection).add({
            ...data,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (error) {
        console.log('Log error:', error.message);
    }
}

// ===== CREATE PAYMENT =====
app.post('/process-payment', async (req, res) => {
    try {
        const { amount, item_name, email_address, booking_id, name_first, name_last } = req.body;

        // Validation
        if (!amount || !email_address || !booking_id) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const cleanAmount = parseFloat(amount);
        if (isNaN(cleanAmount) || cleanAmount <= 0) {
            return res.status(400).json({ error: 'Invalid amount' });
        }

        // Prepare PayFast data
        const payfastData = {
            merchant_id: CONFIG.payfast.merchantId,
            merchant_key: CONFIG.payfast.merchantKey,
            return_url: 'https://salwacollective.co.za/payment-result.html',
            cancel_url: 'https://salwacollective.co.za/payment-result.html?cancelled=true',
            notify_url: getNotifyUrl(),
            name_first: (name_first || '').trim(),
            name_last: (name_last || '').trim(),
            email_address: email_address.trim(),
            amount: cleanAmount.toFixed(2),
            item_name: (item_name || 'Event Ticket').trim(),
            m_payment_id: booking_id.trim()
        };

        // Generate signature
        const signature = PayFastSignature.create(
            payfastData,
            CONFIG.payfast.sandbox ? '' : CONFIG.payfast.passphrase
        );
        payfastData.signature = signature;

        // Store in Firestore
        if (firestore) {
            await firestore.collection('bookings').doc(booking_id).set({
                bookingId: booking_id,
                status: 'pending_payment',
                totalAmount: cleanAmount,
                customerEmail: email_address,
                customerName: `${name_first || ''} ${name_last || ''}`.trim(),
                paymentData: payfastData,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                paymentTimeout: new Date(Date.now() + 30 * 60 * 1000)
            });
        }

        // Generate PayFast URL
        const payfastUrl = CONFIG.payfast.sandbox ?
            CONFIG.payfast.processUrl.sandbox :
            CONFIG.payfast.processUrl.live;

        const queryString = new URLSearchParams(payfastData).toString();
        const redirectUrl = `${payfastUrl}?${queryString}`;

        res.json({
            success: true,
            redirectUrl: redirectUrl,
            bookingId: booking_id,
            signature: signature
        });

    } catch (error) {
        console.error('Payment error:', error);
        res.status(500).json({ error: 'Payment processing failed' });
    }
});

// ===== CHECK STATUS =====
app.post('/check-status', async (req, res) => {
    try {
        const { bookingId } = req.body;
        if (!bookingId) {
            return res.status(400).json({ error: 'Booking ID required' });
        }

        if (!firestore) {
            return res.json({ status: 'no_database', bookingId });
        }

        const doc = await firestore.collection('bookings').doc(bookingId).get();

        if (!doc.exists) {
            return res.json({ status: 'not_found', bookingId });
        }

        const data = doc.data();
        res.json({
            status: data.status || 'pending',
            paymentStatus: data.paymentStatus || 'unknown',
            isPaid: data.isPaid || false,
            amount: data.totalAmount || 0,
            email: data.customerEmail || '',
            itnReceived: data.itnReceived || false
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===== SIMULATE ITN =====
app.post('/simulate-itn', async (req, res) => {
    try {
        const bookingId = req.body.bookingId || `test-${Date.now()}`;

        // Create test data
        const testData = {
            m_payment_id: bookingId,
            pf_payment_id: `PF${Date.now()}`,
            payment_status: 'COMPLETE',
            item_name: 'Test Event',
            amount_gross: '5.00',
            name_first: 'Test',
            name_last: 'User',
            email_address: 'test@example.com',
            merchant_id: CONFIG.payfast.merchantId
        };

        // Generate signature for ITN (using raw values approach)
        const signature = PayFastSignature.create(testData, CONFIG.payfast.passphrase);
        testData.signature = signature;

        // Call our own ITN endpoint
        const response = await axios.post(
            `http://localhost:${CONFIG.port}/payfast-notify`,
            querystring.stringify(testData),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        res.json({
            success: true,
            bookingId: bookingId,
            signature: signature,
            response: response.data
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===== HEALTH CHECK =====
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        mode: CONFIG.payfast.sandbox ? 'sandbox' : 'production',
        firebase: firestore ? 'connected' : 'disconnected'
    });
});

// ===== TEST PAGE =====
app.get('/test', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>PayFast Test</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; }
                button { padding: 10px 15px; margin: 5px; background: #007bff; color: white; border: none; border-radius: 5px; cursor: pointer; }
                button:hover { background: #0056b3; }
                .result { background: #f8f9fa; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #28a745; }
                .error { border-left-color: #dc3545; }
            </style>
        </head>
        <body>
            <h1>PayFast Integration Test</h1>
            <button onclick="testPayment()">Test Payment</button>
            <button onclick="simulateITN()">Simulate ITN</button>
            <button onclick="checkHealth()">Health Check</button>
            <div id="result"></div>
            <script>
                async function testPayment() {
                    show('Creating payment...');
                    const res = await fetch('/process-payment', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            amount: '5.00',
                            item_name: 'Test Ticket',
                            email_address: 'test@example.com',
                            booking_id: 'test-' + Date.now(),
                            name_first: 'John',
                            name_last: 'Doe'
                        })
                    });
                    const data = await res.json();
                    if (data.success) {
                        show('Payment created! Redirecting...');
                        window.open(data.redirectUrl, '_blank');
                    } else {
                        show('Error: ' + (data.error || 'Unknown'), true);
                    }
                }
                
                async function simulateITN() {
                    show('Simulating ITN...');
                    const res = await fetch('/simulate-itn', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ bookingId: 'simulate-' + Date.now() })
                    });
                    const data = await res.json();
                    show('ITN simulated: ' + (data.success ? 'Success' : 'Failed'));
                }
                
                async function checkHealth() {
                    show('Checking health...');
                    const res = await fetch('/health');
                    const data = await res.json();
                    show('Status: ' + data.status + ' | Mode: ' + data.mode);
                }
                
                function show(message, isError = false) {
                    const div = document.getElementById('result');
                    div.innerHTML = '<div class="result' + (isError ? ' error' : '') + '">' + message + '</div>';
                }
            </script>
        </body>
        </html>
    `);
});

// ===== ROOT =====
app.get('/', (req, res) => {
    res.json({
        service: 'PayFast Integration Server',
        endpoints: {
            'POST /process-payment': 'Create payment',
            'POST /payfast-notify': 'PayFast ITN (no CORS)',
            'POST /check-status': 'Check booking status',
            'POST /simulate-itn': 'Simulate ITN',
            'GET /health': 'Health check',
            'GET /test': 'Test page'
        },
        config: {
            mode: CONFIG.payfast.sandbox ? 'sandbox' : 'production',
            merchantId: CONFIG.payfast.merchantId,
            notifyUrl: getNotifyUrl()
        }
    });
});

// ===== ERROR HANDLER =====
app.use((err, req, res, next) => {
    console.error('Server error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
});

// ===== START SERVER =====
app.listen(CONFIG.port, () => {
    console.log(`
🚀 Server running on port ${CONFIG.port}
📧 ITN URL: ${getNotifyUrl()}
🔐 Mode: ${CONFIG.payfast.sandbox ? 'SANDBOX' : 'PRODUCTION'}
    
Key Features:
✓ ITN webhook with signature verification
✓ Payment creation with correct signature
✓ Firebase integration
✓ Simple and reliable
    
Ready for PayFast integration!
    `);
});