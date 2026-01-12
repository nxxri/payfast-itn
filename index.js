const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios');
const querystring = require('querystring');
const crypto = require('crypto');

const app = express();

// Parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));
// Parse application/json
app.use(bodyParser.json());

// CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// Initialize Firebase using environment variable from Render
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const bookingsCollection = 'bookings';

// PayFast configuration from environment variables
const PAYFAST_CONFIG = {
    merchantId: process.env.PAYFAST_MERCHANT_ID || '10044213',
    merchantKey: process.env.PAYFAST_MERCHANT_KEY || '9s7vajpkdyycf',
    passphrase: process.env.PAYFAST_PASSPHRASE || 'Salwa20242024',
    sandbox: process.env.PAYFAST_SANDBOX === 'true',
    pricePerTicket: parseFloat(process.env.TICKET_PRICE) || 150
};

// Use sandbox or live URL based on environment
const PAYFAST_URL = PAYFAST_CONFIG.sandbox
    ? 'https://sandbox.payfast.co.za'
    : 'https://www.payfast.co.za';

// Validate PayFast signature
function validatePayFastSignature(data, passphrase) {
    // Create parameter string for signature validation
    let pfParamString = '';

    // Sort the data keys alphabetically
    const sortedKeys = Object.keys(data).sort();

    sortedKeys.forEach(key => {
        // Skip the signature itself and empty values
        if (key === 'signature' || data[key] === '' || data[key] === undefined) {
            return;
        }

        // Add to parameter string
        pfParamString += `${key}=${encodeURIComponent(data[key]).replace(/%20/g, '+')}&`;
    });

    // Remove the last '&'
    pfParamString = pfParamString.slice(0, -1);

    // Add passphrase if provided
    if (passphrase && passphrase.trim() !== '') {
        pfParamString += `&passphrase=${encodeURIComponent(passphrase).replace(/%20/g, '+')}`;
    }

    // Calculate MD5 hash
    const calculatedSignature = crypto.createHash('md5').update(pfParamString).digest('hex');
    const receivedSignature = data.signature || '';

    console.log('Calculated signature:', calculatedSignature);
    console.log('Received signature:', receivedSignature);

    return calculatedSignature === receivedSignature;
}

// Verify ITN with PayFast
async function verifyITNWithPayFast(data) {
    try {
        // Forward data to PayFast for validation
        const response = await axios.post(
            `${PAYFAST_URL}/eng/query/validate`,
            querystring.stringify(data),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'SalwaCollective/1.0'
                },
                timeout: 10000 // 10 second timeout
            }
        );

        console.log('PayFast validation response:', response.data);
        return response.data === 'VALID';
    } catch (error) {
        console.error('Error verifying ITN with PayFast:', error.message);
        return false;
    }
}

// Update booking status in Firestore
async function updateBookingStatus(bookingId, paymentData) {
    try {
        const bookingRef = db.collection(bookingsCollection).doc(bookingId);
        const bookingDoc = await bookingRef.get();

        if (!bookingDoc.exists) {
            console.error(`Booking ${bookingId} not found in Firestore`);
            return false;
        }

        // Determine payment status
        let status = 'pending';
        let paymentStatus = paymentData.payment_status;

        if (paymentStatus === 'COMPLETE') {
            status = 'paid';
        } else if (paymentStatus === 'FAILED' || paymentStatus === 'CANCELLED') {
            status = 'failed';
        } else if (paymentStatus === 'PENDING') {
            status = 'pending';
        }

        // Update booking with payment details
        const updateData = {
            paymentStatus: status,
            payfastData: {
                paymentId: paymentData.pf_payment_id,
                amountGross: paymentData.amount_gross,
                amountFee: paymentData.amount_fee,
                amountNet: paymentData.amount_net,
                payerEmail: paymentData.email_address,
                payerName: `${paymentData.name_first || ''} ${paymentData.name_last || ''}`.trim(),
                transactionDate: paymentData.payment_date || new Date().toISOString(),
                paymentStatus: paymentStatus,
                customData: {
                    eventId: paymentData.custom_str1,
                    ticketQuantity: parseInt(paymentData.custom_int1) || 1
                }
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        // If payment is complete, update booking status
        if (status === 'paid') {
            updateData.status = 'confirmed';
            updateData.confirmedAt = admin.firestore.FieldValue.serverTimestamp();

            // Optionally update event available spots
            const eventId = paymentData.custom_str1;
            if (eventId) {
                const eventRef = db.collection('events').doc(eventId);
                await eventRef.update({
                    'stats.confirmedBookings': admin.firestore.FieldValue.increment(1),
                    'stats.totalRevenue': admin.firestore.FieldValue.increment(parseFloat(paymentData.amount_gross) || 0)
                });
            }
        }

        await bookingRef.update(updateData);
        console.log(`Booking ${bookingId} updated to status: ${status}`);
        return true;

    } catch (error) {
        console.error(`Error updating booking ${bookingId}:`, error);
        return false;
    }
}

// Send confirmation email (you can integrate with your email service)
async function sendConfirmationEmail(bookingId, customerEmail, eventDetails) {
    // This is a placeholder. Implement with your email service (SendGrid, Mailgun, etc.)
    console.log(`Would send confirmation email for booking ${bookingId} to ${customerEmail}`);
    // Implement your email logic here
    return true;
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'Salwa PayFast ITN Handler',
        environment: PAYFAST_CONFIG.sandbox ? 'sandbox' : 'production'
    });
});

// Test endpoint for manual ITN simulation
app.post('/test-itn', async (req, res) => {
    if (process.env.NODE_ENV !== 'development') {
        return res.status(403).json({ error: 'Test endpoint only available in development' });
    }

    const testData = {
        m_payment_id: req.body.bookingId || `TEST-${Date.now()}`,
        pf_payment_id: '1234567890',
        payment_status: 'COMPLETE',
        item_name: 'Test Event Booking',
        amount_gross: '150.00',
        amount_fee: '5.00',
        amount_net: '145.00',
        email_address: 'test@example.com',
        name_first: 'Test',
        name_last: 'User',
        custom_str1: req.body.eventId || 'test-event',
        custom_int1: '1'
    };

    // Process the test ITN
    await handleITN(testData);

    res.json({
        message: 'Test ITN processed',
        data: testData
    });
});

// PayFast ITN endpoint
app.post('/payfast-notify', async (req, res) => {
    console.log('Received ITN callback:', req.body);

    const data = req.body;

    try {
        // Step 1: Validate PayFast signature
        if (!validatePayFastSignature(data, PAYFAST_CONFIG.passphrase)) {
            console.error('Invalid PayFast signature');
            return res.status(400).send('INVALID SIGNATURE');
        }

        // Step 2: Verify with PayFast
        const isValid = await verifyITNWithPayFast(data);

        if (!isValid) {
            console.error('PayFast validation failed');
            return res.status(400).send('INVALID ITN');
        }

        // Step 3: Process the payment
        const bookingId = data.m_payment_id;
        const paymentStatus = data.payment_status;

        console.log(`Processing payment for booking ${bookingId}, status: ${paymentStatus}`);

        // Update Firestore
        const updated = await updateBookingStatus(bookingId, data);

        if (!updated) {
            console.error(`Failed to update booking ${bookingId}`);
            return res.status(500).send('UPDATE FAILED');
        }

        // Step 4: Send confirmation if payment is complete
        if (paymentStatus === 'COMPLETE') {
            // Get booking details for email
            const bookingRef = db.collection(bookingsCollection).doc(bookingId);
            const bookingDoc = await bookingRef.get();

            if (bookingDoc.exists) {
                const bookingData = bookingDoc.data();
                await sendConfirmationEmail(
                    bookingId,
                    data.email_address,
                    {
                        eventName: bookingData.eventName,
                        ticketQuantity: bookingData.ticketQuantity,
                        totalAmount: data.amount_gross
                    }
                );
            }
        }

        // Step 5: Respond to PayFast
        console.log(`Successfully processed ITN for booking ${bookingId}`);
        res.status(200).send('OK');

    } catch (error) {
        console.error('Error processing ITN:', error);

        // Log detailed error for debugging
        const errorLog = {
            timestamp: new Date().toISOString(),
            error: error.message,
            stack: error.stack,
            data: data
        };

        // Store error in Firestore for debugging
        try {
            await db.collection('payment_errors').add(errorLog);
        } catch (logError) {
            console.error('Failed to log error:', logError);
        }

        // Still respond OK to PayFast (they'll retry if needed)
        res.status(200).send('ERROR LOGGED');
    }
});

// Optional: Webhook to check payment status
app.post('/check-payment/:bookingId', async (req, res) => {
    try {
        const bookingId = req.params.bookingId;
        const bookingRef = db.collection(bookingsCollection).doc(bookingId);
        const bookingDoc = await bookingRef.get();

        if (!bookingDoc.exists) {
            return res.status(404).json({ error: 'Booking not found' });
        }

        const bookingData = bookingDoc.data();
        res.json({
            bookingId: bookingId,
            status: bookingData.status || 'pending',
            paymentStatus: bookingData.paymentStatus || 'pending',
            eventName: bookingData.eventName,
            ticketQuantity: bookingData.ticketQuantity,
            amount: bookingData.amount,
            createdAt: bookingData.createdAt?.toDate()?.toISOString(),
            updatedAt: bookingData.updatedAt?.toDate()?.toISOString()
        });

    } catch (error) {
        console.error('Error checking payment:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Optional: Manual status update endpoint (for admin use)
app.post('/update-payment-status', async (req, res) => {
    try {
        const { bookingId, status, adminKey } = req.body;

        // Simple admin authentication (use a better method in production)
        if (adminKey !== process.env.ADMIN_KEY) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const bookingRef = db.collection(bookingsCollection).doc(bookingId);
        await bookingRef.update({
            status: status,
            paymentStatus: status,
            manuallyUpdated: true,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({
            success: true,
            message: `Booking ${bookingId} updated to ${status}`
        });

    } catch (error) {
        console.error('Error updating payment status:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Salwa PayFast ITN Handler running on port ${port}`);
    console.log(`Environment: ${PAYFAST_CONFIG.sandbox ? 'SANDBOX' : 'PRODUCTION'}`);
    console.log(`Merchant ID: ${PAYFAST_CONFIG.merchantId}`);
    console.log(`Health check: http://localhost:${port}/health`);
});