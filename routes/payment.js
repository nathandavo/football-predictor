const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY); // add your secret key to .env
const User = require('../models/User');
const auth = require('../middleware/auth'); // use your auth middleware

const YOUR_DOMAIN = process.env.APP_URL || 'http://localhost:3000'; // frontend URL

// Create Stripe checkout session
router.post('/', auth, async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: req.user.email,
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID, // your Stripe price ID
          quantity: 1,
        },
      ],
      success_url: `${YOUR_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${YOUR_DOMAIN}/payment-cancel`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: 'Payment session failed' });
  }
});

// Optional webhook to mark user as premium after successful payment
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET // get from Stripe
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email;

    // Upgrade user to premium
    const user = await User.findOne({ email });
    if (user) {
      user.isPremium = true;
      await user.save();
      console.log(`User ${email} upgraded to premium`);
    }
  }

  res.json({ received: true });
});

module.exports = router;
