require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const { Server } = require('socket.io');
const User = require('./models/User');
// Note: If you haven't created pokerEngine.js yet, this line might fail. 
// For now, let's keep the engine logic inside server.js to avoid "missing file" errors.

const app = express();
app.use(cors());
app.use(express.json());

// --- DATABASE CONNECTION ---
// Using the standard connection string you likely used before
mongoose.connect(process.env.MONGO_URI || "mongodb+srv://admin:admin123@cluster0.mongodb.net/gumble?retryWrites=true&w=majority")
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Error:", err));

// --- AUTH ROUTES ---
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    // Simple user creation (in a real app, we'd hash the password)
    const user = await User.create({ username, password, balance: 1000 });
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: "Username already taken" });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username, password });
  if (user) res.json(user);
  else res.status(400).json({ error: "Invalid credentials" });
});

// --- SOCKET SERVER ---
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allow connections from anywhere (Frontend)
    methods: ["GET", "POST"]
  }
});

// --- GAME LOGIC ---
let gameState = {
    players: [],
    communityCards: [],
    pot: 0,
    phase: 'waiting',
    deck: []
};

// Helper: Create a Deck
const createDeck = () => {
    const suits = ['h', 'd', 'c', 's'];
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let s of suits) for (let r of ranks) deck.push(r + s);
    return deck.sort(() => Math.random() - 0.5);
};

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    socket.on('joinGame', async ({ roomId, userId, buyIn }) => {
        // Find user in DB and deduct buy-in
        const user = await User.findById(userId);
        if (!user || user.balance < buyIn) return; // Add error handling later

        await User.findByIdAndUpdate(userId, { $inc: { balance: -buyIn } });
        
        // Add to game state
        const existingPlayer = gameState.players.find(p => p.dbId === userId);
        if (!existingPlayer) {
            gameState.players.push({
                id: socket.id,
                dbId: userId,
                name: user.username,
                balance: buyIn,
                hand: [],
                bet: 0
            });
        }
        
        socket.join(roomId);
        
        // Start Game if 2 players
        if (gameState.players.length >= 2 && gameState.phase === 'waiting') {
            gameState.phase = 'preflop';
            gameState.deck = createDeck();
            gameState.players.forEach(p => {
                p.hand = [gameState.deck.pop(), gameState.deck.pop()];
            });
            // Deal community cards (simplified for immediate start)
            gameState.communityCards = [gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop()];
        }

        io.to(roomId).emit('gameState', gameState);
    });

    socket.on('action', ({ roomId, type }) => {
        // Handle moves here later
        io.to(roomId).emit('gameState', gameState);
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));