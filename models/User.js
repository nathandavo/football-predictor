const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  isPremium: { type: Boolean, default: false },
  freePredictions: { type: Object, default: {} } // track free prediction per gameweek
});

module.exports = mongoose.model('User', userSchema);
