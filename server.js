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

// --- AUTH ---
app.post('/api/register', async (req, res) => {
  try {
    const user = await User.create({ username: req.body.username, password: req.body.password, balance: 1000 });
    res.json(user);
  } catch (err) { res.status(400).json({ error: "Username taken" }); }
});

app.post('/api/login', async (req, res) => {
  const user = await User.findOne({ username: req.body.username, password: req.body.password });
  if (user) res.json(user);
  else res.status(400).json({ error: "Invalid credentials" });
});

// --- GAME ENGINE ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let gameState = {
  roomId: "HighRollers",
  players: [], 
  communityCards: [],
  pot: 0,
  deck: [],
  phase: 'waiting', 
  turnIndex: 0,
  highestBet: 0,
  timer: 30 // Seconds per turn
};

let turnTimeout; // Holds the timer ID

const suits = ['H', 'D', 'C', 'S']; // Capital for image API
const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '0', 'J', 'Q', 'K', 'A']; // 0 = 10

const createDeck = () => {
  let deck = [];
  for (let s of suits) for (let r of ranks) deck.push(r + s);
  return deck.sort(() => Math.random() - 0.5);
};

const startTurnTimer = () => {
    clearInterval(turnTimeout);
    gameState.timer = 30;
    
    turnTimeout = setInterval(() => {
        gameState.timer--;
        if (gameState.timer <= 0) {
            clearInterval(turnTimeout);
            // Auto-Fold logic
            const currentPlayer = gameState.players[gameState.turnIndex];
            if (currentPlayer) {
                console.log(`⏰ Time expired for ${currentPlayer.name}`);
                handleAction(currentPlayer.id, 'fold', 0);
            }
        }
        io.emit('gameState', gameState);
    }, 1000);
};

const nextStage = () => {
    clearInterval(turnTimeout);
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
        endHand(); return;
    }
    
    gameState.players.forEach(p => p.currentBet = 0);
    gameState.highestBet = 0;
    gameState.turnIndex = 0;
    // Find first non-folded player
    while (gameState.players[gameState.turnIndex].folded) {
        gameState.turnIndex = (gameState.turnIndex + 1) % gameState.players.length;
    }
    io.emit('gameState', gameState);
    startTurnTimer();
};

const nextTurn = () => {
    let active = gameState.players.filter(p => !p.folded);
    if (active.length === 1) { endHand(); return; }

    do {
        gameState.turnIndex = (gameState.turnIndex + 1) % gameState.players.length;
    } while (gameState.players[gameState.turnIndex].folded);

    // If loop back to start and bets equal, move stage (Simplified)
    if (gameState.turnIndex === 0 && gameState.highestBet === 0) {
        // In real poker, we'd check action completion, but for now:
        // nextStage(); 
    }
    
    io.emit('gameState', gameState);
    startTurnTimer();
};

const handleAction = (socketId, type, amount) => {
    const player = gameState.players.find(p => p.id === socketId);
    if (!player || gameState.players[gameState.turnIndex].id !== socketId) return;

    if (type === 'fold') player.folded = true;
    if (type === 'raise') {
        const totalBet = amount; // Assuming amount is total bet
        const diff = totalBet - player.currentBet;
        player.balance -= diff;
        player.currentBet = totalBet;
        gameState.pot += diff;
        gameState.highestBet = totalBet;
    }
    if (type === 'call') {
        const diff = gameState.highestBet - player.currentBet;
        player.balance -= diff;
        player.currentBet += diff;
        gameState.pot += diff;
    }

    if (gameState.turnIndex === gameState.players.length - 1) {
        gameState.turnIndex = 0;
        nextStage();
    } else {
        nextTurn();
    }
};

const endHand = async () => {
    clearInterval(turnTimeout);
    gameState.phase = 'showdown';
    const active = gameState.players.filter(p => !p.folded);
    const winner = active[Math.floor(Math.random() * active.length)]; // Random winner for now
    
    if (winner) {
        winner.balance += gameState.pot;
        await User.findByIdAndUpdate(winner.dbId, { $inc: { balance: gameState.pot } });
    }
    io.emit('gameState', gameState);
    setTimeout(startNewHand, 5000);
};

const startNewHand = () => {
    if (gameState.players.length < 2) { 
        gameState.phase = 'waiting'; 
        io.emit('gameState', gameState); 
        return; 
    }
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
    startTurnTimer();
    io.emit('gameState', gameState);
};

io.on('connection', (socket) => {
    socket.on('joinGame', async ({ userId, buyIn }) => {
        const user = await User.findById(userId);
        if (!user || user.balance < buyIn) return;
        
        // Remove from DB balance
        await User.findByIdAndUpdate(userId, { $inc: { balance: -buyIn } });

        gameState.players.push({
            id: socket.id, dbId: userId, name: user.username,
            balance: buyIn, hand: [], currentBet: 0, folded: false
        });

        if (gameState.players.length >= 2 && gameState.phase === 'waiting') startNewHand();
        else io.emit('gameState', gameState);
    });

    socket.on('leaveGame', async () => {
        const pIndex = gameState.players.findIndex(p => p.id === socket.id);
        if (pIndex !== -1) {
            const p = gameState.players[pIndex];
            // Refund table balance to DB
            await User.findByIdAndUpdate(p.dbId, { $inc: { balance: p.balance } });
            gameState.players.splice(pIndex, 1);
            
            // If empty, reset
            if (gameState.players.length < 2) {
                clearInterval(turnTimeout);
                gameState.phase = 'waiting';
                gameState.pot = 0;
                gameState.communityCards = [];
            }
            io.emit('gameState', gameState);
        }
    });

    socket.on('action', ({ type, amount }) => handleAction(socket.id, type, amount));
    socket.on('disconnect', () => { /* Handle disconnect same as leave */ });
});

server.listen(process.env.PORT || 10000);