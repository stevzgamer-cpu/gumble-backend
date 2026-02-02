const express = require('express');
const connectDB = require('./connection');
const User = require('./user'); // Match your lowercase 'user.js' file name
require('dotenv').config();

const app = express();

// Middleware to parse JSON so the server can read your data
app.use(express.json()); 

// Home Route
app.get('/', (req, res) => {
  res.send('🚀 Gumble Backend is officially live and connected to the database!');
});

// NEW: Registration Route
app.post('/register', async (req, res) => {
  try {
    const { username } = req.body;
    
    // Create a new user (balance defaults to 1000)
    const newUser = new User({ username });
    await newUser.save();
    
    res.status(201).json({ message: '✅ User created!', user: newUser });
  } catch (err) {
    res.status(400).json({ error: '❌ Error creating user', details: err.message });
  }
});

// Connect to MongoDB
connectDB();

// Render Port Binding
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});