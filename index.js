const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios');
const querystring = require('querystring');
const crypto = require('crypto');
const cors = require('cors');

const app = express();

// ===== CORS CONFIGURATION =====
const allowedOrigins = [
    'https://salwacollective.co.za',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
];

const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    exposedHeaders: ['Content-Range', 'X-Content-Range']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ===== MIDDLEWARE =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
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
    merchantId: process.env.PAYFAST_MERCHANT_ID || '32449257',
    merchantKey: process.env.PAYFAST_MERCHANT_KEY || '4wkknlvwwll3x',
    passphrase: process.env.PAYFAST_PASSPHRASE || 'salwa20242024',
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
    res.json({
        service: 'Salwa Collective Payment API',
        status: 'online',
        endpoints: {
            processPayment: 'POST /process-payment',
            checkPaymentStatus: 'POST /check-payment-status',
            payfastNotify: 'POST /payfast-notify',
            health: 'GET /health',
            test: 'GET /test'
        }
    });
});

// 2. HEALTH CHECK
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        mode: PAYFAST_CONFIG.sandbox ? 'sandbox' : 'production',
        firebase: db ? 'connected' : 'disconnected',
        cors: 'enabled',
        origins: allowedOrigins
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
                body { font-family: Arial; padding: 20px; }
                button { padding: 10px; margin: 5px; background: #4CAF50; color: white; border: none; cursor: pointer; }
                .result { background: #f5f5f5; padding: 10px; margin: 10px 0; }
            </style>
        </head>
        <body>
            <h1>🧪 PayFast Test Dashboard</h1>
            
            <div>
                <button onclick="testITN()">Test ITN Endpoint</button>
                <button onclick="simulateITN()">Simulate ITN</button>
                <button onclick="createTestPayment()">Create Test Payment</button>
            </div>
            
            <div id="result"></div>
            
            <script>
                async function testITN() {
                    try {
                        const res = await fetch('/itn-test');
                        const data = await res.json();
                        document.getElementById('result').innerHTML = 
                            '<div class="result"><strong>✅ ITN Test:</strong><br>' + 
                            JSON.stringify(data, null, 2) + '</div>';
                    } catch (error) {
                        document.getElementById('result').innerHTML = 
                            '<div class="result"><strong>❌ Error:</strong> ' + error + '</div>';
                    }
                }
                
                async function simulateITN() {
                    const bookingId = 'simulate-' + Date.now();
                    try {
                        const res = await fetch('/simulate-itn', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ bookingId: bookingId })
                        });
                        const data = await res.json();
                        document.getElementById('result').innerHTML = 
                            '<div class="result"><strong>✅ ITN Simulated:</strong><br>' + 
                            JSON.stringify(data, null, 2) + '</div>';
                    } catch (error) {
                        document.getElementById('result').innerHTML = 
                            '<div class="result"><strong>❌ Error:</strong> ' + error + '</div>';
                    }
                }
                
                async function createTestPayment() {
                    const bookingId = 'test-' + Date.now();
                    try {
                        const res = await fetch('/process-payment', {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                amount: '5.00',
                                item_name: 'Test Event',
                                email_address: 'test@example.com',
                                booking_id: bookingId,
                                name_first: 'Test',
                                name_last: 'User'
                            })
                        });
                        const data = await res.json();
                        if (data.success) {
                            window.open(data.redirectUrl, '_blank');
                            document.getElementById('result').innerHTML = 
                                '<div class="result"><strong>✅ Payment Created:</strong><br>' + 
                                'Booking ID: ' + bookingId + '<br>' +
                                '<a href="' + data.redirectUrl + '" target="_blank">Click to pay</a></div>';
                        }
                    } catch (error) {
                        document.getElementById('result').innerHTML = 
                            '<div class="result"><strong>❌ Error:</strong> ' + error + '</div>';
                    }
                }
            </script>
        </body>
        </html>
    `);
});

// 4. ITN TEST ENDPOINT
app.get('/itn-test', (req, res) => {
    res.json({
        success: true,
        message: 'ITN endpoint is accessible',
        url: getNotifyUrl(),
        timestamp: new Date().toISOString()
    });
});

// 5. SIMULATE ITN
app.post('/simulate-itn', async (req, res) => {
    try {
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
            merchant_id: PAYFAST_CONFIG.merchantId
        };

        testData.signature = generatePayFastSignature(testData, PAYFAST_CONFIG.passphrase);

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
            response: response.data
        });

    } catch (error) {
        console.error('Simulate ITN error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 6. PROCESS PAYMENT - WITH CORRECT ENDPOINT NAME
app.post('/process-payment', async (req, res) => {
    try {
        console.log('Processing payment request:', req.body);

        const {
            amount,
            item_name,
            email_address,
            booking_id,
            name_first,
            name_last,
            cell_number,
            event_id,
            ticket_number,
            ticket_quantity,
            event_name,
            event_date
        } = req.body;

        if (!amount || !email_address || !booking_id) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: amount, email_address, booking_id'
            });
        }

        const payfastUrl = PAYFAST_CONFIG.sandbox ? PAYFAST_CONFIG.sandboxUrl : PAYFAST_CONFIG.productionUrl;
        const returnUrl = `https://salwacollective.co.za/payment-result.html?status=success&booking_id=${booking_id}`;
        const cancelUrl = `https://salwacollective.co.za/payment-result.html?status=cancelled&booking_id=${booking_id}`;
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
            cell_number: cell_number || '',
            amount: parseFloat(amount).toFixed(2),
            item_name: item_name || 'Event Ticket',
            m_payment_id: booking_id
        };

        if (event_id) paymentData.custom_str1 = event_id;
        if (ticket_number) paymentData.custom_str2 = ticket_number;
        if (ticket_quantity) paymentData.custom_int1 = parseInt(ticket_quantity);

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
                customerPhone: cell_number || '',
                eventId: event_id || '',
                ticketNumber: ticket_number || '',
                ticketQuantity: parseInt(ticket_quantity) || 1,
                eventName: event_name || '',
                eventDate: event_date || '',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                paymentTimeout: new Date(Date.now() + 30 * 60 * 1000),
                itnReceived: false,
                paymentMethod: 'payfast'
            };

            await db.collection('bookings').doc(booking_id).set(bookingData);
            console.log(`✅ Booking ${booking_id} stored in Firestore`);
        }

        const redirectUrl = `${payfastUrl}?${new URLSearchParams(paymentData).toString()}`;

        res.json({
            success: true,
            redirectUrl: redirectUrl,
            bookingId: booking_id,
            signature: signature
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

// 7. CHECK PAYMENT STATUS - FIXED ENDPOINT NAME
app.post('/check-payment-status', async (req, res) => {
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
            amount: bookingData.totalAmount || bookingData.amountPaid || 0,
            email: bookingData.customerEmail || '',
            eventName: bookingData.eventName || bookingData.itemName || '',
            eventDate: bookingData.eventDate || '',
            ticketNumber: bookingData.ticketNumber || '',
            customerName: `${bookingData.customerFirstName || ''} ${bookingData.customerLastName || ''}`.trim(),
            createdAt: bookingData.createdAt ?
                (bookingData.createdAt.toDate ? bookingData.createdAt.toDate().toISOString() : bookingData.createdAt) :
                null,
            lastUpdated: bookingData.lastUpdated ?
                (bookingData.lastUpdated.toDate ? bookingData.lastUpdated.toDate().toISOString() : bookingData.lastUpdated) :
                null
        });

    } catch (error) {
        console.error('Check status error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            bookingId: req.body.bookingId
        });
    }
});

// 8. PAYFAST ITN ENDPOINT
app.post('/payfast-notify', async (req, res) => {
    console.log('\n' + '='.repeat(70));
    console.log('🟣 PAYFAST ITN RECEIVED');
    console.log('='.repeat(70));

    const data = req.body;
    console.log('ITN Data:', JSON.stringify(data, null, 2));

    try {
        const isValidSignature = verifyPayFastSignature(data, PAYFAST_CONFIG.passphrase);

        if (!isValidSignature) {
            console.error('❌ Invalid signature');
            return res.status(200).send('OK');
        }

        const bookingId = data.m_payment_id;
        const paymentStatus = data.payment_status?.toUpperCase() || 'UNKNOWN';

        console.log(`Processing ITN for booking: ${bookingId}, status: ${paymentStatus}`);

        if (!db) {
            console.error('❌ Firebase not available');
            return res.status(200).send('OK');
        }

        const bookingDoc = await db.collection('bookings').doc(bookingId).get();

        const updateData = {
            paymentStatus: paymentStatus,
            payfastPaymentId: data.pf_payment_id || '',
            amountPaid: parseFloat(data.amount_gross || 0),
            itnReceived: true,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
            itnData: data
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

        if (bookingDoc.exists) {
            await db.collection('bookings').doc(bookingId).update(updateData);
            console.log(`✅ Updated booking ${bookingId} in Firestore`);
        } else {
            // Create new booking if it doesn't exist
            const newBookingData = {
                bookingId: bookingId,
                ...updateData,
                customerEmail: data.email_address || '',
                customerFirstName: data.name_first || '',
                customerLastName: data.name_last || '',
                customerPhone: data.cell_number || '',
                itemName: data.item_name || '',
                totalAmount: parseFloat(data.amount_gross || 0),
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                paymentMethod: 'payfast'
            };

            await db.collection('bookings').doc(bookingId).set(newBookingData);
            console.log(`✅ Created new booking ${bookingId} from ITN`);
        }

        // Log ITN
        await db.collection('itn_logs').add({
            bookingId: bookingId,
            paymentStatus: paymentStatus,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            data: data
        });

        console.log('✅ ITN processing completed');
        res.status(200).send('OK');

    } catch (error) {
        console.error('🔴 ITN Processing Error:', error);

        if (db) {
            try {
                await db.collection('itn_errors').add({
                    error: error.message,
                    data: data,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
            } catch (logError) {
                console.error('Failed to log ITN error:', logError);
            }
        }

        res.status(200).send('OK');
    }
});

// 9. 404 HANDLER
app.use((req, res) => {
    console.log(`❌ Route not found: ${req.method} ${req.url}`);
    res.status(404).json({
        error: 'Route not found',
        path: req.url,
        method: req.method,
        availableEndpoints: [
            'POST /process-payment',
            'POST /check-payment-status',
            'POST /payfast-notify',
            'GET /health',
            'GET /test'
        ]
    });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
    🚀 Salwa Collective Payment Server Started!
    ===========================================
    📍 Port: ${PORT}
    🔒 Mode: ${PAYFAST_CONFIG.sandbox ? 'SANDBOX 🧪' : 'PRODUCTION 🏢'}
    🌐 URL: https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost:' + PORT}
    🔗 ITN URL: ${getNotifyUrl()}
    
    📋 Available Endpoints:
    ├── POST /process-payment      - Create PayFast payment
    ├── POST /check-payment-status - Check booking status (FIXED NAME)
    ├── POST /payfast-notify       - PayFast ITN webhook
    ├── GET  /health              - Health check
    ├── GET  /test                - Test dashboard
    ├── GET  /itn-test            - Test ITN endpoint
    └── POST /simulate-itn        - Simulate ITN
    
    🌍 CORS Allowed Origins:
    ${allowedOrigins.map(origin => `    - ${origin}`).join('\n')}
    
    ⚠️  Environment Variables:
    ├── FIREBASE_KEY              - ${process.env.FIREBASE_KEY ? '✅ Set' : '❌ Missing'}
    ├── PAYFAST_MERCHANT_ID       - ${PAYFAST_CONFIG.merchantId}
    ├── PAYFAST_MERCHANT_KEY      - ${PAYFAST_CONFIG.merchantKey ? '✅ Set' : '❌ Missing'}
    ├── PAYFAST_PASSPHRASE        - ${PAYFAST_CONFIG.passphrase ? '✅ Set' : '❌ Not Set'}
    └── PAYFAST_SANDBOX           - ${PAYFAST_CONFIG.sandbox}
    
    ✅ Ready to process payments!
    `);
});