const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors({
    origin: ['https://salwacollective.co.za', 'http://localhost:3000'],
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Firebase Admin
let firebaseInitialized = false;
try {
    const serviceAccount = {
        type: process.env.FIREBASE_TYPE,
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID,
        auth_uri: process.env.FIREBASE_AUTH_URI,
        token_uri: process.env.FIREBASE_TOKEN_URI,
        auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
        client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
    };

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });

    firebaseInitialized = true;
    console.log('Firebase Admin initialized successfully');
} catch (error) {
    console.error('Firebase Admin initialization error:', error.message);
}

// PayFast Configuration
const PAYFAST_CONFIG = {
    // Sandbox or Live mode
    sandbox: process.env.PAYFAST_SANDBOX === 'true',

    // URLs
    baseUrl: process.env.PAYFAST_SANDBOX === 'true'
        ? 'https://sandbox.payfast.co.za'
        : 'https://www.payfast.co.za',

    // Merchant credentials
    merchant: {
        id: process.env.PAYFAST_MERCHANT_ID,
        key: process.env.PAYFAST_MERCHANT_KEY,
        passphrase: process.env.PAYFAST_PASSPHRASE || ''
    },

    // Your URLs
    returnUrl: process.env.PAYFAST_RETURN_URL || 'https://salwacollective.co.za/payment-result.html',
    cancelUrl: process.env.PAYFAST_CANCEL_URL || 'https://salwacollective.co.za/payment-result.html?cancelled=true',
    notifyUrl: process.env.PAYFAST_NOTIFY_URL || 'https://payfast-itn.onrender.com/payfast-notify'
};

// Generate PayFast signature
function generateSignature(data, passphrase = '') {
    // Create parameter string in PayFast order (not alphabetical)
    let pfOutput = '';

    // PayFast requires specific order: merchant details first, then customer, then transaction
    const fieldOrder = [
        'merchant_id', 'merchant_key', 'return_url', 'cancel_url', 'notify_url',
        'name_first', 'name_last', 'email_address', 'cell_number',
        'm_payment_id', 'amount', 'item_name', 'item_description',
        'custom_int1', 'custom_int2', 'custom_int3', 'custom_int4', 'custom_int5',
        'custom_str1', 'custom_str2', 'custom_str3', 'custom_str4', 'custom_str5',
        'email_confirmation', 'confirmation_address'
    ];

    for (const key of fieldOrder) {
        if (data[key] !== undefined && data[key] !== '' && data[key] !== null) {
            pfOutput += `${key}=${encodeURIComponent(data[key].toString().trim())}&`;
        }
    }

    // Remove last ampersand
    pfOutput = pfOutput.slice(0, -1);

    // Add passphrase if provided
    if (passphrase) {
        pfOutput += `&passphrase=${encodeURIComponent(passphrase.trim())}`;
    }

    // Generate MD5 hash
    return crypto.createHash('md5').update(pfOutput).digest('hex');
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        firebase: firebaseInitialized ? 'connected' : 'disconnected',
        payfast: {
            mode: PAYFAST_CONFIG.sandbox ? 'sandbox' : 'live',
            merchantId: PAYFAST_CONFIG.merchant.id ? 'configured' : 'missing'
        }
    });
});

// Process payment endpoint
app.post('/process-payment', async (req, res) => {
    try {
        const {
            bookingId,
            eventId,
            eventName,
            eventDate,
            ticketNumber,
            amount,
            ticketQuantity,
            customer,
            discount,
            addons,
            emergencyContact
        } = req.body;

        // Validate required fields
        if (!bookingId || !amount || !customer?.email || !customer?.firstName) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields'
            });
        }

        // Format amount to 2 decimal places
        const formattedAmount = parseFloat(amount).toFixed(2);

        // Prepare PayFast payload
        const payfastData = {
            // Merchant details
            merchant_id: PAYFAST_CONFIG.merchant.id,
            merchant_key: PAYFAST_CONFIG.merchant.key,
            return_url: `${PAYFAST_CONFIG.returnUrl}?booking_id=${bookingId}&status=success`,
            cancel_url: `${PAYFAST_CONFIG.cancelUrl}?booking_id=${bookingId}&status=cancelled`,
            notify_url: PAYFAST_CONFIG.notifyUrl,

            // Customer details
            name_first: customer.firstName.substring(0, 100),
            name_last: customer.lastName.substring(0, 100),
            email_address: customer.email.substring(0, 100),
            cell_number: customer.phone.substring(0, 100),

            // Transaction details
            m_payment_id: bookingId,
            amount: formattedAmount,
            item_name: `Salwa Event: ${eventName}`.substring(0, 100),
            item_description: `Ticket for ${eventName} on ${eventDate}`.substring(0, 255),

            // Custom fields for tracking
            custom_str1: eventId,
            custom_str2: ticketNumber,
            custom_str3: JSON.stringify({
                discount: discount,
                addons: addons,
                emergencyContact: emergencyContact
            }),
            custom_int1: ticketQuantity,

            // Email confirmation
            email_confirmation: '1',
            confirmation_address: customer.email
        };

        // Generate signature
        const signature = generateSignature(payfastData, PAYFAST_CONFIG.merchant.passphrase);
        payfastData.signature = signature;

        // Store booking in Firestore as pending
        if (firebaseInitialized) {
            const db = admin.firestore();
            const bookingRef = db.collection('bookings').doc(bookingId);

            await bookingRef.set({
                ...req.body,
                status: 'pending_payment',
                paymentGateway: 'payfast',
                payfastData: {
                    amount: formattedAmount,
                    itemName: payfastData.item_name,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                },
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }

        // Return the redirect URL
        const redirectUrl = `${PAYFAST_CONFIG.baseUrl}/eng/process`;

        res.json({
            success: true,
            redirectUrl: redirectUrl,
            payfastData: payfastData, // For debugging
            bookingId: bookingId
        });

    } catch (error) {
        console.error('Payment processing error:', error);
        res.status(500).json({
            success: false,
            message: 'Payment processing failed',
            error: error.message
        });
    }
});

// PayFast ITN (Instant Transaction Notification) endpoint
app.post('/payfast-notify', async (req, res) => {
    try {
        // Send 200 immediately to acknowledge receipt
        res.status(200).send('OK');

        const pfData = req.body;
        console.log('ITN received:', pfData);

        // 1. Verify the signature
        const signature = generateSignature(pfData, PAYFAST_CONFIG.merchant.passphrase);

        if (signature !== pfData.signature) {
            console.error('Signature mismatch');
            return;
        }

        // 2. Validate with PayFast server
        const validationUrl = `${PAYFAST_CONFIG.baseUrl}/eng/query/validate`;

        const validationResponse = await axios.post(validationUrl, pfData, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        if (validationResponse.data !== 'VALID') {
            console.error('PayFast validation failed');
            return;
        }

        // 3. Update booking in Firestore
        const bookingId = pfData.m_payment_id;
        const paymentStatus = pfData.payment_status;

        if (firebaseInitialized) {
            const db = admin.firestore();
            const bookingRef = db.collection('bookings').doc(bookingId);

            const updateData = {
                status: paymentStatus === 'COMPLETE' ? 'confirmed' : 'failed',
                paymentStatus: paymentStatus,
                payfastResponse: {
                    pfPaymentId: pfData.pf_payment_id,
                    amountGross: pfData.amount_gross,
                    amountFee: pfData.amount_fee,
                    amountNet: pfData.amount_net,
                    timestamp: new Date().toISOString()
                },
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            };

            // If payment is complete, add confirmation details
            if (paymentStatus === 'COMPLETE') {
                updateData.confirmedAt = admin.firestore.FieldValue.serverTimestamp();
                updateData.confirmedAmount = pfData.amount_gross;
            }

            await bookingRef.update(updateData);

            console.log(`Booking ${bookingId} updated to status: ${paymentStatus}`);
        }

    } catch (error) {
        console.error('ITN processing error:', error);
    }
});

// Check booking status endpoint (for frontend polling)
app.post('/check-status', async (req, res) => {
    try {
        const { bookingId } = req.body;

        if (!bookingId) {
            return res.status(400).json({
                success: false,
                message: 'Booking ID required'
            });
        }

        if (!firebaseInitialized) {
            return res.status(500).json({
                success: false,
                message: 'Database not available'
            });
        }

        const db = admin.firestore();
        const bookingRef = db.collection('bookings').doc(bookingId);
        const bookingDoc = await bookingRef.get();

        if (!bookingDoc.exists) {
            return res.status(404).json({
                success: false,
                message: 'Booking not found'
            });
        }

        const bookingData = bookingDoc.data();

        res.json({
            success: true,
            bookingId: bookingId,
            status: bookingData.status || 'pending',
            paymentStatus: bookingData.paymentStatus,
            ticketNumber: bookingData.ticketNumber,
            eventName: bookingData.eventName,
            amount: bookingData.amount
        });

    } catch (error) {
        console.error('Check status error:', error);
        res.status(500).json({
            success: false,
            message: 'Error checking status',
            error: error.message
        });
    }
});

// Handle payment return (optional - if you want to process returns on backend)
app.get('/payment-return', async (req, res) => {
    try {
        const { booking_id, status } = req.query;

        if (!booking_id) {
            return res.redirect('https://salwacollective.co.za/payment-result.html?error=no_booking_id');
        }

        // You can update booking status here if needed
        // Or just redirect to frontend with parameters

        const redirectUrl = `https://salwacollective.co.za/payment-result.html?booking_id=${booking_id}&status=${status}`;
        res.redirect(redirectUrl);

    } catch (error) {
        console.error('Payment return error:', error);
        res.redirect('https://salwacollective.co.za/payment-result.html?error=server_error');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`PayFast mode: ${PAYFAST_CONFIG.sandbox ? 'SANDBOX' : 'LIVE'}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});