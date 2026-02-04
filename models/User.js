const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true },
  email: { type: String, unique: true, sparse: true }, // Added for Google Login
  password: { type: String }, // Not required for Google users
  balance: { type: Number, default: 1000 },
});

module.exports = mongoose.model('User', UserSchema);