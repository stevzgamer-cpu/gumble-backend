const express = require('express');
const connectDB = require('./connection');
require('dotenv').config();

const app = express();

// Middleware to parse JSON (useful for future API routes)
app.use(express.json());

// Home Route: This fixes the "Cannot GET /" error
app.get('/', (req, res) => {
  res.send('🚀 Gumble Backend is officially live and connected to the database!');
});

// Connect to MongoDB Atlas (N. Virginia Cluster)
connectDB();

// Dynamic Port Binding: Uses Render's port (10000) or 5000 locally
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});