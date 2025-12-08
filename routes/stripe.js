const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const auth = require('../middleware/auth');
const User = require('../models/User');

router.post('/create-checkout-session', auth, async (req, res) => {
  try {
    const { priceId } = req.body; // the Stripe Price ID for your subscription/product
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription', // or 'payment' if one-time
      success_url: `${process.env.FRONTEND_URL}/premium?success=true`,
      cancel_url: `${process.env.FRONTEND_URL}/premium?canceled=true`,
      customer_email: user.email,
      metadata: { userId: user._id.toString() }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: 'Stripe checkout failed' });
  }
});

module.exports = router;
