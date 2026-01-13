// ========================
// 1️⃣ BASIC SETUP
// ========================
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ========================
// 2️⃣ FIREBASE INIT
// ========================
admin.initializeApp({
    credential: admin.credential.cert(
        JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
    firestore: { ignoreUndefinedProperties: true }
});

const db = admin.firestore();

// ========================
// 3️⃣ START BOOKING ROUTE
// ========================
app.post("/bookings", async (req, res) => {
    try {
        console.log("Received booking request:", JSON.stringify(req.body, null, 2));

        // Extract data - handle both formats from frontend
        const {
            eventId,
            eventName,
            eventDate,
            eventLocation,
            eventCity,
            // Frontend sends customer object
            customer,
            // Also accept flat fields for backward compatibility
            userName,
            userEmail,
            userPhone,
            emergencyContactName,
            emergencyContactPhone,
            ticketQuantity,
            ticketBasePrice,
            addons,
            discount,
            totalAmount,
            discountAmount
        } = req.body;

        // 🚨 CRITICAL FIX: Handle customer data properly
        let customerData = {};

        if (customer && typeof customer === 'object') {
            // Frontend sends customer object (your current format)
            customerData = {
                name: customer.name ? String(customer.name).trim() : '',
                email: customer.email ? String(customer.email).trim() : '',
                phone: customer.phone ? String(customer.phone).trim() : '',
                emergencyContact: {
                    name: customer.emergencyContact?.name ? String(customer.emergencyContact.name).trim() : '',
                    phone: customer.emergencyContact?.phone ? String(customer.emergencyContact.phone).trim() : ''
                }
            };
        } else {
            // For backward compatibility
            customerData = {
                name: userName ? String(userName).trim() : '',
                email: userEmail ? String(userEmail).trim() : '',
                phone: userPhone ? String(userPhone).trim() : '',
                emergencyContact: {
                    name: emergencyContactName ? String(emergencyContactName).trim() : '',
                    phone: emergencyContactPhone ? String(emergencyContactPhone).trim() : ''
                }
            };
        }

        // 🚨 VALIDATION: Ensure all required customer fields exist
        if (!customerData.name || customerData.name.length < 2) {
            return res.status(400).json({
                success: false,
                error: "Valid customer name is required (minimum 2 characters)"
            });
        }

        if (!customerData.email || !customerData.email.includes('@')) {
            return res.status(400).json({
                success: false,
                error: "Valid customer email is required"
            });
        }

        if (!eventId) {
            return res.status(400).json({
                success: false,
                error: "Missing eventId"
            });
        }

        if (!ticketQuantity || ticketQuantity < 1) {
            return res.status(400).json({
                success: false,
                error: "Invalid ticket quantity"
            });
        }

        const eventRef = db.collection("events").doc(eventId);
        const bookingsRef = db.collection("bookings");

        let bookingId;
        let finalTotalAmount;

        await db.runTransaction(async (tx) => {
            const eventSnap = await tx.get(eventRef);
            if (!eventSnap.exists) {
                throw new Error(`Event with ID ${eventId} not found`);
            }

            const event = eventSnap.data();

            // Check if event is active
            if (event.active === false) {
                throw new Error("This event is not currently active");
            }

            // Check capacity
            const ticketsRemaining = event.ticketsRemaining || event.capacity || 30;
            const bookedSpots = event.bookedSpots || 0;

            if (ticketsRemaining - bookedSpots < ticketQuantity) {
                throw new Error(`Only ${ticketsRemaining - bookedSpots} tickets remaining`);
            }

            // Calculate total amount
            if (totalAmount && typeof totalAmount === 'number') {
                finalTotalAmount = totalAmount;
            } else {
                const eventPrice = event.priceNumber ||
                    (event.price ? parseFloat(event.price.replace('R', '')) : 150) ||
                    150;
                finalTotalAmount = eventPrice * ticketQuantity;

                if (discountAmount && discountAmount > 0) {
                    finalTotalAmount -= discountAmount;
                    if (finalTotalAmount < 0) finalTotalAmount = 0;
                }
            }

            // Update event capacity
            const updateData = {};
            if (event.ticketsRemaining !== undefined) {
                updateData.ticketsRemaining = event.ticketsRemaining - ticketQuantity;
            }
            if (event.capacity !== undefined) {
                updateData.bookedSpots = (event.bookedSpots || 0) + ticketQuantity;
            }

            if (Object.keys(updateData).length > 0) {
                tx.update(eventRef, updateData);
            }

            // Create booking document
            const bookingDoc = bookingsRef.doc();
            bookingId = bookingDoc.id;

            // Clean addons array
            const cleanAddons = Array.isArray(addons)
                ? addons.filter(addon => addon != null && addon !== undefined && addon !== "None")
                : [];

            // Clean discount object
            let cleanDiscount = null;
            if (discount && typeof discount === 'object') {
                cleanDiscount = {
                    code: discount.code || '',
                    type: discount.type || '',
                    value: discount.value || 0,
                    minTickets: discount.minTickets || 0
                };
            }

            // 🚨 CRITICAL FIX: Prepare booking data with PROPER customer structure
            const bookingData = {
                eventId,
                eventName: eventName || event.title || '',
                eventDate: eventDate || event.date || '',
                eventLocation: eventLocation || event.location || '',
                eventCity: eventCity || event.city || '',

                // ✅ CORRECT: customer object with guaranteed non-empty values
                customer: {
                    name: customerData.name || '',
                    email: customerData.email || '',
                    phone: customerData.phone || '',
                    emergencyContact: {
                        name: customerData.emergencyContact?.name || '',
                        phone: customerData.emergencyContact?.phone || ''
                    }
                },

                ticketQuantity: Number(ticketQuantity) || 1,
                ticketBasePrice: Number(ticketBasePrice) || 150,
                addons: cleanAddons,
                discount: cleanDiscount,
                discountAmount: Number(discountAmount) || 0,
                totalAmount: Number(finalTotalAmount),
                paymentMethod: "payfast",
                status: "PENDING",
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            };

            // ✅ Ensure no undefined values in emergencyContact
            if (!bookingData.customer.emergencyContact.name && !bookingData.customer.emergencyContact.phone) {
                bookingData.customer.emergencyContact = null;
            }

            console.log("Saving to Firestore:", JSON.stringify(bookingData, null, 2));
            tx.set(bookingDoc, bookingData);

            console.log(`Booking created: ${bookingId} for event: ${eventId}`);
        });

        // Prepare PayFast parameters
        const nameParts = customerData.name.trim().split(" ");
        const firstName = nameParts[0] || "";
        const lastName = nameParts.slice(1).join(" ") || "";

        const payfastParams = {
            merchant_id: process.env.PAYFAST_MERCHANT_ID,
            merchant_key: process.env.PAYFAST_MERCHANT_KEY,
            return_url: `${process.env.BASE_URL || 'https://payfast-demo-psi.vercel.app'}/payment-success.html`,
            cancel_url: `${process.env.BASE_URL || 'https://payfast-demo-psi.vercel.app'}/payment-cancel.html`,
            notify_url: `${process.env.BACKEND_URL || 'https://payfast-backend-o9gn.onrender.com'}/payfast-itn`,
            amount: finalTotalAmount.toFixed(2),
            item_name: `Event: ${eventName || 'Ticket'}`,
            item_description: `${ticketQuantity} ticket(s) for ${eventName}`,
            m_payment_id: bookingId,
            name_first: firstName,
            name_last: lastName,
            email_address: customerData.email.trim(),
            cell_number: customerData.phone ? customerData.phone.trim().replace(/\D/g, '') : ''
        };

        // Remove empty parameters
        Object.keys(payfastParams).forEach(key => {
            if (!payfastParams[key]) {
                delete payfastParams[key];
            }
        });

        const payfastUrl = "https://www.payfast.co.za/eng/process?" +
            new URLSearchParams(payfastParams);

        console.log(`Generated PayFast URL for booking ${bookingId}`);

        res.json({
            success: true,
            redirectUrl: payfastUrl,
            bookingId: bookingId,
            amount: finalTotalAmount
        });

    } catch (err) {
        console.error("Booking error:", err);
        res.status(400).json({
            success: false,
            error: err.message || "An error occurred during booking"
        });
    }
});

// ========================
// 4️⃣ PAYFAST ITN VERIFICATION
// ========================
app.post("/payfast-itn", async (req, res) => {
    // Respond immediately to PayFast
    res.status(200).send("OK");

    const data = req.body;
    console.log("PayFast ITN received:", data);

    // STEP 1: Verify signature
    const receivedSignature = data.signature;
    if (!receivedSignature) {
        console.error("No signature received from PayFast");
        return;
    }

    delete data.signature; // remove signature for hash

    const paramString = Object.keys(data)
        .sort()
        .map(key => `${key}=${encodeURIComponent(data[key])}`)
        .join("&");

    const generatedSignature = crypto
        .createHmac("md5", process.env.PAYFAST_PASSPHRASE || '')
        .update(paramString)
        .digest("hex");

    if (generatedSignature !== receivedSignature) {
        console.error("PayFast signature mismatch");
        console.error("Generated:", generatedSignature);
        console.error("Received:", receivedSignature);
        console.error("Param string:", paramString);
        return;
    }

    console.log("PayFast signature verified successfully");

    // STEP 2: Only proceed if payment complete
    if (data.payment_status !== "COMPLETE") {
        console.log(`Payment status: ${data.payment_status} - not updating booking`);
        return;
    }

    try {
        const bookingRef = db.collection("bookings").doc(data.m_payment_id);
        const bookingSnap = await bookingRef.get();

        if (!bookingSnap.exists) {
            console.error(`Booking ${data.m_payment_id} not found`);
            return;
        }

        // Update booking to PAID
        await bookingRef.update({
            status: "PAID",
            payfastPaymentId: data.pf_payment_id,
            payfastData: data,
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`✅ Booking ${data.m_payment_id} marked as PAID`);

    } catch (err) {
        console.error("Error updating booking:", err);
    }
});

// ========================
// 5️⃣ HEALTH CHECK
// ========================
app.get("/", (req, res) => {
    res.json({
        status: "online",
        service: "PayFast Booking Backend",
        endpoints: {
            bookings: "POST /bookings",
            itn: "POST /payfast-itn"
        }
    });
});

// ========================
// 6️⃣ START SERVER
// ========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Backend running on port ${PORT}`);
    console.log(`📝 Booking endpoint: POST http://localhost:${PORT}/bookings`);
    console.log(`🔄 PayFast ITN endpoint: POST http://localhost:${PORT}/payfast-itn`);
});