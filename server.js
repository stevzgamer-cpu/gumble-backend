const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Setup the Real-Time Server
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allow connections from anywhere (Netlify)
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 10000;

// Database Connection (Keep your existing string)
const mongoURI = "mongodb+srv://stevzgamer-db-user:GumbleDB206@cluster0.uw2p1mi.mongodb.net/GumbleDB?retryWrites=true&w=majority";
mongoose.connect(mongoURI)
    .then(() => console.log("🚀 Poker Database Connected!"))
    .catch(err => console.error("Database Error:", err));

// User Schema (Updated for Poker)
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // We will add Google ID later
    balance: { type: Number, default: 10000 }, // Starting chips
    email: { type: String }
});
const User = mongoose.model('User', userSchema);

// --- POKER ROOM MANAGEMENT ---
// In a real pro app, use Redis. For now, memory is fine.
let rooms = {}; 

io.on('connection', (socket) => {
  console.log(`User Connected: ${socket.id}`);

  // Player Joins a Room (Texas Holdem or Omaha)
  socket.on('join_room', ({ roomName, username, gameType }) => {
    socket.join(roomName);
    
    if (!rooms[roomName]) {
      rooms[roomName] = {
        type: gameType, // 'texas' or 'omaha'
        players: [],
        pot: 0,
        communityCards: []
      };
    }

    // Add player to room
    const player = { id: socket.id, username, chips: 1000, currentBet: 0, folded: false };
    rooms[roomName].players.push(player);

    // Tell everyone in the room a new player sat down
    io.to(roomName).emit('update_room', rooms[roomName]);
  });

  // Handle a Bet
  socket.on('place_bet', ({ roomName, amount }) => {
    if (rooms[roomName]) {
      rooms[roomName].pot += amount;
      io.to(roomName).emit('update_room', rooms[roomName]);
    }
  });

  // Handle Winner & 1.5% Tax (The Rake)
  socket.on('end_hand', ({ roomName, winnerUsername }) => {
    if (rooms[roomName]) {
      const pot = rooms[roomName].pot;
      const tax = pot * 0.015; // 1.5% House Cut
      const winnings = pot - tax;

      // Reset Pot
      rooms[roomName].pot = 0;
      
      // Broadcast the win
      io.to(roomName).emit('hand_result', { 
        winner: winnerUsername, 
        winnings: winnings, 
        houseCut: tax 
      });

      // Update Database (Async)
      updateWinnerBalance(winnerUsername, winnings);
    }
  });

  socket.on('disconnect', () => {
    console.log("User Disconnected", socket.id);
    // Logic to remove player from rooms goes here
  });
});

// Helper function to save money to DB
async function updateWinnerBalance(username, amount) {
  await User.findOneAndUpdate({ username }, { $inc: { balance: amount } });
}

// Keep your standard login routes here...
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username, password });
    if (!user) return res.status(400).json({ message: "Invalid credentials" });
    res.json({ username: user.username, balance: user.balance });
});

// Start the Server
server.listen(PORT, () => {
  console.log(`♣️♥️ Poker Server running on port ${PORT}`);
});