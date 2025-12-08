// routes/stripe.js
const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const User = require("../models/User");
const auth = require("../middleware/auth");
const bodyParser = require("body-parser");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Webhook
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
      console.log("💥 Premium activated for:", userId);

      const user = await User.findById(userId);
      if (user) {
        user.isPremium = true;
        await user.save();
        console.log("✅ User upgraded");
      }
    }

    res.json({ received: true });
  }
);

// Create checkout session
router.post("/payment", auth, async (req, res) => {
  console.log("💥 /stripe/payment hit");

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
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

module.exports = router;
