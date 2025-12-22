const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const axios = require('axios');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();

// ========== MIDDLEWARE CONFIGURATION ==========
const allowedOrigins = process.env.FRONTEND_DOMAINS
    ? process.env.FRONTEND_DOMAINS.split(',')
    : ['https://salwacollective.co.za', 'http://localhost:5500'];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(helmet());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
    max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
    message: { error: 'Too many requests from this IP, please try again later.' }
});
app.use('/process-payment', limiter);
app.use('/payfast-notify', limiter);

// ========== FIREBASE INITIALIZATION ==========
let db;
try {
    const serviceAccount = {
        type: "service_account",
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID,
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
        client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL
    };
    // ✅ SINGLE initializeApp call
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });

    db = admin.firestore();
    console.log('✅ Firebase Admin SDK initialized successfully');
} catch (error) {
    console.error('❌ Firebase initialization error:', error);
    process.exit(1);
}

// ========== PAYFAST CONFIGURATION ==========
const IS_SANDBOX = process.env.PAYFAST_SANDBOX === 'true';
const PAYFAST_CONFIG = {
    merchantId: IS_SANDBOX ? process.env.PAYFAST_SANDBOX_MERCHANT_ID : process.env.PAYFAST_MERCHANT_ID,
    merchantKey: IS_SANDBOX ? process.env.PAYFAST_SANDBOX_MERCHANT_KEY : process.env.PAYFAST_MERCHANT_KEY,
    passphrase: process.env.PAYFAST_PASSPHRASE || '',
    baseUrl: IS_SANDBOX ? 'https://sandbox.payfast.co.za' : 'https://www.payfast.co.za',
    notifyUrl: `${process.env.BACKEND_URL || 'https://your-backend-url.onrender.com'}/payfast-notify`,
    returnUrl: `${process.env.FRONTEND_URL || 'https://salwacollective.co.za'}/payment-result.html?payment_return=1`,
    cancelUrl: `${process.env.FRONTEND_URL || 'https://salwacollective.co.za'}/payment-result.html?payment_return=1`
};

console.log('🔧 PayFast Config:', {
    mode: IS_SANDBOX ? 'SANDBOX' : 'LIVE',
    merchantId: PAYFAST_CONFIG.merchantId ? 'SET' : 'MISSING',
    notifyUrl: PAYFAST_CONFIG.notifyUrl
});

// ========== UTILITY FUNCTIONS ==========
class PayFastService {
    // Generate signature for redirect (documentation order)
    static generateRedirectSignature(data, passphrase = '') {
        const fields = [
            'merchant_id', 'merchant_key', 'return_url', 'cancel_url', 'notify_url',
            'name_first', 'name_last', 'email_address', 'cell_number',
            'm_payment_id', 'amount', 'item_name', 'item_description',
            'email_confirmation', 'confirmation_address'
        ];

        let signatureString = '';
        fields.forEach(field => {
            if (data[field] !== undefined && data[field] !== '') {
                signatureString += `${field}=${encodeURIComponent(data[field]).replace(/%20/g, '+')}&`;
            }
        });

        if (passphrase) {
            signatureString += `passphrase=${encodeURIComponent(passphrase)}`;
        } else {
            signatureString = signatureString.slice(0, -1);
        }

        return crypto.createHash('md5').update(signatureString).digest('hex');
    }

    // Generate signature for ITN (alphabetical order)
    static generateITNSignature(data, passphrase = '') {
        delete data.signature;

        const sortedKeys = Object.keys(data).sort();
        let signatureString = '';

        sortedKeys.forEach(key => {
            if (data[key] !== '') {
                signatureString += `${key}=${encodeURIComponent(data[key]).replace(/%20/g, '+')}&`;
            }
        });

        if (passphrase) {
            signatureString += `passphrase=${encodeURIComponent(passphrase)}`;
        } else {
            signatureString = signatureString.slice(0, -1);
        }

        return crypto.createHash('md5').update(signatureString).digest('hex');
    }

    // Validate ITN with PayFast server
    static async validateITN(pfData) {
        try {
            const response = await axios.post(`${PAYFAST_CONFIG.baseUrl}/eng/query/validate`, pfData, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });

            return response.data.trim() === 'VALID';
        } catch (error) {
            console.error('ITN validation error:', error);
            return false;
        }
    }
}

class FirebaseService {
    // Update booking status
    static async updateBookingStatus(bookingId, status, paymentData = {}) {
        try {
            const bookingRef = db.collection('bookings').doc(bookingId);
            const updateData = {
                status: status,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                ...paymentData
            };

            if (status === 'confirmed') {
                updateData.confirmedAt = admin.firestore.FieldValue.serverTimestamp();
            }

            await bookingRef.update(updateData);
            console.log(`✅ Booking ${bookingId} updated to status: ${status}`);

            // Update event spots if booking confirmed
            if (status === 'confirmed') {
                await FirebaseService.updateEventSpots(bookingId);
            }

            return true;
        } catch (error) {
            console.error('❌ Error updating booking:', error);
            throw error;
        }
    }

    // Update event spots when booking is confirmed
    static async updateEventSpots(bookingId) {
        try {
            const bookingRef = db.collection('bookings').doc(bookingId);
            const bookingDoc = await bookingRef.get();

            if (!bookingDoc.exists) {
                console.error('Booking not found:', bookingId);
                return;
            }

            const bookingData = bookingDoc.data();
            const eventId = bookingData.eventId;
            const ticketQuantity = bookingData.ticketQuantity || 1;

            console.log(`Updating spots for event ${eventId} (+${ticketQuantity})`);

            // Update the event's booked spots count
            const eventRef = db.collection('events').doc(eventId);
            await db.runTransaction(async (transaction) => {
                const eventDoc = await transaction.get(eventRef);

                if (!eventDoc.exists) {
                    console.error('Event not found:', eventId);
                    return;
                }

                const eventData = eventDoc.data();
                const currentBooked = eventData.bookedSpots || 0;
                const newBooked = currentBooked + ticketQuantity;
                const capacity = eventData.capacity || 30;

                // Ensure we don't exceed capacity
                const finalBooked = Math.min(newBooked, capacity);

                transaction.update(eventRef, {
                    bookedSpots: finalBooked,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                console.log(`✅ Event ${eventId} spots updated: ${currentBooked} -> ${finalBooked}/${capacity}`);
            });
        } catch (error) {
            console.error('❌ Error updating event spots:', error);
        }
    }

    // Get booking data
    static async getBooking(bookingId) {
        try {
            const bookingRef = db.collection('bookings').doc(bookingId);
            const bookingDoc = await bookingRef.get();

            if (!bookingDoc.exists) {
                return null;
            }

            return {
                id: bookingDoc.id,
                ...bookingDoc.data()
            };
        } catch (error) {
            console.error('Error getting booking:', error);
            throw error;
        }
    }
}

// ========== ROUTES ==========

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
            firebase: 'connected',
            payfast: {
                mode: IS_SANDBOX ? 'sandbox' : 'live',
                merchantId: PAYFAST_CONFIG.merchantId ? 'configured' : 'missing'
            }
        },
        config: {
            frontendUrl: process.env.FRONTEND_URL,
            backendUrl: process.env.BACKEND_URL,
            cors: allowedOrigins
        }
    });
});

// Process payment endpoint
app.post('/process-payment', async (req, res) => {
    try {
        const paymentData = req.body;

        // Validate required fields
        const requiredFields = [
            'amount', 'item_name', 'name_first', 'email_address',
            'event_id', 'booking_id', 'ticket_number', 'ticket_quantity'
        ];

        for (const field of requiredFields) {
            if (!paymentData[field]) {
                return res.status(400).json({
                    success: false,
                    message: `Missing required field: ${field}`
                });
            }
        }

        // Format amount to 2 decimals
        const amount = parseFloat(paymentData.amount).toFixed(2);

        // Prepare PayFast data
        const pfData = {
            merchant_id: PAYFAST_CONFIG.merchantId,
            merchant_key: PAYFAST_CONFIG.merchantKey,
            return_url: PAYFAST_CONFIG.returnUrl,
            cancel_url: PAYFAST_CONFIG.cancelUrl,
            notify_url: PAYFAST_CONFIG.notifyUrl,
            name_first: paymentData.name_first.substring(0, 100),
            name_last: (paymentData.name_last || '').substring(0, 100),
            email_address: paymentData.email_address,
            cell_number: (paymentData.cell_number || '').replace(/\D/g, '').substring(0, 10),
            m_payment_id: paymentData.booking_id,
            amount: amount,
            item_name: `Salwa Event: ${paymentData.item_name}`.substring(0, 100),
            item_description: `Ticket booking for ${paymentData.item_name}`.substring(0, 255),
            custom_str1: paymentData.event_id,
            custom_str2: paymentData.ticket_number,
            custom_str3: paymentData.booking_id,
            custom_int1: parseInt(paymentData.ticket_quantity),
            email_confirmation: '1',
            confirmation_address: paymentData.email_address
        };

        // Generate signature
        pfData.signature = PayFastService.generateRedirectSignature(pfData, PAYFAST_CONFIG.passphrase);

        // Create redirect URL
        const queryParams = new URLSearchParams();
        Object.keys(pfData).forEach(key => {
            if (pfData[key] !== '' && pfData[key] !== null && pfData[key] !== undefined) {
                queryParams.append(key, pfData[key]);
            }
        });

        const redirectUrl = `${PAYFAST_CONFIG.baseUrl}/eng/process?${queryParams.toString()}`;

        // Update booking status to pending
        try {
            await FirebaseService.updateBookingStatus(paymentData.booking_id, 'pending_payment');
        } catch (error) {
            console.warn('Could not update booking status, but continuing with payment:', error);
        }

        console.log(`✅ Payment initiated for booking ${paymentData.booking_id}, redirecting to PayFast`);

        res.json({
            success: true,
            redirectUrl: redirectUrl,
            bookingId: paymentData.booking_id,
            message: 'Payment initialized successfully'
        });

    } catch (error) {
        console.error('❌ Process payment error:', error);
        res.status(500).json({
            success: false,
            message: 'Payment processing failed',
            error: error.message
        });
    }
});

// PayFast ITN Notification Handler
app.post('/payfast-notify', async (req, res) => {
    console.log('📨 PayFast ITN received:', req.body);

    let pfData = { ...req.body };

    try {
        // Verify signature
        const receivedSignature = pfData.signature;
        const calculatedSignature = PayFastService.generateITNSignature(pfData, PAYFAST_CONFIG.passphrase);

        if (receivedSignature !== calculatedSignature) {
            console.error('❌ ITN signature mismatch');
            console.log('Received:', receivedSignature);
            console.log('Calculated:', calculatedSignature);
            return res.status(400).send('Signature mismatch');
        }

        // Validate ITN with PayFast server
        const isValid = await PayFastService.validateITN(pfData);

        if (!isValid) {
            console.error('❌ ITN validation failed');
            return res.status(400).send('ITN validation failed');
        }

        const paymentStatus = pfData.payment_status;
        const bookingId = pfData.custom_str3 || pfData.m_payment_id;

        console.log(`🔄 Processing ITN for booking ${bookingId}, status: ${paymentStatus}`);

        // Prepare payment data for Firestore
        const paymentData = {
            payfastPaymentId: pfData.pf_payment_id,
            paymentStatus: paymentStatus,
            amountGross: parseFloat(pfData.amount_gross || pfData.amount),
            amountFee: parseFloat(pfData.amount_fee || 0),
            amountNet: parseFloat(pfData.amount_net || pfData.amount),
            paymentDate: pfData.payment_date || new Date().toISOString(),
            transactionId: pfData.pf_payment_id,
            itnReceived: true
        };

        // Update booking based on payment status
        if (paymentStatus === 'COMPLETE') {
            await FirebaseService.updateBookingStatus(bookingId, 'confirmed', paymentData);
        } else if (['FAILED', 'CANCELLED'].includes(paymentStatus)) {
            await FirebaseService.updateBookingStatus(bookingId, 'failed', paymentData);
        } else {
            await FirebaseService.updateBookingStatus(bookingId, 'pending_verification', paymentData);
        }

        console.log(`✅ ITN processed for booking ${bookingId}, status: ${paymentStatus}`);

        // Return success to PayFast
        res.status(200).send('ITN received and processed');

    } catch (error) {
        console.error('❌ ITN processing error:', error);
        res.status(500).send('ITN processing error');
    }
});

// Check booking status endpoint
app.post('/check-payment-status', async (req, res) => {
    try {
        const { bookingId } = req.body;

        if (!bookingId) {
            return res.status(400).json({
                success: false,
                message: 'Booking ID is required'
            });
        }

        const booking = await FirebaseService.getBooking(bookingId);

        if (!booking) {
            return res.status(404).json({
                success: false,
                message: 'Booking not found'
            });
        }

        res.json({
            success: true,
            bookingId: bookingId,
            status: booking.status,
            paymentStatus: booking.paymentStatus,
            ticketNumber: booking.ticketNumber,
            eventId: booking.eventId,
            amount: booking.totalAmount,
            createdAt: booking.createdAt?.toDate()?.toISOString(),
            confirmedAt: booking.confirmedAt?.toDate()?.toISOString()
        });

    } catch (error) {
        console.error('Check status error:', error);
        res.status(500).json({
            success: false,
            message: 'Error checking payment status',
            error: error.message
        });
    }
});

// Get booking by ticket number
app.get('/booking/:ticketNumber', async (req, res) => {
    try {
        const { ticketNumber } = req.params;

        if (!ticketNumber) {
            return res.status(400).json({
                success: false,
                message: 'Ticket number is required'
            });
        }

        const snapshot = await db.collection('bookings')
            .where('ticketNumber', '==', ticketNumber)
            .limit(1)
            .get();

        if (snapshot.empty) {
            return res.status(404).json({
                success: false,
                message: 'Booking not found'
            });
        }

        const bookingDoc = snapshot.docs[0];
        const booking = {
            id: bookingDoc.id,
            ...bookingDoc.data()
        };

        // Convert Firestore timestamps
        if (booking.createdAt) {
            booking.createdAt = booking.createdAt.toDate().toISOString();
        }
        if (booking.confirmedAt) {
            booking.confirmedAt = booking.confirmedAt.toDate().toISOString();
        }

        res.json({
            success: true,
            booking: booking
        });

    } catch (error) {
        console.error('Get booking error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching booking',
            error: error.message
        });
    }
});

// Event spots endpoint
app.get('/event/:eventId/spots', async (req, res) => {
    try {
        const { eventId } = req.params;

        const eventRef = db.collection('events').doc(eventId);
        const eventDoc = await eventRef.get();

        if (!eventDoc.exists) {
            return res.status(404).json({
                success: false,
                message: 'Event not found'
            });
        }

        const eventData = eventDoc.data();
        const bookedSpots = eventData.bookedSpots || 0;
        const capacity = eventData.capacity || 30;
        const spotsLeft = Math.max(0, capacity - bookedSpots);

        res.json({
            success: true,
            eventId: eventId,
            bookedSpots: bookedSpots,
            capacity: capacity,
            spotsLeft: spotsLeft,
            isSoldOut: spotsLeft <= 0
        });

    } catch (error) {
        console.error('Get event spots error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching event spots',
            error: error.message
        });
    }
});

// ========== ERROR HANDLING ==========
app.use((req, res, next) => {
    res.status(404).json({
        success: false,
        message: 'Route not found'
    });
});

app.use((error, req, res, next) => {
    console.error('Server error:', error);
    res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
});

// ========== SERVER START ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
  🚀 Salwa PayFast Backend Server
  =================================
  ✅ Server running on port ${PORT}
  ✅ Environment: ${process.env.NODE_ENV || 'development'}
  ✅ PayFast Mode: ${IS_SANDBOX ? 'SANDBOX' : 'LIVE'}
  ✅ Firebase: Connected
  ✅ Frontend URLs: ${allowedOrigins.join(', ')}
  ✅ Health Check: http://localhost:${PORT}/health
  =================================
  `);
});

module.exports = app;