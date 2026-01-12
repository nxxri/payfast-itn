const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
const axios = require('axios');
const qs = require('querystring');
require('dotenv').config();

const app = express();

// Middleware
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors({
    origin: ['https://salwacollective.co.za', 'http://localhost:3000'],
    credentials: true
}));

// Initialize Firebase Admin
let firebaseInitialized = false;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        firebaseInitialized = true;
        console.log('Firebase Admin initialized');
    }
} catch (error) {
    console.error('Firebase Admin initialization error:', error.message);
}

// PayFast Configuration for Redirect Payments
const PAYFAST_CONFIG = {
    sandbox: process.env.PAYFAST_SANDBOX === 'true',
    processUrl: process.env.PAYFAST_SANDBOX === 'true'
        ? 'https://sandbox.payfast.co.za/eng/process'
        : 'https://www.payfast.co.za/eng/process',
    validateUrl: process.env.PAYFAST_SANDBOX === 'true'
        ? 'https://sandbox.payfast.co.za/eng/query/validate'
        : 'https://www.payfast.co.za/eng/query/validate',
    merchant: {
        id: process.env.PAYFAST_MERCHANT_ID,
        key: process.env.PAYFAST_MERCHANT_KEY,
        passphrase: process.env.PAYFAST_PASSPHRASE || ''
    },
    returnUrl: process.env.PAYFAST_RETURN_URL || 'https://salwacollective.co.za/Upcoming-Events.html',
    cancelUrl: process.env.PAYFAST_CANCEL_URL || 'https://salwacollective.co.za/Upcoming-Events.html',
    notifyUrl: process.env.PAYFAST_NOTIFY_URL || 'https://payfast-itn.onrender.com/payfast-notify'
};

// ✅ CORRECT SIGNATURE FUNCTION (PayFast Documentation Order - NOT alphabetical!)
function generatePayFastSignature(data, passphrase = '') {
    // Create filtered object without empty/null fields and without signature
    const filtered = {};

    for (const key in data) {
        if (key === 'signature') continue;
        if (data[key] !== undefined && data[key] !== null && data[key] !== '') {
            filtered[key] = data[key];
        }
    }

    // ✅ IMPORTANT: PayFast documentation order (NOT alphabetical)
    // Order as per documentation: merchant details, customer details, transaction details, etc.
    // We'll build the parameter string by adding fields in the documented order

    let paramString = '';

    // Add fields in the order they appear in PayFast documentation
    // Merchant details first
    if (filtered.merchant_id) paramString += `merchant_id=${encodeURIComponent(filtered.merchant_id.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.merchant_key) paramString += `merchant_key=${encodeURIComponent(filtered.merchant_key.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.return_url) paramString += `return_url=${encodeURIComponent(filtered.return_url.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.cancel_url) paramString += `cancel_url=${encodeURIComponent(filtered.cancel_url.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.notify_url) paramString += `notify_url=${encodeURIComponent(filtered.notify_url.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.name_first) paramString += `name_first=${encodeURIComponent(filtered.name_first.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.name_last) paramString += `name_last=${encodeURIComponent(filtered.name_last.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.email_address) paramString += `email_address=${encodeURIComponent(filtered.email_address.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.cell_number) paramString += `cell_number=${encodeURIComponent(filtered.cell_number.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.m_payment_id) paramString += `m_payment_id=${encodeURIComponent(filtered.m_payment_id.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.amount) paramString += `amount=${encodeURIComponent(filtered.amount.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.item_name) paramString += `item_name=${encodeURIComponent(filtered.item_name.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.item_description) paramString += `item_description=${encodeURIComponent(filtered.item_description.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.email_confirmation) paramString += `email_confirmation=${encodeURIComponent(filtered.email_confirmation.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.confirmation_address) paramString += `confirmation_address=${encodeURIComponent(filtered.confirmation_address.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.payment_method) paramString += `payment_method=${encodeURIComponent(filtered.payment_method.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.subscription_type) paramString += `subscription_type=${encodeURIComponent(filtered.subscription_type.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.billing_date) paramString += `billing_date=${encodeURIComponent(filtered.billing_date.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.recurring_amount) paramString += `recurring_amount=${encodeURIComponent(filtered.recurring_amount.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.frequency) paramString += `frequency=${encodeURIComponent(filtered.frequency.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.cycles) paramString += `cycles=${encodeURIComponent(filtered.cycles.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.custom_str1) paramString += `custom_str1=${encodeURIComponent(filtered.custom_str1.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.custom_str2) paramString += `custom_str2=${encodeURIComponent(filtered.custom_str2.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.custom_str3) paramString += `custom_str3=${encodeURIComponent(filtered.custom_str3.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.custom_str4) paramString += `custom_str4=${encodeURIComponent(filtered.custom_str4.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.custom_str5) paramString += `custom_str5=${encodeURIComponent(filtered.custom_str5.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.custom_int1) paramString += `custom_int1=${encodeURIComponent(filtered.custom_int1.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.custom_int2) paramString += `custom_int2=${encodeURIComponent(filtered.custom_int2.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.custom_int3) paramString += `custom_int3=${encodeURIComponent(filtered.custom_int3.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.custom_int4) paramString += `custom_int4=${encodeURIComponent(filtered.custom_int4.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.custom_int5) paramString += `custom_int5=${encodeURIComponent(filtered.custom_int5.toString().trim()).replace(/%20/g, "+")}&`;
    if (filtered.fica_idnumber) paramString += `fica_idnumber=${encodeURIComponent(filtered.fica_idnumber.toString().trim()).replace(/%20/g, "+")}&`;

    // Remove last '&'
    paramString = paramString.slice(0, -1);

    // ✅ Add passphrase ONLY for signature calculation
    if (passphrase && passphrase.trim() !== '') {
        paramString += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, "+")}`;
    }

    console.log('🔍 Signature calculation string:', paramString);

    // Create MD5 hash
    const signature = crypto.createHash('md5').update(paramString).digest('hex');
    console.log('🔐 Generated signature:', signature);

    return signature;
}

// For ITN validation (same order as documentation)
function verifyITNSignature(pfData, passphrase = '') {
    let pfParamString = '';

    // Build parameter string in the order fields appear
    if (pfData.m_payment_id) pfParamString += `m_payment_id=${encodeURIComponent(pfData.m_payment_id.toString().trim()).replace(/%20/g, "+")}&`;
    if (pfData.pf_payment_id) pfParamString += `pf_payment_id=${encodeURIComponent(pfData.pf_payment_id.toString().trim()).replace(/%20/g, "+")}&`;
    if (pfData.payment_status) pfParamString += `payment_status=${encodeURIComponent(pfData.payment_status.toString().trim()).replace(/%20/g, "+")}&`;
    if (pfData.item_name) pfParamString += `item_name=${encodeURIComponent(pfData.item_name.toString().trim()).replace(/%20/g, "+")}&`;
    if (pfData.item_description) pfParamString += `item_description=${encodeURIComponent(pfData.item_description.toString().trim()).replace(/%20/g, "+")}&`;
    if (pfData.amount_gross) pfParamString += `amount_gross=${encodeURIComponent(pfData.amount_gross.toString().trim()).replace(/%20/g, "+")}&`;
    if (pfData.amount_fee) pfParamString += `amount_fee=${encodeURIComponent(pfData.amount_fee.toString().trim()).replace(/%20/g, "+")}&`;
    if (pfData.amount_net) pfParamString += `amount_net=${encodeURIComponent(pfData.amount_net.toString().trim()).replace(/%20/g, "+")}&`;
    if (pfData.custom_str1) pfParamString += `custom_str1=${encodeURIComponent(pfData.custom_str1.toString().trim()).replace(/%20/g, "+")}&`;
    if (pfData.custom_str2) pfParamString += `custom_str2=${encodeURIComponent(pfData.custom_str2.toString().trim()).replace(/%20/g, "+")}&`;
    if (pfData.custom_str3) pfParamString += `custom_str3=${encodeURIComponent(pfData.custom_str3.toString().trim()).replace(/%20/g, "+")}&`;
    if (pfData.custom_str4) pfParamString += `custom_str4=${encodeURIComponent(pfData.custom_str4.toString().trim()).replace(/%20/g, "+")}&`;
    if (pfData.custom_str5) pfParamString += `custom_str5=${encodeURIComponent(pfData.custom_str5.toString().trim()).replace(/%20/g, "+")}&`;
    if (pfData.custom_int1) pfParamString += `custom_int1=${encodeURIComponent(pfData.custom_int1.toString().trim()).replace(/%20/g, "+")}&`;
    if (pfData.custom_int2) pfParamString += `custom_int2=${encodeURIComponent(pfData.custom_int2.toString().trim()).replace(/%20/g, "+")}&`;
    if (pfData.custom_int3) pfParamString += `custom_int3=${encodeURIComponent(pfData.custom_int3.toString().trim()).replace(/%20/g, "+")}&`;
    if (pfData.custom_int4) pfParamString += `custom_int4=${encodeURIComponent(pfData.custom_int4.toString().trim()).replace(/%20/g, "+")}&`;
    if (pfData.custom_int5) pfParamString += `custom_int5=${encodeURIComponent(pfData.custom_int5.toString().trim()).replace(/%20/g, "+")}&`;
    if (pfData.name_first) pfParamString += `name_first=${encodeURIComponent(pfData.name_first.toString().trim()).replace(/%20/g, "+")}&`;
    if (pfData.name_last) pfParamString += `name_last=${encodeURIComponent(pfData.name_last.toString().trim()).replace(/%20/g, "+")}&`;
    if (pfData.email_address) pfParamString += `email_address=${encodeURIComponent(pfData.email_address.toString().trim()).replace(/%20/g, "+")}&`;
    if (pfData.merchant_id) pfParamString += `merchant_id=${encodeURIComponent(pfData.merchant_id.toString().trim()).replace(/%20/g, "+")}&`;

    // Remove last '&'
    pfParamString = pfParamString.slice(0, -1);

    if (passphrase && passphrase.trim() !== '') {
        pfParamString += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, "+")}`;
    }

    const calculatedSignature = crypto
        .createHash('md5')
        .update(pfParamString)
        .digest('hex');

    console.log('ITN Verification:');
    console.log('Expected signature:', pfData.signature);
    console.log('Calculated signature:', calculatedSignature);

    return calculatedSignature === pfData.signature;
}

// Generate UUID for booking
function generateBookingId() {
    return 'BK-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        firebase: firebaseInitialized ? 'connected' : 'disconnected',
        payfast: {
            mode: PAYFAST_CONFIG.sandbox ? 'sandbox' : 'live',
            merchantId: PAYFAST_CONFIG.merchant.id ? 'configured' : 'missing',
            key: PAYFAST_CONFIG.merchant.key ? 'configured' : 'missing',
            passphrase: PAYFAST_CONFIG.merchant.passphrase ? 'configured' : 'not set'
        }
    });
});

// ✅ NEW: Generate PayFast Payment Form Data
app.post('/generate-payment-form', async (req, res) => {
    try {
        const {
            item_name,
            name_first,
            name_last,
            email_address,
            cell_number,
            eventId,
            ticketQuantity
        } = req.body;

        console.log('📦 Received payment request:', req.body);

        // Validate required fields
        if (!email_address || !name_first || !ticketQuantity) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: email_address, name_first, and ticketQuantity are required'
            });
        }

        // ✅ SECURITY: Calculate amount on backend
        const PRICE_PER_TICKET = 150;
        const safeQuantity = Math.max(1, Math.min(parseInt(ticketQuantity) || 1, 5));
        const calculatedAmount = (PRICE_PER_TICKET * safeQuantity).toFixed(2);

        console.log(`💰 Calculated amount: R${calculatedAmount} (${safeQuantity} tickets × R${PRICE_PER_TICKET})`);

        // Generate booking ID
        const bookingId = generateBookingId();
        const ticketNumber = 'TICKET-' + Date.now().toString(36).toUpperCase();

        // ✅ Prepare PayFast payload as per documentation
        const payfastData = {
            // Merchant details
            merchant_id: PAYFAST_CONFIG.merchant.id,
            merchant_key: PAYFAST_CONFIG.merchant.key,
            return_url: PAYFAST_CONFIG.returnUrl,
            cancel_url: PAYFAST_CONFIG.cancelUrl,
            notify_url: PAYFAST_CONFIG.notifyUrl,

            // Customer details
            name_first: (name_first || '').substring(0, 100),
            name_last: (name_last || '').substring(0, 100),
            email_address: email_address.substring(0, 100),
            cell_number: (cell_number || '').substring(0, 100),

            // Transaction details
            m_payment_id: bookingId,
            amount: calculatedAmount,
            item_name: (item_name || 'Salwa Event Ticket').substring(0, 100),
            item_description: `Salwa Collective Event: ${safeQuantity} ticket(s)`.substring(0, 255),
            email_confirmation: '1',
            confirmation_address: email_address.substring(0, 100),

            // Custom fields for tracking
            custom_str1: eventId || '',
            custom_int1: safeQuantity
        };

        console.log('📋 PayFast data for signature:', JSON.stringify(payfastData, null, 2));

        // Generate signature with PayFast documentation order
        const signature = generatePayFastSignature(payfastData, PAYFAST_CONFIG.merchant.passphrase);

        // Add signature to data
        payfastData.signature = signature;

        // Store booking in Firestore as pending
        if (firebaseInitialized) {
            const db = admin.firestore();
            const bookingRef = db.collection('bookings').doc(bookingId);

            await bookingRef.set({
                bookingId,
                ticketNumber,
                eventId,
                eventName: item_name || 'Salwa Event',
                amount: calculatedAmount,
                ticketQuantity: safeQuantity,
                customer: {
                    firstName: name_first,
                    lastName: name_last || '',
                    email: email_address,
                    phone: cell_number || ''
                },
                status: 'pending_payment',
                paymentMethod: 'payfast_redirect',
                payfastData: {
                    amount: calculatedAmount,
                    signature: signature
                },
                calculatedAmount: calculatedAmount,
                pricePerTicket: PRICE_PER_TICKET,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }

        res.json({
            success: true,
            bookingId: bookingId,
            ticketNumber: ticketNumber,
            calculatedAmount: calculatedAmount,
            payfastData: payfastData,
            processUrl: PAYFAST_CONFIG.processUrl
        });

    } catch (error) {
        console.error('❌ Payment form generation error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to generate payment form',
            error: error.message
        });
    }
});

// PayFast ITN endpoint
app.post('/payfast-notify', async (req, res) => {
    let acknowledged = false;

    try {
        console.log(`ITN received from: ${req.ip}`);
        const pfData = req.body;

        console.log('ITN data:', pfData);

        // 1. Verify signature
        if (!verifyITNSignature(pfData, PAYFAST_CONFIG.merchant.passphrase)) {
            console.error('ITN signature mismatch');
            if (!acknowledged) {
                res.status(400).send('Invalid signature');
                acknowledged = true;
            }
            return;
        }

        // 2. Validate with PayFast
        try {
            let validateParamString = '';
            for (let key in pfData) {
                if (pfData[key] !== '' && key !== 'signature') {
                    validateParamString += `${key}=${encodeURIComponent(pfData[key].toString().trim()).replace(/%20/g, "+")}&`;
                }
            }
            validateParamString = validateParamString.slice(0, -1);

            const validationResponse = await axios.post(
                PAYFAST_CONFIG.validateUrl,
                validateParamString,
                {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    timeout: 10000
                }
            );

            if (validationResponse.data !== 'VALID') {
                console.error('PayFast validation failed:', validationResponse.data);
                if (!acknowledged) {
                    res.status(400).send('Validation failed');
                    acknowledged = true;
                }
                return;
            }
        } catch (validationError) {
            console.error('Validation error:', validationError.message);
            if (!acknowledged) {
                res.status(400).send('Validation error');
                acknowledged = true;
            }
            return;
        }

        // 3. Send 200 immediately to PayFast
        if (!acknowledged) {
            res.status(200).send('OK');
            acknowledged = true;
        }

        // 4. Process the payment
        const bookingId = pfData.m_payment_id;
        const paymentStatus = pfData.payment_status;

        if (!firebaseInitialized) {
            console.error('Firebase not initialized');
            return;
        }

        const db = admin.firestore();
        const bookingRef = db.collection('bookings').doc(bookingId);
        const bookingDoc = await bookingRef.get();

        if (!bookingDoc.exists) {
            console.error(`Booking ${bookingId} not found`);
            return;
        }

        const bookingData = bookingDoc.data();
        const expectedAmount = bookingData.amount;

        // ✅ Validate amount
        const amountGross = parseFloat(pfData.amount_gross);
        const expectedAmountFloat = parseFloat(expectedAmount);

        if (Math.abs(amountGross - expectedAmountFloat) > 0.01) {
            console.error(`Amount mismatch: Expected ${expectedAmountFloat}, Received ${amountGross}`);

            await bookingRef.update({
                status: 'failed',
                paymentStatus: 'AMOUNT_MISMATCH',
                itnData: pfData,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            return;
        }

        // Update booking
        const updateData = {
            status: paymentStatus === 'COMPLETE' ? 'confirmed' : 'failed',
            paymentStatus: paymentStatus,
            itnData: pfData,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (paymentStatus === 'COMPLETE') {
            updateData.confirmedAt = admin.firestore.FieldValue.serverTimestamp();
            updateData.confirmedAmount = pfData.amount_gross;
            updateData.payfastTransactionId = pfData.pf_payment_id;
        }

        await bookingRef.update(updateData);

        console.log(`Booking ${bookingId} updated to: ${paymentStatus}`);

    } catch (error) {
        console.error('ITN processing error:', error);
        if (!acknowledged) {
            res.status(500).send('Server error');
        }
    }
});

// Check status endpoint
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

        const response = {
            success: true,
            bookingId: bookingId,
            status: bookingData.status || 'pending',
            paymentStatus: bookingData.paymentStatus || 'PENDING',
            amount: bookingData.amount,
            ticketNumber: bookingData.ticketNumber,
            eventName: bookingData.eventName,
            ticketQuantity: bookingData.ticketQuantity,
            customer: bookingData.customer,
            itnData: bookingData.itnData || null,
            createdAt: bookingData.createdAt?.toDate?.() || bookingData.createdAt,
            confirmedAt: bookingData.confirmedAt?.toDate?.() || bookingData.confirmedAt
        };

        res.json(response);

    } catch (error) {
        console.error('Check status error:', error);
        res.status(500).json({
            success: false,
            message: 'Error checking status'
        });
    }
});

// Return URL handler (optional)
app.post('/payment-return', async (req, res) => {
    try {
        const { m_payment_id } = req.body;

        if (m_payment_id) {
            // You can redirect to a success page or return JSON
            res.json({
                success: true,
                message: 'Payment return received',
                bookingId: m_payment_id
            });
        } else {
            res.json({
                success: false,
                message: 'No payment ID received'
            });
        }
    } catch (error) {
        console.error('Payment return error:', error);
        res.status(500).json({
            success: false,
            message: 'Error processing return'
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`💰 PayFast mode: ${PAYFAST_CONFIG.sandbox ? 'SANDBOX' : 'LIVE'}`);
    console.log(`🔗 Process URL: ${PAYFAST_CONFIG.processUrl}`);
    console.log(`🔐 Merchant ID: ${PAYFAST_CONFIG.merchant.id}`);
    console.log(`📢 Health check: http://localhost:${PORT}/health`);
    console.log(`⚠️ SECURITY: Amount fixed at R150/ticket, calculated on backend`);
});