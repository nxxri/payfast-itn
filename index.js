const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios');
const querystring = require('querystring');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
// ===== FIX GLOBAL CORS (must be at the VERY TOP) =====
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*"); // or your URL only
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
        return res.sendStatus(200); // <-- CRITICAL
    }

    next();
});

// ========== MIDDLEWARE ==========
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

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
    // Remove signature from data if present
    const signatureData = { ...data };
    delete signatureData.signature;

    // Create parameter string in alphabetical order
    let pfOutput = '';
    const sortedKeys = Object.keys(signatureData).sort();

    for (let key of sortedKeys) {
        // Only include non-empty parameters
        if (signatureData[key] !== undefined && signatureData[key] !== null && signatureData[key] !== '') {
            pfOutput += `${key}=${encodeURIComponent(signatureData[key].toString()).replace(/%20/g, '+')}&`;
        }
    }

    // Remove trailing ampersand
    pfOutput = pfOutput.slice(0, -1);

    // Add passphrase if provided
    if (passPhrase && passPhrase.trim() !== '') {
        pfOutput += `&passphrase=${encodeURIComponent(passPhrase.trim()).replace(/%20/g, '+')}`;
    }

    // Generate MD5 hash
    return crypto.createHash('md5').update(pfOutput).digest('hex');
}

function verifyPayFastSignature(data, passphrase = '') {
    // Extract the signature from data
    const submittedSignature = data.signature;

    // Recreate the parameter string exactly as PayFast does
    let pfParamString = '';
    const sortedKeys = Object.keys(data).sort();

    for (const key of sortedKeys) {
        // Skip signature parameter itself and empty values
        if (key !== 'signature' &&
            data[key] !== undefined &&
            data[key] !== null &&
            data[key] !== '') {
            pfParamString += `${key}=${encodeURIComponent(data[key].toString()).replace(/%20/g, '+')}&`;
        }
    }

    // Remove trailing ampersand
    pfParamString = pfParamString.slice(0, -1);

    // Add passphrase if provided
    if (passphrase && passphrase.trim() !== '') {
        pfParamString += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, '+')}`;
    }

    // Generate MD5 hash
    const calculatedSignature = crypto.createHash('md5').update(pfParamString).digest('hex');

    console.log('🔍 Verification Debug:');
    console.log('Parameter string:', pfParamString);
    console.log('Submitted signature:', submittedSignature);
    console.log('Calculated signature:', calculatedSignature);
    console.log('Match?', calculatedSignature === submittedSignature);

    return calculatedSignature === submittedSignature;
}

// ========== ROUTE 1: PROCESS PAYMENT ==========
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

        // Build payment data - EXACTLY as PayFast expects
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

        // IMPORTANT: Remove any empty values that PayFast doesn't want
        Object.keys(paymentData).forEach(key => {
            if (paymentData[key] === '' || paymentData[key] === null) {
                delete paymentData[key];
            }
        });

        // CRITICAL FIX: For sandbox, use passphrase = '' (empty string)
        // For production, use the actual passphrase
        const passphraseToUse = PAYFAST_CONFIG.sandbox ? '' : PAYFAST_CONFIG.passphrase;

        // Generate signature
        const signature = generateSignature(paymentData, passphraseToUse);
        paymentData.signature = signature;

        console.log('🟡 Payment data with signature:', paymentData);
        console.log('🔍 Generated signature:', signature);
        console.log('🔍 Using passphrase?', passphraseToUse ? 'YES' : 'NO (sandbox)');

        // Create redirect URL
        const payfastUrl = PAYFAST_CONFIG.sandbox ? PAYFAST_CONFIG.sandboxUrl : PAYFAST_CONFIG.productionUrl;
        const queryString = new URLSearchParams(paymentData).toString();
        const redirectUrl = `${payfastUrl}?${queryString}`;

        console.log('🟢 Redirecting to:', redirectUrl);

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

// ========== ROUTE 2: ITN HANDLER ==========
app.post('/payfast-notify', async (req, res) => {
    const data = req.body;

    try {
        console.log('🟣 ITN received:', JSON.stringify(data, null, 2));
        console.log('🔍 ALL ITN PARAMETERS:');
        Object.keys(data).sort().forEach(key => {
            console.log(`  ${key}: "${data[key]}" (type: ${typeof data[key]})`);
        });

        // Verify signature - use same logic as process-payment
        const passphraseToUse = PAYFAST_CONFIG.sandbox ? '' : PAYFAST_CONFIG.passphrase;
        const isValidSignature = verifyPayFastSignature(data, passphraseToUse);

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

            // Set main status
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

        // Log error to Firebase
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
            checkStatus: 'POST /check-payment-status'
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
    └── GET  /health             - Server health check
    
    ⚠️  Make sure these env vars are set:
    ├── FIREBASE_KEY
    ├── PAYFAST_MERCHANT_ID
    ├── PAYFAST_MERCHANT_KEY
    ├── PAYFAST_PASSPHRASE
    └── PAYFAST_SANDBOX=true/false
    `);
});