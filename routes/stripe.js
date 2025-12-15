// routes/stripe.js
const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const User = require("../models/User");
const auth = require("../middleware/auth");
const bodyParser = require("body-parser");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ---------------------------
// WEBHOOK
// ---------------------------
router.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    console.log("💥 /stripe/webhook hit");

    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log("⚠️ Webhook signature failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const userId = session.metadata.userId;
      const customerId = session.customer; // 👈 Stripe customer ID

      console.log("💥 Premium activated for:", userId);
      console.log("💥 Stripe customer:", customerId);

      const user = await User.findById(userId);
      if (user) {
        user.isPremium = true;
        user.stripeCustomerId = customerId; // Save for portal & future use
        await user.save();

        console.log("✅ User upgraded & customer ID saved");
      }
    }

    res.json({ received: true });
  }
);

// ---------------------------
// CREATE CHECKOUT SESSION (SUBSCRIPTION)
// ---------------------------
router.post("/payment", auth, async (req, res) => {
  console.log("💥 /stripe/payment hit");

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription", // subscription mode
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      success_url: `${process.env.APP_URL}/success`,
      cancel_url: `${process.env.APP_URL}/cancel`,
      metadata: { userId: req.user.id },
    });

    console.log("➡️ Redirect URL:", session.url);
    res.json({ url: session.url });
  } catch (err) {
    console.log("❌ Stripe error:", err);
    res.status(500).json({ error: "Stripe failed" });
  }
});

// ---------------------------
// CUSTOMER PORTAL (CANCEL SUBSCRIPTION)
// ---------------------------
router.post("/portal", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user || !user.stripeCustomerId) {
      return res.status(400).json({ error: "No Stripe customer found" });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${process.env.APP_URL}/account`,
    });

    res.json({ url: portalSession.url });
  } catch (err) {
    console.log("❌ Portal error:", err);
    res.status(500).json({ error: "Cannot load portal" });
  }
});

module.exports = router;
