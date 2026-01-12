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

// PayFast Configuration for Onsite Payments
const PAYFAST_CONFIG = {
    sandbox: process.env.PAYFAST_SANDBOX === 'true',
    baseUrl: process.env.PAYFAST_SANDBOX === 'true'
        ? 'https://sandbox.payfast.co.za'
        : 'https://www.payfast.co.za',
    merchant: {
        id: process.env.PAYFAST_MERCHANT_ID,
        key: process.env.PAYFAST_MERCHANT_KEY,
        passphrase: process.env.PAYFAST_PASSPHRASE || ''
    },
    onsiteProcessUrl: process.env.PAYFAST_SANDBOX === 'true'
        ? 'https://sandbox.payfast.co.za/onsite/process'
        : 'https://www.payfast.co.za/onsite/process',
    notifyUrl: process.env.PAYFAST_NOTIFY_URL || 'https://payfast-itn.onrender.com/payfast-notify'
};

// ✅ CORRECT SIGNATURE FUNCTION (ALPHABETICAL ORDER - FOR ALL PAYFAST REQUESTS!)
function generatePayFastSignature(data, passphrase = '') {
    // Create filtered object without empty/null fields and without signature
    const filtered = {};

    for (const key in data) {
        if (key === 'signature') continue;
        if (data[key] !== undefined && data[key] !== null && data[key] !== '') {
            filtered[key] = data[key];
        }
    }

    // ✅ ALPHABETICAL ORDER (REQUIRED by PayFast for ALL signatures)
    const keys = Object.keys(filtered).sort();

    let paramString = '';

    // Build parameter string in alphabetical order
    for (const key of keys) {
        paramString += `${key}=${encodeURIComponent(filtered[key].toString().trim()).replace(/%20/g, "+")}&`;
    }

    // Remove last '&'
    paramString = paramString.slice(0, -1);

    // ✅ Add passphrase ONLY for signature calculation (NOT for POST data)
    if (passphrase && passphrase.trim() !== '') {
        paramString += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, "+")}`;
    }

    console.log('🔍 Signature calculation string:', paramString);

    // Create MD5 hash
    const signature = crypto.createHash('md5').update(paramString).digest('hex');
    console.log('🔐 Generated signature:', signature);

    return signature;
}

// For ITN validation (also alphabetical)
function verifyITNSignature(pfData, passphrase = '') {
    const keys = Object.keys(pfData)
        .filter(k => k !== 'signature')
        .sort();

    let pfParamString = '';
    for (const key of keys) {
        if (pfData[key] !== undefined && pfData[key] !== '' && pfData[key] !== null) {
            pfParamString += `${key}=${encodeURIComponent(pfData[key].toString().trim()).replace(/%20/g, "+")}&`;
        }
    }
    pfParamString = pfParamString.slice(0, -1);

    if (passphrase && passphrase.trim() !== '') {
        pfParamString += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, "+")}`;
    }

    const calculatedSignature = crypto
        .createHash('md5')
        .update(pfParamString)
        .digest('hex');

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

// ✅ CORRECT: Generate Onsite Payment Identifier (SINGLE VERSION - REMOVE DUPLICATES!)
app.post('/generate-payment-uuid', async (req, res) => {
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

        // ✅ Prepare PayFast payload (CORRECT FIELDS ONLY - no email_confirmation!)
        const payfastData = {
            merchant_id: PAYFAST_CONFIG.merchant.id,
            merchant_key: PAYFAST_CONFIG.merchant.key,
            return_url: '', // Empty for onsite modal
            cancel_url: '', // Empty for onsite modal
            notify_url: PAYFAST_CONFIG.notifyUrl,
            name_first: (name_first || '').substring(0, 100),
            name_last: (name_last || '').substring(0, 100),
            email_address: email_address.substring(0, 100),
            cell_number: (cell_number || '').substring(0, 100),
            m_payment_id: bookingId,
            amount: calculatedAmount,
            item_name: (item_name || 'Salwa Event Ticket').substring(0, 100),
            item_description: `Salwa Collective Event: ${safeQuantity} ticket(s)`.substring(0, 255),
            custom_str1: eventId || '',
            custom_int1: safeQuantity
            // ❌ NO email_confirmation or confirmation_address for Onsite UUID!
        };

        console.log('📋 PayFast data for signature:', JSON.stringify(payfastData, null, 2));

        // Generate signature with CORRECT alphabetical order
        const signature = generatePayFastSignature(payfastData, PAYFAST_CONFIG.merchant.passphrase);

        // Add signature to data
        payfastData.signature = signature;

        // Convert to POST string (alphabetical order for POST too)
        let pfParamString = '';

        // Get all keys, sort alphabetically (including signature)
        const keys = Object.keys(payfastData).sort();

        for (const key of keys) {
            if (payfastData[key] !== undefined && payfastData[key] !== '' && payfastData[key] !== null) {
                pfParamString += `${key}=${encodeURIComponent(payfastData[key].toString().trim()).replace(/%20/g, "+")}&`;
            }
        }
        pfParamString = pfParamString.slice(0, -1);

        // ✅ NO PASSPHRASE IN POST DATA! Only in signature calculation
        console.log('📤 POST string (first 500 chars):', pfParamString.substring(0, 500));
        console.log('🚀 Sending to PayFast URL:', PAYFAST_CONFIG.onsiteProcessUrl);

        // Send to PayFast to get UUID
        const response = await axios.post(
            PAYFAST_CONFIG.onsiteProcessUrl,
            pfParamString,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Salwa Collective'
                },
                timeout: 20000
            }
        );

        console.log('✅ PayFast response:', response.data);

        const result = response.data;

        if (!result.uuid) {
            throw new Error('No UUID received from PayFast');
        }

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
                paymentMethod: 'payfast_onsite',
                payfastData: {
                    uuid: result.uuid,
                    signature: signature,
                    amount: calculatedAmount
                },
                calculatedAmount: calculatedAmount,
                pricePerTicket: PRICE_PER_TICKET,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }

        res.json({
            success: true,
            uuid: result.uuid,
            bookingId: bookingId,
            ticketNumber: ticketNumber,
            calculatedAmount: calculatedAmount
        });

    } catch (error) {
        console.error('❌ UUID generation error:', error.message);

        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);

            // Try to extract error message from PayFast HTML response
            let payfastError = 'Unknown PayFast error';
            if (error.response.data && typeof error.response.data === 'string') {
                // Try to extract error from HTML
                const match = error.response.data.match(/<strong>([^<]+):<\/strong>\s*([^<]+)/);
                if (match) {
                    payfastError = `${match[1]}: ${match[2]}`;
                } else if (error.response.data.includes('Generated signature does not match')) {
                    payfastError = 'Signature mismatch - check passphrase and field order';
                }
            }

            return res.status(400).json({
                success: false,
                message: 'PayFast rejected the request',
                error: payfastError,
                details: error.response.data
            });
        }

        res.status(500).json({
            success: false,
            message: 'Failed to generate payment identifier',
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

        // 1. Verify signature (alphabetical for ITN)
        if (!verifyITNSignature(pfData, PAYFAST_CONFIG.merchant.passphrase)) {
            console.error('ITN signature mismatch');
            if (!acknowledged) {
                res.status(400).send('Invalid signature');
                acknowledged = true;
            }
            return;
        }

        // ✅ REQUIRED: Validate with PayFast
        try {
            const validationUrl = `${PAYFAST_CONFIG.baseUrl}/eng/query/validate`;
            const validationResponse = await axios.post(
                validationUrl,
                qs.stringify(pfData),
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

        // ✅ Send 200 immediately to PayFast
        if (!acknowledged) {
            res.status(200).send('OK');
            acknowledged = true;
        }

        // Process the payment
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`💰 PayFast mode: ${PAYFAST_CONFIG.sandbox ? 'SANDBOX' : 'LIVE'}`);
    console.log(`🔗 Onsite URL: ${PAYFAST_CONFIG.onsiteProcessUrl}`);
    console.log(`🔐 Merchant ID: ${PAYFAST_CONFIG.merchant.id}`);
    console.log(`📢 Health check: http://localhost:${PORT}/health`);
    console.log(`⚠️ SECURITY: Amount fixed at R150/ticket, calculated on backend`);
});