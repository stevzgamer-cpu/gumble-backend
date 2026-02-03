const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(cors()); // Unlocks the connection for Netlify
app.use(express.json());

const PORT = process.env.PORT || 10000;

// MongoDB Connection with your new password
// Replace 'stevzgamer-cpu' with your actual MongoDB username if different
const mongoURI = "mongodb+srv://stevzgamer-cpu:GumbleDB206@cluster0.mongodb.net/GumbleDB?retryWrites=true&w=majority";

mongoose.connect(mongoURI)
    .then(() => console.log("🚀 Success: Connected to GumbleDB!"))
    .catch(err => console.error("❌ MongoDB Connection Error: ", err));

// User Schema
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 1000 }
});

const User = mongoose.model('User', userSchema);

// --- ROUTES ---

// 1. Root Route (For the Rocket Ship test)
app.get('/', (req, res) => {
    res.send("🚀 Gumble Casino Backend is Live and Fixed!");
});

// 2. Register Route
app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.status(400).json({ message: "User already exists" });

        const newUser = new User({ username, password });
        await newUser.save();
        res.json({ username: newUser.username, balance: newUser.balance });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// 3. Login Route
app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username, password });
        if (!user) return res.status(400).json({ message: "Invalid credentials" });
        res.json({ username: user.username, balance: user.balance });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// 4. Update Balance Route
app.post('/update-balance', async (req, res) => {
    try {
        const { username, amount } = req.body;
        const user = await User.findOneAndUpdate(
            { username },
            { $inc: { balance: amount } },
            { new: true }
        );
        res.json({ newBalance: user.balance });
    } catch (err) {
        res.status(500).json({ message: "Error updating balance" });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});