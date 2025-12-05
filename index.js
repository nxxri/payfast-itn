const PF_VALIDATE_URL = process.env.PAYFAST_SANDBOX === 'true'
    ? 'https://sandbox.payfast.co.za/eng/query/validate'
    : 'https://www.payfast.co.za/eng/query/validate';

app.post('/payfast-notify', async (req, res) => {
    const data = req.body;

    try {
        const response = await axios.post(
            PF_VALIDATE_URL,
            querystring.stringify(data),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        if (response.data === 'VALID') {
            const bookingId = data.m_payment_id;
            await db.collection(bookingsCollection).doc(bookingId).set({
                status: 'paid',
                amount: data.amount_gross,
                payer_email: data.email_address,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            console.log('Payment verified and booking updated');
        } else {
            console.error('Invalid ITN:', data);
        }

        // Always reply 200 to PayFast
        res.status(200).send('OK');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});
