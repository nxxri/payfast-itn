// ========================
// 1️⃣ BASIC SETUP
// ========================
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const crypto = require("crypto");

const app = express();
app.use(cors()); // allow frontend
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ========================
// 2️⃣ FIREBASE INIT
// ========================
admin.initializeApp({
    credential: admin.credential.cert(
        JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    )
});

const db = admin.firestore();

// ========================
// 3️⃣ START BOOKING ROUTE
// ========================
app.post("/start-booking", async (req, res) => {
    try {
        const {
            eventId,
            ticketQuantity,
            userName,
            userEmail,
            userPhone
        } = req.body;

        if (!eventId || !ticketQuantity || !userEmail) {
            return res.status(400).json({ error: "Missing data" });
        }

        const eventRef = db.collection("events").doc(eventId);
        const bookingsRef = db.collection("bookings");

        let bookingId;
        let totalAmount;

        // Transaction to safely decrement tickets and create booking
        await db.runTransaction(async (tx) => {
            const eventSnap = await tx.get(eventRef);
            if (!eventSnap.exists) throw new Error("Event not found");

            const event = eventSnap.data();

            if (!event.active) throw new Error("Event inactive");
            if (event.ticketsRemaining < ticketQuantity)
                throw new Error("Not enough tickets");

            totalAmount = event.priceNumber * ticketQuantity;

            // Reserve tickets immediately
            tx.update(eventRef, {
                ticketsRemaining: event.ticketsRemaining - ticketQuantity
            });

            // Create booking in Firestore
            const bookingDoc = bookingsRef.doc();
            bookingId = bookingDoc.id;

            tx.set(bookingDoc, {
                eventId,
                eventName: event.title,
                eventLocation: event.location,
                userName,
                userEmail,
                userPhone,
                ticketQuantity,
                totalAmount,
                paymentMethod: "payfast",
                status: "PENDING",
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        // Split userName into first & last name
        const nameParts = userName.trim().split(" ");
        const firstName = nameParts[0] || "";
        const lastName = nameParts.slice(1).join(" ") || "";

        // Generate PayFast redirect URL
        const payfastParams = {
            merchant_id: process.env.PAYFAST_MERCHANT_ID,
            merchant_key: process.env.PAYFAST_MERCHANT_KEY,
            return_url: `${process.env.BASE_URL}/payment-success.html`,
            cancel_url: `${process.env.BASE_URL}/payment-cancel.html`,
            notify_url: `${process.env.BACKEND_URL}/payfast-itn`,
            amount: totalAmount.toFixed(2),
            item_name: "Event Ticket",
            m_payment_id: bookingId,
            name_first: firstName,
            name_last: lastName,
            email_address: userEmail,
            cell_number: userPhone
        };

        const payfastUrl =
            "https://www.payfast.co.za/eng/process?" +
            new URLSearchParams(payfastParams);

        res.json({ redirectUrl: payfastUrl });

    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ========================
// 4️⃣ PAYFAST ITN VERIFICATION
// ========================
app.post("/payfast-itn", async (req, res) => {
    res.status(200).send("OK"); // respond immediately to PayFast

    const data = req.body;

    // STEP 1: Verify signature
    const receivedSignature = data.signature;
    delete data.signature; // remove signature for hash
    const paramString = Object.keys(data)
        .sort()
        .map(key => `${key}=${data[key]}`)
        .join("&");

    const generatedSignature = crypto
        .createHmac("md5", process.env.PAYFAST_PASSPHRASE)
        .update(paramString)
        .digest("hex");

    if (generatedSignature !== receivedSignature) {
        console.error("PayFast signature mismatch");
        return;
    }

    // STEP 2: Only proceed if payment complete
    if (data.payment_status !== "COMPLETE") return;

    try {
        const bookingRef = db.collection("bookings").doc(data.m_payment_id);
        const bookingSnap = await bookingRef.get();
        if (!bookingSnap.exists) return;

        // Update booking to PAID
        await bookingRef.update({
            status: "PAID",
            payfastPaymentId: data.pf_payment_id
        });

        console.log(`Booking ${data.m_payment_id} marked as PAID`);
    } catch (err) {
        console.error("Error updating booking:", err);
    }
});

// ========================
// 5️⃣ START SERVER
// ========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});
