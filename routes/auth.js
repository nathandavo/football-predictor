const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

// --------------------------
// REGISTER
// --------------------------
router.post('/register', async (req, res) => {
  const { email, password } = req.body;

  try {
    // Check if user exists
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: 'User already exists' });

    // Hash password
    const hashed = await bcrypt.hash(password, 10);

    // Create user with default freePredictions object
    const user = await User.create({
      email,
      password: hashed,
      isPremium: false,
      freePredictions: {}, // empty initially
    });

    // Generate JWT
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);

    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// --------------------------
// LOGIN
// --------------------------
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid credentials' });

    // Generate JWT
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);

    // Optional: return user info + freePredictions for frontend
    res.json({ token, isPremium: user.isPremium, freePredictions: user.freePredictions });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

