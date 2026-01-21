import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// ---------------- FIREBASE INIT ----------------
admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY))
});
const db = admin.firestore();

// ---------------- CREATE YOCO CHECKOUT ----------------
app.post("/create-checkout", async (req, res) => {
    const { bookingId } = req.body;

    if (!bookingId) return res.status(400).json({ error: "bookingId required" });

    try {
        const bookingSnap = await db.collection("bookings").doc(bookingId).get();
        if (!bookingSnap.exists) return res.status(404).json({ error: "Booking not found" });

        const booking = bookingSnap.data();
        const totalAmount = booking.totalAmount || 0;

        const response = await fetch("https://payments.yoco.com/api/checkouts", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.YOCO_SECRET}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                amount: totalAmount * 100, // Yoco expects amount in cents
                currency: "ZAR",
                reference: bookingId,
                successUrl: `${process.env.FRONTEND_URL}/success?bookingId=${bookingId}`,
                cancelUrl: `${process.env.FRONTEND_URL}/cancel?bookingId=${bookingId}`
            })
        });

        const data = await response.json();
        res.json({ redirectUrl: data.redirectUrl });

    } catch (err) {
        console.error("Checkout creation error:", err);
        res.status(500).json({ error: "Failed to create checkout" });
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

            // Decrement ticketsRemaining dynamically
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
