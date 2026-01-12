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

// PayFast allowed IPs for ITN validation (production IPs from PayFast docs)
const PAYFAST_IP_RANGES = [
    '197.97.0.0/16',    // Main PayFast IP range
    '41.74.179.0/24',   // Additional PayFast IPs
    '41.74.180.0/24'
];

// Function to check if IP is from PayFast
function isPayFastIP(ip) {
    if (!ip || PAYFAST_CONFIG.sandbox) {
        // In sandbox mode or if no IP, we'll rely on the validate call
        return true;
    }

    // Convert IP to number for comparison
    const ipToNum = (ip) => {
        return ip.split('.').reduce((int, oct) => (int << 8) + parseInt(oct, 10), 0) >>> 0;
    };

    const ipNum = ipToNum(ip);

    // Check each IP range
    for (const range of PAYFAST_IP_RANGES) {
        const [subnet, bits] = range.split('/');
        const mask = ~((1 << (32 - parseInt(bits))) - 1);
        const subnetNum = ipToNum(subnet);

        if ((ipNum & mask) === (subnetNum & mask)) {
            return true;
        }
    }

    return false;
}

// ✅ FIXED: Generate PayFast signature according to PayFast documentation
function generateSignature(data, passphrase = '') {
    // Create an array to hold the key-value pairs
    let pfParamString = '';

    // Sort the keys alphabetically (REQUIRED by PayFast)
    const keys = Object.keys(data).sort();

    // Build the parameter string
    for (const key of keys) {
        // Skip signature field
        if (key === 'signature') continue;

        // Only include if value is not null, undefined, or empty string
        if (data[key] !== undefined && data[key] !== '' && data[key] !== null) {
            pfParamString += `${key}=${encodeURIComponent(data[key].toString().trim()).replace(/%20/g, "+")}&`;
        }
    }

    // Remove the last '&'
    pfParamString = pfParamString.slice(0, -1);

    // Add passphrase if provided (MUST BE ENCODED)
    if (passphrase && passphrase.trim() !== '') {
        pfParamString += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, "+")}`;
    }

    // Create MD5 hash
    return crypto.createHash('md5').update(pfParamString).digest('hex');
}

// Verify ITN signature (same logic as generateSignature but for verification)
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
            merchantId: PAYFAST_CONFIG.merchant.id ? 'configured' : 'missing'
        }
    });
});

// ✅ SECURITY FIXED: Generate Onsite Payment Identifier with amount calculated on backend
app.post('/generate-payment-uuid', async (req, res) => {
    try {
        const {
            item_name,
            item_description,
            name_first,
            name_last,
            email_address,
            cell_number,
            eventId,
            ticketQuantity
        } = req.body;

        console.log('Received payment request:', req.body);

        // Validate required fields
        if (!email_address || !name_first || !ticketQuantity) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: email_address, name_first, and ticketQuantity are required'
            });
        }

        // ✅ SECURITY FIX: Calculate amount on backend (NEVER trust frontend)
        const PRICE_PER_TICKET = 150; // R150 per ticket
        const safeQuantity = Math.max(1, Math.min(parseInt(ticketQuantity) || 1, 5)); // Max 5 tickets
        const calculatedAmount = (PRICE_PER_TICKET * safeQuantity).toFixed(2);

        console.log(`Calculated amount: R${calculatedAmount} (${safeQuantity} tickets × R${PRICE_PER_TICKET})`);

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
            amount: calculatedAmount, // ✅ Using backend-calculated amount
            item_name: (item_name || 'Salwa Event').substring(0, 100),
            item_description: (item_description || `Ticket purchase for Salwa Collective`).substring(0, 255),
            custom_str1: eventId || '',
            custom_str2: `Tickets: ${safeQuantity}`,
            custom_int1: safeQuantity,
            email_confirmation: '1',
            confirmation_address: email_address
        };

        console.log('PayFast data before signature:', payfastData);

        // Generate signature
        const signature = generateSignature(payfastData, PAYFAST_CONFIG.merchant.passphrase);
        payfastData.signature = signature;

        console.log('Generated signature:', signature);

        // Convert to POST string (as required by PayFast)
        let pfParamString = '';
        const keys = Object.keys(payfastData);

        for (const key of keys) {
            if (payfastData[key] !== undefined && payfastData[key] !== '' && payfastData[key] !== null) {
                pfParamString += `${key}=${encodeURIComponent(payfastData[key].toString().trim()).replace(/%20/g, "+")}&`;
            }
        }
        pfParamString = pfParamString.slice(0, -1);

        console.log('Sending to PayFast URL:', PAYFAST_CONFIG.onsiteProcessUrl);

        // Send to PayFast to get UUID
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

        console.log('PayFast response:', response.data);

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
                eventName: item_name ? item_name.replace('Salwa Event: ', '') : 'Salwa Event',
                amount: calculatedAmount, // ✅ Store backend-calculated amount
                ticketQuantity: safeQuantity,
                customer: {
                    firstName: name_first,
                    lastName: name_last || '',
                    email: email_address,
                    phone: cell_number || ''
                },
                // Payment data
                status: 'pending_payment',
                paymentMethod: 'payfast_onsite',
                payfastData: {
                    uuid: result.uuid,
                    signature: signature,
                    amount: calculatedAmount
                },
                // Security info
                calculatedAmount: calculatedAmount,
                pricePerTicket: PRICE_PER_TICKET,
                // Timestamps
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }

        res.json({
            success: true,
            uuid: result.uuid,
            bookingId: bookingId,
            ticketNumber: ticketNumber,
            calculatedAmount: calculatedAmount // Return for frontend verification
        });

    } catch (error) {
        console.error('UUID generation error:', error.response?.data || error.message);
        console.error('Error details:', error.response?.status, error.response?.statusText);

        // Log the actual PayFast error if available
        if (error.response && error.response.data) {
            console.error('PayFast error response:', error.response.data);
        }

        res.status(500).json({
            success: false,
            message: 'Failed to generate payment identifier',
            error: error.response?.data || error.message
        });
    }
});

// ✅ SECURITY FIXED: PayFast ITN endpoint with full validation
app.post('/payfast-notify', async (req, res) => {
    let acknowledged = false;

    try {
        const clientIP = req.ip || req.connection.remoteAddress;
        console.log(`ITN request from IP: ${clientIP}`);

        // ✅ SECURITY FIX: Validate PayFast IP (for production only)
        if (!PAYFAST_CONFIG.sandbox && !isPayFastIP(clientIP)) {
            console.error(`ITN rejected from non-PayFast IP: ${clientIP}`);
            if (!acknowledged) {
                res.status(403).send('Unauthorized');
                acknowledged = true;
            }
            return;
        }

        const pfData = req.body;

        console.log('ITN received for booking:', pfData.m_payment_id);
        console.log('Payment status:', pfData.payment_status);
        console.log('Amount gross:', pfData.amount_gross);

        // 1. Verify signature
        if (!verifyITNSignature(pfData, PAYFAST_CONFIG.merchant.passphrase)) {
            console.error('ITN signature mismatch for booking:', pfData.m_payment_id);
            if (!acknowledged) {
                res.status(400).send('Invalid signature');
                acknowledged = true;
            }
            return;
        }

        // ✅ SECURITY FIX: REQUIRED PayFast validate call
        try {
            const validationUrl = `${PAYFAST_CONFIG.baseUrl}/eng/query/validate`;
            console.log('Validating ITN with PayFast:', validationUrl);

            const validationResponse = await axios.post(
                validationUrl,
                qs.stringify(pfData),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': 'Salwa Collective ITN'
                    },
                    timeout: 10000
                }
            );

            console.log('PayFast validation response:', validationResponse.data);

            if (validationResponse.data !== 'VALID') {
                console.error('PayFast validation failed:', validationResponse.data);
                if (!acknowledged) {
                    res.status(400).send('Validation failed');
                    acknowledged = true;
                }
                return;
            }
        } catch (validationError) {
            console.error('PayFast validation error:', validationError.message);
            if (!acknowledged) {
                res.status(400).send('Validation error');
                acknowledged = true;
            }
            return;
        }

        // ✅ Send 200 immediately to PayFast (as per requirements)
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

        // ✅ SECURITY FIX: REQUIRED amount validation
        const amountGross = parseFloat(pfData.amount_gross);
        const expectedAmountFloat = parseFloat(expectedAmount);

        console.log(`Amount validation: ITN=${amountGross}, Expected=${expectedAmountFloat}`);

        if (Math.abs(amountGross - expectedAmountFloat) > 0.01) { // Allow small floating point differences
            console.error(`Amount mismatch for booking ${bookingId}: Expected ${expectedAmountFloat}, Received ${amountGross}`);

            // Mark as failed due to amount mismatch
            await bookingRef.update({
                status: 'failed',
                paymentStatus: 'AMOUNT_MISMATCH',
                itnReceived: pfData,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            return;
        }

        // Prepare update data
        const updateData = {
            status: paymentStatus === 'COMPLETE' ? 'confirmed' : 'failed',
            paymentStatus: paymentStatus,
            itnReceived: pfData,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        // If payment is complete
        if (paymentStatus === 'COMPLETE') {
            updateData.confirmedAt = admin.firestore.FieldValue.serverTimestamp();
            updateData.confirmedAmount = pfData.amount_gross;
            updateData.payfastTransactionId = pfData.pf_payment_id;
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
            itnReceived: bookingData.itnReceived || null,
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

// Webhook for payment status (optional, for real-time updates)
app.post('/payment-webhook', async (req, res) => {
    try {
        const { bookingId, status, transactionId } = req.body;

        if (!bookingId || !status) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        if (!firebaseInitialized) {
            return res.status(500).json({ success: false, message: 'Database not available' });
        }

        const db = admin.firestore();
        const bookingRef = db.collection('bookings').doc(bookingId);

        await bookingRef.update({
            paymentStatus: status,
            ...(transactionId && { payfastTransactionId: transactionId }),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true, message: 'Status updated' });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ success: false, message: 'Error updating status' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`💰 PayFast mode: ${PAYFAST_CONFIG.sandbox ? 'SANDBOX' : 'LIVE'}`);
    console.log(`🔐 Onsite payment URL: ${PAYFAST_CONFIG.onsiteProcessUrl}`);
    console.log(`🛡 ITN URL: ${PAYFAST_CONFIG.notifyUrl}`);
    console.log(`🏥 Health check: http://localhost:${PORT}/health`);
    console.log(`⚠️ SECURITY: Amount calculation is locked to R150 per ticket`);
});