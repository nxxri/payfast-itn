// backend/index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // ✅ ESM import
import admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ---------------- FIREBASE INIT ----------------
try {
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY))
        });
        console.log("✅ Firebase initialized successfully");
    }
} catch (err) {
    console.error("❌ Firebase initialization error:", err);
}

const db = admin.firestore();

// ---------------- CREATE YOCO CHECKOUT ----------------
app.post("/create-checkout", async (req, res) => {
    const { bookingId, amount, email, name } = req.body;

    if (!bookingId || !amount || !email || !name) {
        return res.status(400).json({ error: "bookingId, amount, email, and name are required" });
    }

    try {
        // Make sure booking exists in Firebase
        const bookingSnap = await db.collection("bookings").doc(bookingId).get();
        if (!bookingSnap.exists) {
            return res.status(404).json({ error: "Booking not found" });
        }

        // Create Yoco checkout
        const response = await fetch("https://online.yoco.com/v1/checkout", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.YOCO_SECRET}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                amountInCents: amount,
                currency: "ZAR",
                reference: bookingId,
                customerEmail: email,
                customerName: name,
                successUrl: `${process.env.FRONTEND_URL}/success?bookingId=${bookingId}`,
                cancelUrl: `${process.env.FRONTEND_URL}/cancel?bookingId=${bookingId}`
            })
        });

        const data = await response.json();

        if (!response.ok) {
            console.error("Yoco API error:", data);
            return res.status(500).json({ error: "Failed to create Yoco checkout" });
        }

        res.json({ redirectUrl: data.checkout.checkoutPageUrl });
    } catch (err) {
        console.error("Checkout creation error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ---------------- YOCO WEBHOOK ----------------
app.post("/yoco-webhook", async (req, res) => {
    const event = req.body;

    try {
        const bookingId = event.data?.reference;
        if (!bookingId) return res.sendStatus(400);

        const bookingRef = db.collection("bookings").doc(bookingId);
        const bookingSnap = await bookingRef.get();
        if (!bookingSnap.exists) return res.sendStatus(404);

        const bookingData = bookingSnap.data();
        const ticketQty = bookingData.ticketQuantity || 1;

        if (event.type === "payment.succeeded" && bookingData.status === "PENDING") {
            await bookingRef.update({ status: "PAID" });

            const eventRef = db.collection("events").doc(bookingData.eventId);
            await eventRef.update({
                ticketsRemaining: admin.firestore.FieldValue.increment(-ticketQty)
            });
        }

        if (event.type === "payment.failed") {
            await bookingRef.update({ status: "CANCELLED" });
        }

        res.sendStatus(200);
    } catch (err) {
        console.error("Webhook error:", err);
        res.sendStatus(500);
    }
});

// ---------------- HEALTH CHECK ----------------
app.get("/", (req, res) => res.send("Yoco backend running"));

// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
