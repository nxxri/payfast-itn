const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
const axios = require('axios');
const qs = require('querystring');
require('dotenv').config();

const app = express();

// ✅ Correct middleware order for PayFast ITN parsing
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// CORS configuration
app.use(cors({
    origin: ['https://salwacollective.co.za', 'http://localhost:3000'],
    credentials: true // Keep this since frontend may use cookies later
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
        console.log('Firebase Admin initialized from JSON string');
    }
} catch (error) {
    console.error('Firebase Admin initialization error:', error.message);
}

// PayFast Configuration
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
    returnUrl: process.env.PAYFAST_RETURN_URL || 'https://salwacollective.co.za/payment-result.html',
    cancelUrl: process.env.PAYFAST_CANCEL_URL || 'https://salwacollective.co.za/payment-result.html?cancelled=true',
    notifyUrl: process.env.PAYFAST_NOTIFY_URL || 'https://payfast-itn.onrender.com/payfast-notify'
};

// Generate PayFast signature for INITIAL payment request
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

    if (process.env.NODE_ENV !== 'production') {
        console.log('Signature string (dev only):', pfOutput.substring(0, 100) + '...');
    }

    return crypto.createHash('md5').update(pfOutput).digest('hex');
}

// Verify ITN signature (PayFast requires alphabetical order)
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

// ✅ Health check endpoint
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

// ✅ Process payment endpoint
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

        const formattedAmount = parseFloat(amount).toFixed(2);

        // Prepare PayFast payload
        const payfastData = {
            merchant_id: PAYFAST_CONFIG.merchant.id,
            merchant_key: PAYFAST_CONFIG.merchant.key,
            return_url: `${PAYFAST_CONFIG.returnUrl}?booking_id=${bookingId}&status=success`,
            cancel_url: `${PAYFAST_CONFIG.cancelUrl}?booking_id=${bookingId}&status=cancelled`,
            notify_url: PAYFAST_CONFIG.notifyUrl,
            name_first: customer.firstName.substring(0, 100),
            name_last: customer.lastName.substring(0, 100),
            email_address: customer.email.substring(0, 100),
            cell_number: customer.phone?.substring(0, 100) || '',
            m_payment_id: bookingId,
            amount: formattedAmount,
            item_name: `Salwa Event: ${eventName}`.substring(0, 100),
            item_description: `Ticket for ${eventName} on ${eventDate}`.substring(0, 255),
            custom_str1: eventId,
            custom_str2: ticketNumber,
            custom_str3: JSON.stringify({
                discount,
                addons,
                emergencyContact
            }),
            custom_int1: ticketQuantity,
            email_confirmation: '1',
            confirmation_address: customer.email
        };

        const signature = generateSignature(payfastData, PAYFAST_CONFIG.merchant.passphrase);
        payfastData.signature = signature;

        // Store booking in Firestore as pending
        if (firebaseInitialized) {
            const db = admin.firestore();
            const bookingRef = db.collection('bookings').doc(bookingId);

            await bookingRef.set({
                // Store ALL original booking data
                bookingId,
                eventId,
                eventName,
                eventDate,
                ticketNumber,
                amount: formattedAmount,
                ticketQuantity,
                customer,
                discount,
                addons,
                emergencyContact,

                // Payment status
                status: 'pending_payment',
                paymentGateway: 'payfast',

                // PayFast data
                payfastData: {
                    amount: formattedAmount,
                    itemName: payfastData.item_name,
                    signature: signature,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                },

                // Timestamps
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }

        // Return the redirect URL
        const redirectUrl = `${PAYFAST_CONFIG.baseUrl}/eng/process`;

        res.json({
            success: true,
            redirectUrl: redirectUrl,
            bookingId: bookingId
        });

    } catch (error) {
        console.error('Payment processing error:', error);
        res.status(500).json({
            success: false,
            message: 'Payment processing failed'
        });
    }
});

// ✅ PayFast ITN endpoint (CRITICAL - main validation)
app.post('/payfast-notify', async (req, res) => {
    let acknowledged = false;

    try {
        console.log(`ITN request from IP: ${req.ip || req.connection.remoteAddress}`);
        const pfData = req.body;

        // Log minimal ITN data
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

        // 🔒 CRITICAL: Verify amount matches
        const amountGross = parseFloat(pfData.amount_gross);
        const expectedAmountFloat = parseFloat(expectedAmount);

        if (Math.abs(amountGross - expectedAmountFloat) > 0.01) {
            console.error(`Amount mismatch: Expected ${expectedAmountFloat}, Received ${amountGross}`);

            await bookingRef.update({
                status: 'failed',
                paymentStatus: 'AMOUNT_MISMATCH',
                payfastResponse: {
                    pfPaymentId: pfData.pf_payment_id,
                    amountGross: pfData.amount_gross,
                    amountFee: pfData.amount_fee,
                    amountNet: pfData.amount_net,
                    expectedAmount: expectedAmount,
                    timestamp: new Date().toISOString()
                },
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return;
        }

        // ✅ Prepare update data matching frontend expectations
        const updateData = {
            status: paymentStatus === 'COMPLETE' ? 'confirmed' : 'failed',
            paymentStatus: paymentStatus,

            // ✅ Store full PayFast response as frontend expects
            payfastResponse: {
                pfPaymentId: pfData.pf_payment_id,
                amountGross: pfData.amount_gross,
                amountFee: pfData.amount_fee,
                amountNet: pfData.amount_net,
                // Include other relevant PayFast fields
                paymentStatus: pfData.payment_status,
                itemName: pfData.item_name,
                itemDescription: pfData.item_description,
                nameFirst: pfData.name_first,
                nameLast: pfData.name_last,
                emailAddress: pfData.email_address,
                timestamp: new Date().toISOString()
            },

            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        // If payment is complete
        if (paymentStatus === 'COMPLETE') {
            updateData.confirmedAt = admin.firestore.FieldValue.serverTimestamp();
            updateData.confirmedAmount = pfData.amount_gross;

            // Update signature
            await bookingRef.update({
                'payfastData.signature': pfData.signature
            });
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

// ✅ CHECK-STATUS ENDPOINT (CRITICAL - must match frontend expectations)
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

        // ✅ Return EXACT format that frontend expects
        const response = {
            success: true,
            bookingId: bookingId,
            status: bookingData.status || 'pending',
            paymentStatus: bookingData.paymentStatus || 'PENDING',
            amount: bookingData.amount,
            ticketNumber: bookingData.ticketNumber,
            eventName: bookingData.eventName,
            eventDate: bookingData.eventDate,
            ticketQuantity: bookingData.ticketQuantity,

            // ✅ Include customer data as frontend expects
            customer: {
                email: bookingData.customer?.email,
                firstName: bookingData.customer?.firstName,
                lastName: bookingData.customer?.lastName,
                phone: bookingData.customer?.phone
            },

            // ✅ Include payfastResponse exactly as stored
            payfastResponse: bookingData.payfastResponse || null,

            // Timestamps
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

// ✅ Payment return handler
app.get('/payment-return', async (req, res) => {
    try {
        const { booking_id, status } = req.query;

        if (!booking_id) {
            return res.redirect('https://salwacollective.co.za/payment-result.html?error=no_booking_id');
        }

        const redirectUrl = `https://salwacollective.co.za/payment-result.html?booking_id=${booking_id}&status=${status}`;
        res.redirect(redirectUrl);

    } catch (error) {
        console.error('Payment return error:', error);
        res.redirect('https://salwacollective.co.za/payment-result.html?error=server_error');
    }
});

// ✅ Get booking by ID (optional, for admin/testing)
app.get('/booking/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (!firebaseInitialized) {
            return res.status(500).json({
                success: false,
                message: 'Database not available'
            });
        }

        const db = admin.firestore();
        const bookingRef = db.collection('bookings').doc(id);
        const bookingDoc = await bookingRef.get();

        if (!bookingDoc.exists) {
            return res.status(404).json({
                success: false,
                message: 'Booking not found'
            });
        }

        res.json({
            success: true,
            booking: bookingDoc.data()
        });

    } catch (error) {
        console.error('Get booking error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching booking'
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`PayFast mode: ${PAYFAST_CONFIG.sandbox ? 'SANDBOX' : 'LIVE'}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`ITN endpoint: ${PAYFAST_CONFIG.notifyUrl}`);
    console.log(`Check-status endpoint: POST http://localhost:${PORT}/check-status`);
});