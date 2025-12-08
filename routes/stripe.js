// routes/stripe.js
const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const User = require("../models/User");
const auth = require("../middleware/auth");
const bodyParser = require("body-parser");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// --------------------------
// WEBHOOK
// --------------------------
router.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    console.log("💥 /webhook hit");
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      console.log("💥 Webhook event constructed:", event.type);
    } catch (err) {
      console.log("⚠️ Stripe webhook signature failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = session.metadata.userId;

      console.log("💥 checkout.session.completed for userId:", userId);

      try {
        const user = await User.findById(userId);
        if (user) {
          user.isPremium = true;
          await user.save();
          console.log(`✅ User ${user.email} upgraded to premium`);
        } else {
          console.log("⚠️ User not found for Stripe session metadata");
        }
      } catch (err) {
        console.error("Error updating user premium status:", err);
      }
    }

    res.json({ received: true });
  }
);

// --------------------------
// SUBSCRIPTION CHECKOUT
// --------------------------
router.post("/payment", auth, async (req, res) => {
  console.log("💥 /payment route hit");
  console.log("💥 req.user.id:", req.user?.id);
  console.log("💥 STRIPE_PRICE_ID:", process.env.STRIPE_PRICE_ID);

  try {
    const userId = req.user.id;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription", // must be subscription for recurring
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID, // recurring monthly
          quantity: 1,
        },
      ],
      success_url: `${process.env.APP_URL}/success`,
      cancel_url: `${process.env.APP_URL}/cancel`,
      metadata: { userId }, // link Stripe session to user
    });

    console.log("✅ Checkout session created:", session.id, session.url);
    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    res.status(500).json({ error: "Failed to create Stripe checkout session" });
  }
});

module.exports = router;
