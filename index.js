const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios');
const querystring = require('querystring');
const crypto = require('crypto');
const cors = require('cors');

const app = express();

// ===== MIDDLEWARE SETUP =====
// Get allowed origins from environment variable or use default
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : [
        'https://salwacollective.co.za',
        'https://www.salwacollective.co.za',
        'http://localhost:3000',
        'http://localhost:5173', // Vite dev server
        'http://localhost:8080'
    ];

console.log('🌐 Allowed CORS origins:', ALLOWED_ORIGINS);

const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps, curl, postman, server-to-server)
        if (!origin) return callback(null, true);

        // Check if the origin is in the allowed list
        if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.warn(`❌ CORS blocked origin: ${origin}`);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true, // Allow credentials
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'X-CSRF-Token'],
    exposedHeaders: ['Content-Range', 'X-Content-Range'],
    maxAge: 86400 // 24 hours
};

app.use(cors(corsOptions));

// Handle preflight requests
app.options('*', cors(corsOptions));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - Origin: ${req.headers.origin || 'none'}`);
    next();
});

// ===== ITN ROOT URL FIX MIDDLEWARE =====
// This middleware fixes the issue where PayFast sends ITN to root URL instead of /payfast-notify
app.use((req, res, next) => {
    // Check if it's a POST to root with ITN data
    if (req.method === 'POST' && req.path === '/' &&
        req.headers['content-type']?.includes('application/x-www-form-urlencoded') &&
        req.body.payment_status && req.body.m_payment_id) {

        console.log(`🔄 Redirecting root ITN to /payfast-notify (booking: ${req.body.m_payment_id})`);

        // Change the path so it hits your ITN handler
        req.url = '/payfast-notify';
        req.path = '/payfast-notify';
        req.originalUrl = '/payfast-notify';
    }
    next();
});

// ===== FIREBASE INITIALIZATION =====
let db = null;
try {
    if (!process.env.FIREBASE_KEY) {
        console.log('⚠️ FIREBASE_KEY environment variable not set');
    } else {
        const firebaseConfig = JSON.parse(process.env.FIREBASE_KEY);

        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(firebaseConfig)
            });
            console.log('✅ Firebase Admin SDK initialized successfully');
        }

        db = admin.firestore();
        console.log('✅ Firestore database connected');
    }
} catch (error) {
    console.error('❌ Firebase initialization error:', error.message);
    db = null;
}

// ===== PAYFAST CONFIGURATION =====
const PAYFAST_CONFIG = {
    merchantId: process.env.PAYFAST_MERCHANT_ID || '10000100',
    merchantKey: process.env.PAYFAST_MERCHANT_KEY || '46f0cd694581a',
    passphrase: process.env.PAYFAST_PASSPHRASE || '',
    sandbox: process.env.PAYFAST_SANDBOX !== 'false',

    productionUrl: "https://www.payfast.co.za/eng/process",
    sandboxUrl: "https://sandbox.payfast.co.za/eng/process",

    productionVerifyUrl: "https://www.payfast.co.za/eng/query/validate",
    sandboxVerifyUrl: "https://sandbox.payfast.co.za/eng/query/validate"
};

console.log('='.repeat(60));
console.log('⚙️  PAYFAST CONFIGURATION:');
console.log('='.repeat(60));
console.log('Merchant ID:', PAYFAST_CONFIG.merchantId);
console.log('Sandbox Mode:', PAYFAST_CONFIG.sandbox ? '✅ YES' : '❌ NO');
console.log('Passphrase:', PAYFAST_CONFIG.passphrase ? '✅ Set' : '❌ Not Set');
console.log('Firebase:', db ? '✅ Connected' : '❌ Disconnected');
console.log('CORS Origins:', ALLOWED_ORIGINS.length);
console.log('='.repeat(60));

// ===== HELPER FUNCTIONS =====
function generatePayFastSignature(data, passPhrase = null) {
    const signatureData = { ...data };
    delete signatureData.signature;

    const sortedKeys = Object.keys(signatureData).sort();
    let pfOutput = '';

    for (let key of sortedKeys) {
        if (signatureData[key] !== undefined && signatureData[key] !== null && signatureData[key] !== '') {
            pfOutput += `${key}=${encodeURIComponent(signatureData[key].toString()).replace(/%20/g, '+')}&`;
        }
    }

    pfOutput = pfOutput.slice(0, -1);

    if (passPhrase && passPhrase.trim() !== '') {
        pfOutput += `&passphrase=${encodeURIComponent(passPhrase.trim()).replace(/%20/g, '+')}`;
    }

    return crypto.createHash('md5').update(pfOutput).digest('hex');
}

function verifyPayFastSignature(data, passphrase = '') {
    const submittedSignature = data.signature;
    if (!submittedSignature) {
        return false;
    }

    const signatureData = { ...data };
    delete signatureData.signature;

    const sortedKeys = Object.keys(signatureData).sort();
    let pfParamString = '';

    for (const key of sortedKeys) {
        if (signatureData[key] !== undefined && signatureData[key] !== null && signatureData[key] !== '') {
            pfParamString += `${key}=${encodeURIComponent(signatureData[key].toString()).replace(/%20/g, '+')}&`;
        }
    }

    pfParamString = pfParamString.slice(0, -1);

    if (passphrase && passphrase.trim() !== '') {
        pfParamString += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, '+')}`;
    }

    const calculatedSignature = crypto.createHash('md5').update(pfParamString).digest('hex');
    return calculatedSignature === submittedSignature;
}

function getNotifyUrl() {
    const renderUrl = process.env.RENDER_EXTERNAL_URL;
    const renderHostname = process.env.RENDER_EXTERNAL_HOSTNAME;

    let baseUrl;

    if (renderUrl) {
        baseUrl = renderUrl;
    } else if (renderHostname) {
        baseUrl = `https://${renderHostname}`;
    } else {
        baseUrl = 'https://payfast-itn.onrender.com';
    }

    return `${baseUrl}/payfast-notify`;
}

// ===== ROUTES =====

// 1. ROOT ENDPOINT
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Salwa Collective Payment Server</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; max-width: 1200px; margin: 0 auto; }
                .endpoint { background: #f5f5f5; padding: 10px; margin: 5px 0; border-radius: 5px; }
                .btn { background: #4CAF50; color: white; padding: 10px 20px; margin: 10px 5px; text-decoration: none; display: inline-block; border-radius: 5px; border: none; cursor: pointer; }
                .btn:hover { background: #45a049; }
                .info-box { background: #e7f3fe; border-left: 6px solid #2196F3; padding: 15px; margin: 20px 0; }
                .cors-info { background: #fff3cd; border-left: 6px solid #ffc107; padding: 15px; margin: 20px 0; }
                .itn-fix { background: #d4edda; border-left: 6px solid #28a745; padding: 15px; margin: 20px 0; }
            </style>
        </head>
        <body>
            <h1>🎫 Salwa Collective Payment Server</h1>
            <div class="info-box">
                <strong>Server Status:</strong> 🟢 Online<br>
                <strong>Mode:</strong> ${PAYFAST_CONFIG.sandbox ? 'Sandbox' : 'Production'}<br>
                <strong>CORS Enabled:</strong> Yes (${ALLOWED_ORIGINS.length} allowed origins)<br>
                <strong>Firebase:</strong> ${db ? 'Connected' : 'Disconnected'}
            </div>
            
            <div class="itn-fix">
                <strong>🔄 ITN URL FIX ACTIVE:</strong><br>
                • ITN requests to root (/) will be automatically redirected to /payfast-notify<br>
                • PayFast can use: https://payfast-itn.onrender.com OR https://payfast-itn.onrender.com/payfast-notify<br>
                • Both URLs will work correctly
            </div>
            
            <div class="cors-info">
                <strong>CORS Configuration:</strong><br>
                Credentials allowed: Yes<br>
                Allowed Origins: ${ALLOWED_ORIGINS.map(origin => `<br>• ${origin}`).join('')}
            </div>
            
            <h2>Quick Links:</h2>
            <p><a class="btn" href="/test">🧪 Test Dashboard</a></p>
            <p><a class="btn" href="/health">🩺 Health Check</a></p>
            <p><a class="btn" href="/itn-test">🔗 Test ITN Endpoint</a></p>
            <p><a class="btn" href="/test-root-itn">🧪 Test Root ITN Fix</a></p>
            
            <h2>API Endpoints:</h2>
            <div class="endpoint"><strong>POST /process-payment</strong> - Create new payment</div>
            <div class="endpoint"><strong>POST /payfast-notify</strong> - PayFast ITN webhook</div>
            <div class="endpoint"><strong>POST /check-status</strong> - Check booking status</div>
            <div class="endpoint"><strong>POST /simulate-itn</strong> - Simulate ITN for testing</div>
            <div class="endpoint"><strong>POST / (with ITN data)</strong> - Auto-redirects to /payfast-notify ✅</div>
        </body>
        </html>
    `);
});

// 2. HEALTH CHECK
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        mode: PAYFAST_CONFIG.sandbox ? 'sandbox' : 'production',
        firebase: db ? 'connected' : 'disconnected',
        cors: {
            enabled: true,
            credentialsAllowed: true,
            allowedOriginsCount: ALLOWED_ORIGINS.length
        },
        itnFix: {
            enabled: true,
            description: 'Root URL ITN requests automatically redirected to /payfast-notify'
        }
    });
});

// 3. TEST DASHBOARD
app.get('/test', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>PayFast Test Dashboard</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; max-width: 1200px; margin: 0 auto; }
                button { padding: 10px 20px; margin: 10px; background: #4CAF50; color: white; border: none; border-radius: 5px; cursor: pointer; }
                button:hover { background: #45a049; }
                .result { background: #f5f5f5; padding: 15px; margin: 15px 0; border-radius: 5px; border-left: 4px solid #4CAF50; white-space: pre-wrap; }
                .error { border-left-color: #f44336; }
                .success { border-left-color: #4CAF50; }
                .info { background: #e7f3fe; padding: 15px; margin: 15px 0; border-radius: 5px; border-left: 4px solid #2196F3; }
            </style>
        </head>
        <body>
            <h1>🧪 PayFast Test Dashboard</h1>
            
            <div class="info">
                <strong>Current Configuration:</strong><br>
                Mode: ${PAYFAST_CONFIG.sandbox ? 'Sandbox' : 'Production'}<br>
                ITN URL: ${getNotifyUrl()}<br>
                CORS: Enabled (credentials allowed)<br>
                <strong>ITN Fix:</strong> ✅ Active (root URL → /payfast-notify)
            </div>
            
            <div>
                <button onclick="testITN()">🔗 Test ITN Endpoint</button>
                <button onclick="simulateITN()">🔄 Simulate ITN</button>
                <button onclick="createTestPayment()">💳 Create Test Payment</button>
                <button onclick="testCORS()">🌐 Test CORS</button>
                <button onclick="testRootITN()">📤 Test Root ITN Fix</button>
            </div>
            
            <div id="result"></div>
            
            <script>
                async function testITN() {
                    showLoading('Testing ITN endpoint...');
                    try {
                        const res = await fetch('/itn-test');
                        const data = await res.json();
                        showResult('✅ ITN Test:', data, true);
                    } catch (error) {
                        showResult('❌ Error:', error, false);
                    }
                }
                
                async function simulateITN() {
                    const bookingId = 'simulate-' + Date.now();
                    showLoading('Simulating ITN...');
                    try {
                        // First create the booking in Firestore
                        await fetch('/create-test-booking', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ bookingId: bookingId })
                        });
                        
                        // Then simulate ITN
                        const res = await fetch('/simulate-itn', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ bookingId: bookingId })
                        });
                        const data = await res.json();
                        showResult('✅ ITN Simulated:', data, true);
                    } catch (error) {
                        showResult('❌ Error:', error, false);
                    }
                }
                
                async function createTestPayment() {
                    const bookingId = 'test-' + Date.now();
                    showLoading('Creating payment...');
                    try {
                        const res = await fetch('/process-payment', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                amount: '5.00',
                                item_name: 'Test Event Ticket',
                                email_address: 'test@example.com',
                                booking_id: bookingId,
                                name_first: 'Test',
                                name_last: 'User'
                            })
                        });
                        const data = await res.json();
                        if (data.success) {
                            window.open(data.redirectUrl, '_blank');
                            showResult('✅ Payment Created:', {
                                message: 'Payment link generated successfully!',
                                bookingId: bookingId,
                                redirectUrl: data.redirectUrl,
                                paymentLink: '<a href="' + data.redirectUrl + '" target="_blank">Click here to proceed to payment</a>'
                            }, true);
                        } else {
                            showResult('❌ Payment Failed:', data, false);
                        }
                    } catch (error) {
                        showResult('❌ Error:', error, false);
                    }
                }
                
                async function testCORS() {
                    showLoading('Testing CORS configuration...');
                    try {
                        // Test with credentials
                        const res = await fetch('/health', {
                            credentials: 'include'
                        });
                        const data = await res.json();
                        showResult('✅ CORS Test with credentials:', {
                            status: 'CORS with credentials is working!',
                            origin: window.location.origin,
                            response: data
                        }, true);
                    } catch (error) {
                        showResult('❌ CORS Error:', error, false);
                    }
                }
                
                async function testRootITN() {
                    showLoading('Testing Root ITN Fix...');
                    try {
                        const bookingId = 'root-test-' + Date.now();
                        
                        // First create a test booking
                        await fetch('/create-test-booking', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ bookingId: bookingId })
                        });
                        
                        // Test sending ITN to root URL
                        const formData = new URLSearchParams();
                        formData.append('m_payment_id', bookingId);
                        formData.append('pf_payment_id', 'PF' + Date.now());
                        formData.append('payment_status', 'COMPLETE');
                        formData.append('item_name', 'Root ITN Test');
                        formData.append('amount_gross', '5.00');
                        formData.append('name_first', 'Root');
                        formData.append('name_last', 'Test');
                        formData.append('email_address', 'root@test.com');
                        
                        const res = await fetch('/', {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/x-www-form-urlencoded'
                            },
                            body: formData
                        });
                        
                        const text = await res.text();
                        showResult('✅ Root ITN Test:', {
                            message: 'ITN sent to root URL successfully',
                            bookingId: bookingId,
                            response: text === 'OK' ? '✅ ITN processed successfully' : text,
                            note: 'Check Firebase to see if booking was updated'
                        }, true);
                        
                    } catch (error) {
                        showResult('❌ Root ITN Error:', error, false);
                    }
                }
                
                function showLoading(message) {
                    document.getElementById('result').innerHTML = 
                        '<div class="result">⏳ ' + message + '</div>';
                }
                
                function showResult(title, data, isSuccess) {
                    const resultDiv = document.getElementById('result');
                    const className = isSuccess ? 'success' : 'error';
                    resultDiv.innerHTML = 
                        '<div class="result ' + className + '"><strong>' + title + '</strong><br>' + 
                        JSON.stringify(data, null, 2) + '</div>';
                }
            </script>
        </body>
        </html>
    `);
});

// 4. CREATE TEST BOOKING
app.post('/create-test-booking', async (req, res) => {
    try {
        const { bookingId } = req.body;

        if (!db) {
            return res.json({ success: false, error: 'Firebase not connected' });
        }

        const bookingData = {
            bookingId: bookingId,
            status: 'pending',
            amount: '5.00',
            email: 'test@example.com',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            itnReceived: false,
            testBooking: true
        };

        await db.collection('bookings').doc(bookingId).set(bookingData);

        res.json({ success: true, message: 'Test booking created', bookingId: bookingId });

    } catch (error) {
        console.error('Create test booking error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 5. ITN TEST ENDPOINT
app.get('/itn-test', (req, res) => {
    res.json({
        success: true,
        message: 'ITN endpoint is accessible',
        url: getNotifyUrl(),
        rootFix: '✅ Active - ITN requests to root (/) will be redirected to /payfast-notify',
        cors: {
            origin: req.headers.origin || 'none',
            credentialsAllowed: true
        },
        timestamp: new Date().toISOString()
    });
});

// 6. TEST ROOT ITN ENDPOINT
app.get('/test-root-itn', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Test Root ITN Fix</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; }
                .success { color: green; }
                .info { background: #f0f0f0; padding: 15px; border-radius: 5px; margin: 20px 0; }
            </style>
        </head>
        <body>
            <h1>🧪 Test Root ITN Fix</h1>
            <div class="info">
                <strong>Current PayFast ITN URL in dashboard:</strong> https://payfast-itn.onrender.com<br>
                <strong>Should be:</strong> https://payfast-itn.onrender.com/payfast-notify<br>
                <strong>Fix Status:</strong> <span class="success">✅ ACTIVE</span><br>
                <p>This fix automatically redirects ITN requests from root (/) to /payfast-notify</p>
            </div>
            <p><a href="/test">Back to Test Dashboard</a></p>
        </body>
        </html>
    `);
});

// 7. SIMULATE ITN
app.post('/simulate-itn', async (req, res) => {
    try {
        const bookingId = req.body.bookingId || 'simulate-' + Date.now();

        // Check if booking exists in Firestore
        let bookingExists = false;
        if (db) {
            const doc = await db.collection('bookings').doc(bookingId).get();
            bookingExists = doc.exists;
        }

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
            merchant_id: PAYFAST_CONFIG.merchantId
        };

        // Generate signature
        testData.signature = generatePayFastSignature(testData, PAYFAST_CONFIG.passphrase);

        console.log('🧪 Simulating ITN for booking:', bookingId);
        console.log('Booking exists in Firestore:', bookingExists);

        // Call ITN endpoint
        const response = await axios.post(
            getNotifyUrl(),
            querystring.stringify(testData),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        res.json({
            success: true,
            message: 'ITN simulation completed',
            bookingId: bookingId,
            bookingExists: bookingExists,
            response: response.data
        });

    } catch (error) {
        console.error('Simulate ITN error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            response: error.response?.data
        });
    }
});

// 8. PROCESS PAYMENT
app.post('/process-payment', async (req, res) => {
    try {
        console.log('Processing payment request:', req.body);

        const { amount, item_name, email_address, booking_id, name_first, name_last } = req.body;

        if (!amount || !email_address || !booking_id) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }

        const payfastUrl = PAYFAST_CONFIG.sandbox ? PAYFAST_CONFIG.sandboxUrl : PAYFAST_CONFIG.productionUrl;
        const returnUrl = `https://salwacollective.co.za/payment-result.html?booking_id=${booking_id}`;
        const cancelUrl = `https://salwacollective.co.za/payment-result.html?booking_id=${booking_id}&cancelled=true`;
        const notifyUrl = getNotifyUrl();

        const paymentData = {
            merchant_id: PAYFAST_CONFIG.merchantId,
            merchant_key: PAYFAST_CONFIG.merchantKey,
            return_url: returnUrl,
            cancel_url: cancelUrl,
            notify_url: notifyUrl,
            name_first: name_first || '',
            name_last: name_last || '',
            email_address: email_address,
            amount: parseFloat(amount).toFixed(2),
            item_name: item_name || 'Event Ticket',
            m_payment_id: booking_id
        };

        const signature = generatePayFastSignature(paymentData, PAYFAST_CONFIG.passphrase);
        paymentData.signature = signature;

        // Store booking in Firestore
        if (db) {
            const bookingData = {
                bookingId: booking_id,
                status: 'pending_payment',
                paymentStatus: 'PENDING',
                totalAmount: parseFloat(amount),
                itemName: item_name,
                customerEmail: email_address,
                customerFirstName: name_first || '',
                customerLastName: name_last || '',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                paymentTimeout: new Date(Date.now() + 30 * 60 * 1000),
                itnReceived: false
            };

            await db.collection('bookings').doc(booking_id).set(bookingData);
            console.log(`✅ Booking ${booking_id} stored in Firestore`);
        }

        const redirectUrl = `${payfastUrl}?${new URLSearchParams(paymentData).toString()}`;

        res.json({
            success: true,
            redirectUrl: redirectUrl,
            bookingId: booking_id
        });

    } catch (error) {
        console.error('Payment processing error:', error);
        res.status(500).json({
            success: false,
            error: 'Payment processing failed',
            message: error.message
        });
    }
});

// 9. PAYFAST ITN ENDPOINT (UNCHANGED - STILL WORKS FOR /payfast-notify)
app.post('/payfast-notify', async (req, res) => {
    console.log('\n' + '='.repeat(70));
    console.log('🟣 PAYFAST ITN RECEIVED');
    console.log('='.repeat(70));

    // Check if this came via root redirect
    const viaRootRedirect = req.headers['x-original-url'] === '/' || req.originalUrl === '/';
    if (viaRootRedirect) {
        console.log('📤 This ITN was redirected from root URL (/)');
    }

    const data = req.body;
    console.log('ITN Data:', JSON.stringify(data, null, 2));

    try {
        // Verify signature
        const isValidSignature = verifyPayFastSignature(data, PAYFAST_CONFIG.passphrase);

        if (!isValidSignature) {
            console.error('❌ Invalid signature');
            return res.status(200).send('OK'); // Always respond OK to PayFast
        }

        const bookingId = data.m_payment_id;
        const paymentStatus = data.payment_status?.toUpperCase() || 'UNKNOWN';

        console.log(`Processing ITN for booking: ${bookingId}, status: ${paymentStatus}`);

        if (!db) {
            console.error('❌ Firebase not available');
            return res.status(200).send('OK');
        }

        // Check if booking exists
        const bookingDoc = await db.collection('bookings').doc(bookingId).get();

        if (!bookingDoc.exists) {
            console.log(`⚠️ Booking ${bookingId} not found in Firestore, creating it...`);

            // Create the booking if it doesn't exist
            const newBookingData = {
                bookingId: bookingId,
                status: paymentStatus === 'COMPLETE' ? 'confirmed' : paymentStatus.toLowerCase(),
                paymentStatus: paymentStatus,
                totalAmount: parseFloat(data.amount_gross || 0),
                itemName: data.item_name || '',
                customerEmail: data.email_address || '',
                customerFirstName: data.name_first || '',
                customerLastName: data.name_last || '',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                itnReceived: true,
                payfastPaymentId: data.pf_payment_id || '',
                amountPaid: parseFloat(data.amount_gross || 0),
                isPaid: paymentStatus === 'COMPLETE',
                paymentDate: paymentStatus === 'COMPLETE' ? admin.firestore.FieldValue.serverTimestamp() : null,
                itnData: data,
                itnReceivedVia: viaRootRedirect ? 'root_redirect' : 'direct'
            };

            await db.collection('bookings').doc(bookingId).set(newBookingData);
            console.log(`✅ Created new booking ${bookingId} from ITN`);

        } else {
            // Update existing booking
            const updateData = {
                paymentStatus: paymentStatus,
                payfastPaymentId: data.pf_payment_id || '',
                amountPaid: parseFloat(data.amount_gross || 0),
                itnReceived: true,
                lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                itnData: data,
                itnReceivedVia: viaRootRedirect ? 'root_redirect' : 'direct'
            };

            if (paymentStatus === 'COMPLETE') {
                updateData.status = 'confirmed';
                updateData.isPaid = true;
                updateData.paymentDate = admin.firestore.FieldValue.serverTimestamp();
            } else if (paymentStatus === 'CANCELLED' || paymentStatus === 'USER_CANCELLED') {
                updateData.status = 'cancelled';
                updateData.isPaid = false;
                updateData.cancellationReason = 'user_cancelled';
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
            console.log(`✅ Updated booking ${bookingId} in Firestore`);
        }

        // Log ITN success
        await db.collection('itn_logs').add({
            bookingId: bookingId,
            paymentStatus: paymentStatus,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            data: data,
            viaRootRedirect: viaRootRedirect
        });

        console.log('✅ ITN processing completed');
        res.status(200).send('OK');

    } catch (error) {
        console.error('🔴 ITN Processing Error:', error);

        // Log error
        if (db) {
            try {
                await db.collection('itn_errors').add({
                    error: error.message,
                    data: data,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    viaRootRedirect: viaRootRedirect
                });
            } catch (logError) {
                console.error('Failed to log ITN error:', logError);
            }
        }

        // Always respond OK to prevent PayFast retries
        res.status(200).send('OK');
    }
});

// 10. CHECK STATUS
app.post('/check-status', async (req, res) => {
    try {
        const { bookingId } = req.body;

        if (!bookingId) {
            return res.status(400).json({ error: 'Booking ID required' });
        }

        if (!db) {
            return res.json({ status: 'database_unavailable', bookingId: bookingId });
        }

        const doc = await db.collection('bookings').doc(bookingId).get();

        if (!doc.exists) {
            return res.json({ status: 'not_found', bookingId: bookingId });
        }

        const data = doc.data();

        res.json({
            success: true,
            bookingId: bookingId,
            status: data.status || 'pending',
            paymentStatus: data.paymentStatus || 'pending',
            isPaid: data.isPaid || false,
            itnReceived: data.itnReceived || false,
            itnReceivedVia: data.itnReceivedVia || 'unknown',
            amount: data.totalAmount || data.amountPaid || 0,
            email: data.customerEmail || ''
        });

    } catch (error) {
        console.error('Check status error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 11. GET ORIGIN INFO (for debugging CORS)
app.get('/origin-info', (req, res) => {
    res.json({
        origin: req.headers.origin || 'none',
        host: req.headers.host,
        allowedOrigins: ALLOWED_ORIGINS,
        isOriginAllowed: ALLOWED_ORIGINS.includes(req.headers.origin),
        credentials: true,
        itnFix: 'Active - POST to / with ITN data redirects to /payfast-notify'
    });
});

// 12. 404 HANDLER
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found', path: req.url });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
    🚀 Server started on port ${PORT}
    🌐 Home: http://localhost:${PORT}
    🧪 Test Dashboard: http://localhost:${PORT}/test
    🔗 ITN Endpoint: ${getNotifyUrl()}
    🛡️ Mode: ${PAYFAST_CONFIG.sandbox ? 'SANDBOX' : 'PRODUCTION'}
    🔐 CORS: Enabled (${ALLOWED_ORIGINS.length} origins, credentials allowed)
    🔄 ITN FIX: ✅ ACTIVE (root URL → /payfast-notify)
    
    📋 API Endpoints:
    - GET  /              - Home page
    - GET  /test          - Test dashboard
    - GET  /health        - Health check
    - GET  /itn-test      - Test ITN endpoint
    - GET  /test-root-itn - Test root ITN fix
    - GET  /origin-info   - CORS debugging
    - POST /process-payment - Create payment
    - POST /payfast-notify  - ITN webhook (also accepts POST to /)
    - POST /check-status   - Check booking status
    - POST /simulate-itn   - Simulate ITN
    - POST /create-test-booking - Create test booking
    
    ✅ Ready to receive PayFast ITN notifications!
    ✅ ITN Fix: PayFast can use either:
       • https://payfast-itn.onrender.com
       • https://payfast-itn.onrender.com/payfast-notify
    ✅ CORS configured for credentials: 'include'
    `);
});