const express = require('express');
const connectDB = require('./connection');
const User = require('./user'); // Ensure this matches your lowercase filename
const cors = require('cors'); // The bridge tool
require('dotenv').config();

const app = express();
app.use(cors()); // Allows your website to talk to this server
app.use(express.json()); // Allows server to read data

// 1. Home Message
app.get('/', (req, res) => {
  res.send('🚀 Gumble Casino Backend is Live!');
});

// 2. The Game: Simple High/Low Bet
app.post('/bet', async (req, res) => {
  try {
    const { username, betAmount } = req.body;
    const user = await User.findOne({ username });

    if (!user || user.balance < betAmount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const win = Math.random() > 0.5; // 50/50 chance
    if (win) {
      user.balance += betAmount;
      await user.save();
      return res.json({ message: '🎉 YOU WON!', newBalance: user.balance });
    } else {
      user.balance -= betAmount;
      await user.save();
      return res.json({ message: '❌ You lost.', newBalance: user.balance });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

connectDB();
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Casino running on port ${PORT}`));