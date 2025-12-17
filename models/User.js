const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  isPremium: { type: Boolean, default: false },
  
  // ✅ FIX: Use Map instead of Object so .get()/.set() works
  freePredictions: {
    type: Map,
    of: Boolean,
    default: {},
  },

  // ⭐ Added safely — does NOT affect anything else
  stripeCustomerId: { type: String, default: null }
});

module.exports = mongoose.model('User', userSchema);
