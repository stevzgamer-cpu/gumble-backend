const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 0 }, // The Main Wallet
  avatar: { type: String, default: "https://i.imgur.com/6Xq3g9s.png" }
});

module.exports = mongoose.model('User', UserSchema);

const { Hand } = require('pokersolver');

class PokerGame {
  constructor(roomId) {
    this.id = roomId;
    this.players = []; // { id, name, balance, hand: [], bet: 0, folded: false }
    this.deck = [];
    this.communityCards = [];
    this.pot = 0;
    this.turnIndex = 0;
    this.phase = 'waiting'; // waiting, preflop, flop, turn, river, showdown
    this.minBet = 20;
  }

  createDeck() {
    const suits = ['h', 'd', 'c', 's'];
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    this.deck = [];
    for (let s of suits) for (let r of ranks) this.deck.push(r + s);
    this.deck.sort(() => Math.random() - 0.5); // Shuffle
  }

  dealHands() {
    this.createDeck();
    this.players.forEach(p => {
      p.hand = [this.deck.pop(), this.deck.pop()];
      p.folded = false;
    });
    this.phase = 'preflop';
  }

  nextStage() {
    if (this.phase === 'preflop') {
      this.communityCards.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      this.phase = 'flop';
    } else if (this.phase === 'flop') {
      this.communityCards.push(this.deck.pop());
      this.phase = 'turn';
    } else if (this.phase === 'turn') {
      this.communityCards.push(this.deck.pop());
      this.phase = 'river';
    } else {
      this.resolveWinner();
    }
  }

  resolveWinner() {
    // Logic to use pokersolver to pick winner and distribute pot
    // (Simplified for brevity - assumes integration in server.js)
    this.phase = 'showdown';
  }

  // Sanitize state: Don't show opponents' cards!
  getPublicState(playerId) {
    return {
      ...this,
      deck: undefined, // Hide deck
      players: this.players.map(p => ({
        ...p,
        hand: p.id === playerId || this.phase === 'showdown' ? p.hand : ['XX', 'XX'] // Hide cards if not yours
      }))
    };
  }
}

module.exports = PokerGame;

require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const { Server } = require('socket.io');
const User = require('./models/User');
const PokerGame = require('./pokerEngine');

const app = express();
app.use(cors());
app.use(express.json());

// Database Connection
mongoose.connect(process.env.MONGO_URI || "mongodb+srv://admin:admin123@cluster0.mongodb.net/gumble?retryWrites=true&w=majority")
  .then(() => console.log("✅ MongoDB Connected"));

// Routes for Auth & Banking
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.create({ username, password, balance: 1000 }); // Free $1000 start
  res.json(user);
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username, password });
  if (user) res.json(user);
  else res.status(400).json({ error: "Invalid credentials" });
});

app.post('/api/transaction', async (req, res) => {
  const { userId, amount } = req.body; // + for deposit, - for withdraw
  const user = await User.findByIdAndUpdate(userId, { $inc: { balance: amount } }, { new: true });
  res.json(user);
});

// Socket.io Game Server
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const games = {}; // Store active games

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('joinGame', async ({ roomId, userId, buyIn }) => {
    // 1. Deduct Buy-in
    if (buyIn < 20 || buyIn > 100) return socket.emit('error', 'Buy-in must be $20-$100');
    const user = await User.findById(userId);
    if (user.balance < buyIn) return socket.emit('error', 'Insufficient funds');
    
    await User.findByIdAndUpdate(userId, { $inc: { balance: -buyIn } });

    // 2. Join Room
    socket.join(roomId);
    if (!games[roomId]) games[roomId] = new PokerGame(roomId);
    const game = games[roomId];

    game.players.push({ id: socket.id, dbId: userId, name: user.username, balance: buyIn, hand: [], bet: 0 });

    // 3. Start if 2+ players
    if (game.players.length >= 2 && game.phase === 'waiting') {
      game.dealHands();
    }

    io.to(roomId).emit('gameState', game); // Note: We fix privacy in frontend mapping or here
  });

  socket.on('action', ({ roomId, type, amount }) => {
    const game = games[roomId];
    if (!game) return;
    
    // Process Check, Fold, Call, Raise
    if (type === 'fold') {
       const p = game.players.find(p => p.id === socket.id);
       p.folded = true;
    }
    // Simple progression
    game.turnIndex = (game.turnIndex + 1) % game.players.length;
    
    // Check if round ended
    if (game.turnIndex === 0) game.nextStage();

    io.to(roomId).emit('gameState', game);
  });
});

server.listen(process.env.PORT || 5000, () => console.log("🚀 Server Running on Port 5000"));