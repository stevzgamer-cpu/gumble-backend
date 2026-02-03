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

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ DB Error:", err));

// --- AUTH ROUTES ---
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
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

// --- POKER LOGIC ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Game State
let gameState = {
  roomId: "HighRollers",
  players: [], // { id, name, balance, hand, currentBet, folded, isTurn }
  communityCards: [],
  pot: 0,
  deck: [],
  phase: 'waiting', // waiting, betting, flop, turn, river, showdown
  turnIndex: 0,
  highestBet: 0
};

const suits = ['h', 'd', 'c', 's'];
const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

const createDeck = () => {
  let deck = [];
  for (let s of suits) for (let r of ranks) deck.push(r + s);
  return deck.sort(() => Math.random() - 0.5);
};

const nextTurn = () => {
  // Find next active player
  let activeCount = gameState.players.filter(p => !p.folded).length;
  if (activeCount < 2) { endGame(); return; }

  do {
    gameState.turnIndex = (gameState.turnIndex + 1) % gameState.players.length;
  } while (gameState.players[gameState.turnIndex].folded);

  // Check if round is over (simplified: if we are back to start or everyone called)
  // In a real pro engine, we'd check if all bets match.
  // For this V1 Logic: We just cycle turns.
  io.emit('gameState', gameState);
};

const nextStage = () => {
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
    endGame(); // Showdown
    return;
  }
  // Reset bets for new round
  gameState.players.forEach(p => p.currentBet = 0);
  gameState.highestBet = 0;
  io.emit('gameState', gameState);
};

const endGame = async () => {
    gameState.phase = 'showdown';
    // Logic: Split pot or give to last man standing
    // For now: Give pot to random active player (Winner Logic Placeholder)
    const winner = gameState.players.find(p => !p.folded);
    if(winner) {
        winner.balance += gameState.pot;
        // Update DB
        const user = await User.findOne({ username: winner.name });
        if(user) {
            user.balance += gameState.pot;
            await user.save();
        }
    }
    
    io.emit('gameState', gameState);
    
    // Restart after 5 seconds
    setTimeout(() => {
        startNewHand();
    }, 5000);
};

const startNewHand = () => {
  if (gameState.players.length < 2) {
    gameState.phase = 'waiting';
    return;
  }
  
  gameState.deck = createDeck();
  gameState.communityCards = [];
  gameState.pot = 0;
  gameState.phase = 'preflop';
  gameState.highestBet = 20; // Big blind
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
    if (!user || gameState.players.find(p => p.id === socket.id)) return;

    // Deduct Buy-in from DB
    user.balance -= buyIn;
    await user.save();

    gameState.players.push({
      id: socket.id,
      name: user.username,
      balance: buyIn, // Table Balance
      hand: [],
      currentBet: 0,
      folded: false
    });

    if (gameState.players.length >= 2 && gameState.phase === 'waiting') {
      startNewHand();
    } else {
      io.emit('gameState', gameState);
    }
  });

  socket.on('action', ({ type, amount }) => {
    const player = gameState.players.find(p => p.id === socket.id);
    // 1. Validation: Is it my turn?
    if (gameState.players[gameState.turnIndex].id !== socket.id) return;

    if (type === 'fold') {
      player.folded = true;
    } else if (type === 'check') {
      // Allowed only if currentBet == highestBet
    } else if (type === 'raise') {
      player.balance -= amount;
      player.currentBet += amount;
      gameState.pot += amount;
      gameState.highestBet = Math.max(gameState.highestBet, player.currentBet);
    } else if (type === 'call') {
      const diff = gameState.highestBet - player.currentBet;
      player.balance -= diff;
      player.currentBet += diff;
      gameState.pot += diff;
    }

    // Move turn or Next Stage
    // Simple Logic: If player was last to act, move stage
    if (gameState.turnIndex === gameState.players.length - 1) {
        gameState.turnIndex = 0;
        nextStage();
    } else {
        nextTurn();
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Real Poker Engine Running on ${PORT}`));