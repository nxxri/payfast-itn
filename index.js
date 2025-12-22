const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios');
const querystring = require('querystring');
const crypto = require('crypto');
const cors = require('cors');

const app = express();

// ===== 1. DATABASE & AUTH CONFIG =====
// Ensure your Render Environment Variable FIREBASE_KEY contains the full JSON
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY || '{}');
if (serviceAccount.project_id && !admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.apps.length ? admin.firestore() : null;

// ===== 2. PAYFAST SETTINGS (STRICT PRODUCTION CONFIG) =====
const PAYFAST_CONFIG = {
    merchantId: '32449257', // From your dashboard screenshot
    merchantKey: '4wkknlvwwll3x', // From your dashboard screenshot
    passphrase: 'Salwa20242024', // From your dashboard screenshot
    sandbox: process.env.PAYFAST_SANDBOX === 'true',
    urls: {
        process: "https://www.payfast.co.za/eng/process",
        sandbox: "https://sandbox.payfast.co.za/eng/process",
        validate: "https://www.payfast.co.za/eng/query/validate",
        sandboxValidate: "https://sandbox.payfast.co.za/eng/query/validate"
    }
};

// ===== 3. SECURE SIGNATURE ENGINE =====
class PayFastSecurity {
    /**
     * RULE 1: For Redirects, follow documentation field order exactly
     * spaces MUST be '+'
     */
    static createRedirectSignature(data, passphrase = '') {
        const fieldOrder = [
            'merchant_id', 'merchant_key', 'return_url', 'cancel_url', 'notify_url',
            'name_first', 'name_last', 'email_address', 'cell_number',
            'm_payment_id', 'amount', 'item_name', 'item_description',
            'custom_int1', 'custom_str1', 'email_confirmation', 'confirmation_address', 'payment_method'
        ];

        let pfOutput = '';
        for (let key of fieldOrder) {
            if (data[key] !== undefined && data[key] !== null && data[key].toString().trim() !== '') {
                if (key !== 'signature' && key !== 'merchant_key') {
                    // PayFast REQUIRES '+' for spaces in redirect signatures
                    const val = encodeURIComponent(data[key].toString().trim()).replace(/%20/g, '+');
                    pfOutput += `${key}=${val}&`;
                }
            }
        }

        pfOutput = pfOutput.slice(0, -1);
        if (passphrase) {
            pfOutput += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, '+')}`;
        }

        return crypto.createHash('md5').update(pfOutput).digest('hex');
    }

    /**
     * RULE 2: For ITN Webhooks, use Alphabetical Order
     */
    static verifyItnSignature(data, passphrase = '') {
        const submittedSignature = data.signature;
        const checkData = { ...data };
        delete checkData.signature;

        const sortedKeys = Object.keys(checkData).sort();
        let pfParamString = '';
        for (const key of sortedKeys) {
            const val = checkData[key];
            if (val !== undefined && val !== null && val !== '') {
                // ITN uses raw received values
                pfParamString += `${key}=${val}&`;
            }
        }

        pfParamString = pfParamString.slice(0, -1);
        if (passphrase) {
            pfParamString += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, '+')}`;
        }

        const calculated = crypto.createHash('md5').update(pfParamString).digest('hex');
        return calculated === submittedSignature;
    }
}

// ===== 4. MIDDLEWARE =====
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cors({
    origin: ["https://salwacollective.co.za", "https://www.salwacollective.co.za"],
    credentials: true
}));

// ===== 5. ROUTES =====

// ROUTE A: Create Secure Payment Link
app.post('/process-payment', async (req, res) => {
    try {
        const { amount, item_name, email_address, booking_id, name_first, name_last } = req.body;

        const paymentData = {
            merchant_id: PAYFAST_CONFIG.merchantId,
            merchant_key: PAYFAST_CONFIG.merchantKey,
            return_url: `https://salwacollective.co.za/payment-result.html?booking_id=${booking_id}`,
            cancel_url: `https://salwacollective.co.za/payment-result.html?cancelled=true&booking_id=${booking_id}`,
            notify_url: `https://${req.get('host')}/payfast-notify`,
            name_first: (name_first || '').trim(),
            name_last: (name_last || '').trim(),
            email_address: email_address.trim(),
            amount: parseFloat(amount).toFixed(2), // PayFast requires 2 decimal places
            item_name: (item_name || 'Event Ticket').trim(),
            m_payment_id: booking_id.trim()
        };

        // Generate signature using strict documentation order
        paymentData.signature = PayFastSecurity.createRedirectSignature(paymentData, PAYFAST_CONFIG.passphrase);

        // Store pending booking in Firestore
        if (db) {
            await db.collection('bookings').doc(booking_id).set({
                ...paymentData,
                status: 'pending_payment',
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }

        const baseUrl = PAYFAST_CONFIG.sandbox ? PAYFAST_CONFIG.urls.sandbox : PAYFAST_CONFIG.urls.process;
        const query = new URLSearchParams(paymentData).toString();

        res.json({ success: true, redirectUrl: `${baseUrl}?${query}` });
    } catch (e) {
        console.error('Payment Error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ROUTE B: ITN Webhook (Notification from PayFast)
app.post('/payfast-notify', async (req, res) => {
    const data = req.body;
    console.log('📨 ITN received for booking:', data.m_payment_id);

    // 1. Verify Signature
    if (!PayFastSecurity.verifyItnSignature(data, PAYFAST_CONFIG.passphrase)) {
        console.error('❌ ITN Signature Mismatch');
        return res.status(200).send('OK'); // Always send OK to PayFast to stop retries
    }

    // 2. Validate with PayFast Server
    const validateUrl = PAYFAST_CONFIG.sandbox ? PAYFAST_CONFIG.urls.sandboxValidate : PAYFAST_CONFIG.urls.validate;
    try {
        const validation = await axios.post(validateUrl, querystring.stringify(data));
        if (validation.data !== 'VALID') {
            console.error('❌ ITN Validation Failed');
            return res.status(200).send('OK');
        }
    } catch (e) {
        console.error('❌ ITN Server Error:', e.message);
    }

    // 3. Update Database
    const bookingId = data.m_payment_id;
    if (db && bookingId) {
        const status = data.payment_status === 'COMPLETE' ? 'confirmed' : 'failed';
        await db.collection('bookings').doc(bookingId).update({
            status: status,
            itnReceived: true,
            payfastId: data.pf_payment_id,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`✅ Booking ${bookingId} marked as ${status}`);
    }

    res.status(200).send('OK');
});

// ROUTE C: Check Status (For your Frontend Polling)
app.post('/check-status', async (req, res) => {
    const { bookingId } = req.body;
    if (!db || !bookingId) return res.status(400).json({ success: false });

    const doc = await db.collection('bookings').doc(bookingId).get();
    if (!doc.exists) return res.json({ success: true, status: 'not_found' });

    const data = doc.data();
    res.json({
        success: true,
        status: data.status,
        paymentStatus: data.payment_status || 'PENDING'
    });
});

app.get('/health', (req, res) => res.json({ status: "active", mode: PAYFAST_CONFIG.sandbox ? "sandbox" : "live" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✓ Salwa Collective Backend running on port ${PORT}`);
    console.log(`✓ Mode: ${PAYFAST_CONFIG.sandbox ? 'SANDBOX' : 'PRODUCTION'}`);
});