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

// Generate PayFast signature
function generateSignature(data, passphrase = '') {
    let pfOutput = '';
    for (const key in data) {
        if (key === 'signature') continue;
        if (data[key] !== undefined && data[key] !== '' && data[key] !== null) {
            pfOutput += `${key}=${encodeURIComponent(data[key].toString().trim())}&`;
        }
    }
    pfOutput = pfOutput.slice(0, -1);

    if (passphrase) {
        pfOutput += `&passphrase=${encodeURIComponent(passphrase.trim())}`;
    }

    return crypto.createHash('md5').update(pfOutput).digest('hex');
}

// Verify ITN signature
function verifyITNSignature(pfData, passphrase = '') {
    const keys = Object.keys(pfData)
        .filter(k => k !== 'signature')
        .sort();

    let pfParamString = '';
    for (const key of keys) {
        if (pfData[key] !== undefined && pfData[key] !== '' && pfData[key] !== null) {
            pfParamString += `${key}=${encodeURIComponent(pfData[key].toString().trim())}&`;
        }
    }
    pfParamString = pfParamString.slice(0, -1);

    if (passphrase) {
        pfParamString += `&passphrase=${encodeURIComponent(passphrase.trim())}`;
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
            merchantId: PAYFAST_CONFIG.merchant.id ? 'configured' : 'missing'
        }
    });
});

// ✅ NEW: Generate Onsite Payment Identifier
app.post('/generate-payment-uuid', async (req, res) => {
    try {
        const {
            amount,
            item_name,
            item_description,
            name_first,
            name_last,
            email_address,
            cell_number,
            eventId,
            ticketQuantity,
            discount,
            addons,
            emergencyContact
        } = req.body;

        // Validate required fields
        if (!amount || !item_name || !email_address || !name_first) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: amount, item_name, email_address, and name_first are required'
            });
        }

        // Generate booking ID
        const bookingId = generateBookingId();
        const ticketNumber = 'TICKET-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 6).toUpperCase();

        // Prepare PayFast payload for Onsite
        const payfastData = {
            merchant_id: PAYFAST_CONFIG.merchant.id,
            merchant_key: PAYFAST_CONFIG.merchant.key,
            return_url: '', // Leave empty for onsite modal
            cancel_url: '', // Leave empty for onsite modal
            notify_url: PAYFAST_CONFIG.notifyUrl,
            name_first: name_first.substring(0, 100),
            name_last: (name_last || '').substring(0, 100),
            email_address: email_address.substring(0, 100),
            cell_number: (cell_number || '').substring(0, 100),
            m_payment_id: bookingId,
            amount: parseFloat(amount).toFixed(2),
            item_name: item_name.substring(0, 100),
            item_description: (item_description || item_name).substring(0, 255),
            custom_str1: eventId || '',
            custom_str2: `Tickets: ${ticketQuantity || 1}`,
            custom_str3: JSON.stringify({
                discount: discount || null,
                addons: addons || [],
                emergencyContact: emergencyContact || null
            }),
            custom_int1: parseInt(ticketQuantity) || 1,
            email_confirmation: '1',
            confirmation_address: email_address
        };

        // Generate signature
        const signature = generateSignature(payfastData, PAYFAST_CONFIG.merchant.passphrase);
        payfastData.signature = signature;

        // Convert to POST string
        let pfParamString = '';
        for (const key in payfastData) {
            if (payfastData[key] !== undefined && payfastData[key] !== '' && payfastData[key] !== null) {
                pfParamString += `${key}=${encodeURIComponent(payfastData[key].toString().trim())}&`;
            }
        }
        pfParamString = pfParamString.slice(0, -1);

        // Send to PayFast to get UUID
        console.log('Requesting UUID from PayFast...');

        const response = await axios.post(
            PAYFAST_CONFIG.onsiteProcessUrl,
            pfParamString,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Salwa Collective'
                },
                timeout: 15000
            }
        );

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
                eventName: item_name.replace('Salwa Event: ', ''),
                amount: parseFloat(amount).toFixed(2),
                ticketQuantity: ticketQuantity || 1,
                customer: {
                    firstName: name_first,
                    lastName: name_last || '',
                    email: email_address,
                    phone: cell_number || ''
                },
                discount: discount || null,
                addons: addons || [],
                emergencyContact: emergencyContact || null,

                // Payment data
                status: 'pending_payment',
                paymentMethod: 'payfast_onsite',
                payfastData: {
                    uuid: result.uuid,
                    signature: signature,
                    amount: parseFloat(amount).toFixed(2)
                },

                // Timestamps
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }

        res.json({
            success: true,
            uuid: result.uuid,
            bookingId: bookingId,
            ticketNumber: ticketNumber
        });

    } catch (error) {
        console.error('UUID generation error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to generate payment identifier',
            error: error.response?.data || error.message
        });
    }
});

// ✅ PayFast ITN endpoint (remains the same)
app.post('/payfast-notify', async (req, res) => {
    let acknowledged = false;

    try {
        console.log(`ITN request from IP: ${req.ip || req.connection.remoteAddress}`);
        const pfData = req.body;

        console.log('ITN received for booking:', pfData.m_payment_id);
        console.log('Payment status:', pfData.payment_status);

        // 1. Verify signature
        if (!verifyITNSignature(pfData, PAYFAST_CONFIG.merchant.passphrase)) {
            console.error('ITN signature mismatch for booking:', pfData.m_payment_id);
            if (!acknowledged) {
                res.status(400).send('Invalid signature');
                acknowledged = true;
            }
            return;
        }

        // 2. Validate with PayFast server
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

        // ✅ Send 200 immediately to PayFast
        if (!acknowledged) {
            res.status(200).send('OK');
            acknowledged = true;
        }

        // 3. Update booking in Firestore
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

        // Verify amount matches
        const amountGross = parseFloat(pfData.amount_gross);
        const expectedAmountFloat = parseFloat(expectedAmount);

        if (Math.abs(amountGross - expectedAmountFloat) > 0.01) {
            console.error(`Amount mismatch: Expected ${expectedAmountFloat}, Received ${amountGross}`);

            await bookingRef.update({
                status: 'failed',
                paymentStatus: 'AMOUNT_MISMATCH',
                payfastResponse: pfData,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return;
        }

        // Prepare update data
        const updateData = {
            status: paymentStatus === 'COMPLETE' ? 'confirmed' : 'failed',
            paymentStatus: paymentStatus,
            payfastResponse: pfData,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        // If payment is complete
        if (paymentStatus === 'COMPLETE') {
            updateData.confirmedAt = admin.firestore.FieldValue.serverTimestamp();
            updateData.confirmedAmount = pfData.amount_gross;
        }

        await bookingRef.update(updateData);

        console.log(`Booking ${bookingId} updated to status: ${paymentStatus}`);

    } catch (error) {
        console.error('ITN processing error:', error);
        if (!acknowledged) {
            res.status(500).send('Server error');
        }
    }
});

// ✅ Check status endpoint
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
            payfastResponse: bookingData.payfastResponse || null,
            createdAt: bookingData.createdAt?.toDate?.() || bookingData.createdAt,
            confirmedAt: bookingData.confirmedAt?.toDate?.() || bookingData.confirmedAt
        };

        // Map status for frontend compatibility
        if (response.status === 'confirmed') {
            response.status = 'CONFIRMED';
        } else if (response.status === 'failed') {
            response.status = 'FAILED';
        } else if (response.status === 'pending_payment') {
            response.status = 'PENDING';
        }

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
    console.log(`Server running on port ${PORT}`);
    console.log(`PayFast mode: ${PAYFAST_CONFIG.sandbox ? 'SANDBOX' : 'LIVE'}`);
    console.log(`Onsite payment URL: ${PAYFAST_CONFIG.onsiteProcessUrl}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});