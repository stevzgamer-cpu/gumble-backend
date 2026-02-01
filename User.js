const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    balance: { type: Number, default: 1000 }, // Starting credits
    betHistory: [{ game: String, amount: Number, result: String }]
});

module.exports = mongoose.model('User', UserSchema);