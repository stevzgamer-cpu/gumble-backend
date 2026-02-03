require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const { Server } = require('socket.io');
const User = require('./models/User');

const app = express();
app.use(cors());
app.use(express.json());

// --- 1. DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ DB Error:", err));

// --- 2. AUTHENTICATION ---
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    // Simple registration (In prod, use bcrypt)
    const user = await User.create({ username, password, balance: 1000 });
    res.json(user);
  } catch (err) { res.status(400).json({ error: "Username taken" }); }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username, password });
  if (user) res.json(user);
  else res.status(400).json({ error: "Invalid credentials" });
});

// --- 3. POKER ENGINE ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let gameState = {
  roomId: "HighRollers",
  players: [], // { id, dbId, name, balance, hand, currentBet, folded }
  communityCards: [],
  pot: 0,
  deck: [],
  phase: 'waiting', // waiting, preflop, flop, turn, river, showdown
  turnIndex: 0,
  highestBet: 0
};

// Deck Helpers
const suits = ['h', 'd', 'c', 's'];
const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const createDeck = () => {
  let deck = [];
  for (let s of suits) for (let r of ranks) deck.push(r + s);
  return deck.sort(() => Math.random() - 0.5);
};

const nextStage = () => {
    // Reveal Cards Logic
    if (gameState.phase === 'preflop') {
        gameState.phase = 'flop';
        gameState.communityCards.push(gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop());
    } else if (gameState.phase === 'flop') {
        gameState.phase = 'turn';
        gameState.communityCards.push(gameState.deck.pop());
    } else if (gameState.phase === 'turn') {
        gameState.phase = 'river';
        gameState.communityCards.push(gameState.deck.pop());
    } else {
        endHand(); // Showdown
        return;
    }
    // Reset Round Bets
    gameState.players.forEach(p => p.currentBet = 0);
    gameState.highestBet = 0;
    gameState.turnIndex = 0; // Reset to first player
    io.emit('gameState', gameState);
};

const nextTurn = () => {
    let activePlayers = gameState.players.filter(p => !p.folded);
    if (activePlayers.length === 1) { endHand(); return; } // Everyone else folded

    // Find next non-folded player
    do {
        gameState.turnIndex = (gameState.turnIndex + 1) % gameState.players.length;
    } while (gameState.players[gameState.turnIndex].folded);

    // If we looped back to start, go to next stage (Simple Version)
    if (gameState.turnIndex === 0 && gameState.highestBet === 0) {
       // nextStage(); // Logic simplified for stability
    }
    io.emit('gameState', gameState);
};

const endHand = async () => {
    gameState.phase = 'showdown';
    // Winner Logic (Simplified: Random active player wins pot)
    const potentialWinners = gameState.players.filter(p => !p.folded);
    const winner = potentialWinners[Math.floor(Math.random() * potentialWinners.length)]; // Placeholder for PokerSolver
    
    if (winner) {
        winner.balance += gameState.pot;
        // Save to DB
        await User.findOneAndUpdate({ username: winner.name }, { $inc: { balance: gameState.pot } });
    }

    io.emit('gameState', gameState);

    // Restart in 5s
    setTimeout(() => startNewHand(), 5000);
};

const startNewHand = () => {
    if (gameState.players.length < 2) { gameState.phase = 'waiting'; io.emit('gameState', gameState); return; }
    
    gameState.deck = createDeck();
    gameState.communityCards = [];
    gameState.pot = 0;
    gameState.phase = 'preflop';
    gameState.highestBet = 20;
    gameState.turnIndex = 0;

    gameState.players.forEach(p => {
        p.hand = [gameState.deck.pop(), gameState.deck.pop()];
        p.folded = false;
        p.currentBet = 0;
    });
    io.emit('gameState', gameState);
};

io.on('connection', (socket) => {
    socket.on('joinGame', async ({ userId, buyIn }) => {
        const user = await User.findById(userId);
        if (!user || gameState.players.find(p => p.dbId === userId)) return;

        // Deduct Buy-in
        await User.findByIdAndUpdate(userId, { $inc: { balance: -buyIn } });
        
        gameState.players.push({
            id: socket.id, dbId: userId, name: user.username,
            balance: buyIn, hand: [], currentBet: 0, folded: false
        });

        if (gameState.players.length >= 2 && gameState.phase === 'waiting') startNewHand();
        else io.emit('gameState', gameState);
    });

    socket.on('action', ({ type, amount }) => {
        const player = gameState.players.find(p => p.id === socket.id);
        const currentPlayer = gameState.players[gameState.turnIndex];
        
        // Strict Turn Check
        if (!player || player.id !== currentPlayer.id) return; 

        if (type === 'fold') {
            player.folded = true;
        } else if (type === 'raise') {
            player.balance -= amount;
            player.currentBet += amount;
            gameState.pot += amount;
            gameState.highestBet = player.currentBet;
        } else if (type === 'call') { // or check
            const toCall = gameState.highestBet - player.currentBet;
            if (toCall > 0) {
                player.balance -= toCall;
                player.currentBet += toCall;
                gameState.pot += toCall;
            }
        }
        
        // Check if stage is done (Last player acted)
        if (gameState.turnIndex === gameState.players.length - 1) {
             gameState.turnIndex = 0;
             nextStage();
        } else {
             nextTurn();
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 GAME SERVER RUNNING ON ${PORT}`));