const express = require('express');
const cors = require('cors');
const connectDB = require('./connection');
const User = require('./user'); // Use lowercase 'user' to match your filename
require('dotenv').config();

// 1. INITIALIZE APP FIRST (Fixes the ReferenceError)
const app = express();

// 2. MIDDLEWARE
app.use(cors()); // Allows your professional site to talk to Render
app.use(express.json()); // Allows server to read data you send

// 3. HOME ROUTE
app.get('/', (req, res) => {
  res.send('🚀 Gumble Casino Backend is Live and Fixed!');
});

// 4. THE GAME LOGIC
app.post('/bet', async (req, res) => {
  try {
    const { username, betAmount } = req.body;
    const user = await User.findOne({ username });

    if (!user || user.balance < betAmount) {
      return res.status(400).json({ error: 'Insufficient balance or user not found' });
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

// 5. CONNECT AND START
connectDB();

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});