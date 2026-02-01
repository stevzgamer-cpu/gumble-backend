const mongoose = require('mongoose');
require('dotenv').config();

const connectDB = async () => {
    try {
        console.log("⏳ Attempting to break through the network...");
        await mongoose.connect(process.env.MONGODB_URI, {
            serverSelectionTimeoutMS: 10000, // Wait 10 seconds before failing
        });
        console.log("✅ Success: Connected to GumbleDB!");
    } catch (err) {
        console.error("❌ Connection failed:", err.message);
    }
};

module.exports = connectDB;