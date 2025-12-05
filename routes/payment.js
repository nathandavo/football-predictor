const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const auth = require("../middleware/auth");
const User = require("../models/User");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY); // secret key

// Create a checkout session
router.post("/create-checkout-session", auth, async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment", // one-time payment
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID, // your Stripe product price ID
          quantity: 1,
        },
      ],
      customer_email: req.user.email, // optional: prefill email
      success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/payment-cancel`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.log("Stripe checkout error:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// Webhook to mark user as premium after payment
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log("Webhook signature verification failed:", err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userEmail = session.customer_email;

    // Mark user as premium
    await User.findOneAndUpdate({ email: userEmail }, { isPremium: true });
    console.log(`User ${userEmail} upgraded to premium!`);
  }

  res.json({ received: true });
});

module.exports = router;
