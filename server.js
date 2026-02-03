require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const { Server } = require('socket.io');
const { Hand } = require('pokersolver'); // THE MAGIC MATH LIBRARY
const User = require('./models/User');

const app = express();
app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ DB Error:", err));

// --- 1. WALLET & AUTH ENDPOINTS ---
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

app.post('/api/wallet', async (req, res) => {
    const { userId, amount, type } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (type === 'deposit') {
        user.balance += Number(amount);
    } else if (type === 'withdraw') {
        if (user.balance < amount) return res.status(400).json({ error: "Insufficient funds" });
        user.balance -= Number(amount);
    }
    await user.save();
    res.json(user);
});

// --- 2. POKER ENGINE ---
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
  dealerIndex: 0,
  timer: 30
};

let turnTimeout;

const suits = ['h', 'd', 'c', 's'];
const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

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
            const p = gameState.players[gameState.turnIndex];
            if(p) handleAction(p.id, 'fold', 0);
        }
        io.emit('gameState', gameState);
    }, 1000);
};

const nextStage = () => {
    clearInterval(turnTimeout);
    
    // Check if only one player left
    const active = gameState.players.filter(p => !p.folded);
    if (active.length === 1) { endHand(active[0]); return; }

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
        determineWinner(); return; // REAL EVALUATION
    }
    
    // Reset betting for new round
    gameState.players.forEach(p => p.currentBet = 0);
    gameState.highestBet = 0;
    
    // First active player after dealer starts
    gameState.turnIndex = (gameState.dealerIndex + 1) % gameState.players.length;
    while (gameState.players[gameState.turnIndex].folded) {
         gameState.turnIndex = (gameState.turnIndex + 1) % gameState.players.length;
    }
    
    io.emit('gameState', gameState);
    startTurnTimer();
};

const nextTurn = () => {
    let active = gameState.players.filter(p => !p.folded);
    if (active.length === 1) { endHand(active[0]); return; }

    // Logic to detect if round is over (everyone matched bets)
    // Simplified: Just cycle for now.
    
    do {
        gameState.turnIndex = (gameState.turnIndex + 1) % gameState.players.length;
    } while (gameState.players[gameState.turnIndex].folded);
    
    // If we wrapped around to the person who started the betting and bets match, next stage
    // (In full implementation, we track 'lastAggressor')
    
    io.emit('gameState', gameState);
    startTurnTimer();
};

const handleAction = (socketId, type, amount) => {
    const player = gameState.players.find(p => p.id === socketId);
    if (!player || gameState.players[gameState.turnIndex].id !== socketId) return;

    if (type === 'fold') player.folded = true;
    if (type === 'raise') {
        const total = amount;
        const diff = total - player.currentBet;
        player.balance -= diff;
        player.currentBet = total;
        gameState.pot += diff;
        gameState.highestBet = total;
    }
    if (type === 'call') {
        const diff = gameState.highestBet - player.currentBet;
        player.balance -= diff;
        player.currentBet += diff;
        gameState.pot += diff;
    }

    // Check if this was the last player to act (Basic check)
    // For V2: We move to next player
    nextTurn();
};

const determineWinner = async () => {
    gameState.phase = 'showdown';
    io.emit('gameState', gameState);

    // --- REAL TEXAS LOGIC USING POKERSOLVER ---
    const activePlayers = gameState.players.filter(p => !p.folded);
    const hands = activePlayers.map(p => {
        // Convert '0' to 'T' for solver if needed
        const solverHand = Hand.solve([...p.hand, ...gameState.communityCards].map(c => c.replace('0','T')));
        solverHand.owner = p.dbId; // Tag the hand with User ID
        return solverHand;
    });

    const winners = Hand.winners(hands); // Returns array of winning hands
    const winnerId = winners[0].owner;
    
    const winnerPlayer = gameState.players.find(p => p.dbId === winnerId);
    
    console.log(`🏆 Winner: ${winnerPlayer.name} with ${winners[0].descr}`);
    
    if (winnerPlayer) {
        winnerPlayer.balance += gameState.pot;
        await User.findByIdAndUpdate(winnerPlayer.dbId, { $inc: { balance: gameState.pot } });
    }

    setTimeout(startNewHand, 8000); // 8s delay to see cards
};

const endHand = async (winner) => {
    clearInterval(turnTimeout);
    gameState.phase = 'showdown';
    winner.balance += gameState.pot;
    await User.findByIdAndUpdate(winner.dbId, { $inc: { balance: gameState.pot } });
    io.emit('gameState', gameState);
    setTimeout(startNewHand, 5000);
};

const startNewHand = () => {
    if (gameState.players.length < 2) { gameState.phase = 'waiting'; io.emit('gameState', gameState); return; }

    gameState.deck = createDeck();
    gameState.communityCards = [];
    gameState.pot = 0;
    gameState.phase = 'preflop';
    gameState.turnIndex = 0;
    
    // Rotate Dealer
    gameState.dealerIndex = (gameState.dealerIndex + 1) % gameState.players.length;

    // Blinds Logic
    const sbIndex = (gameState.dealerIndex + 1) % gameState.players.length;
    const bbIndex = (gameState.dealerIndex + 2) % gameState.players.length;

    gameState.players.forEach((p, i) => {
        p.hand = [gameState.deck.pop(), gameState.deck.pop()];
        p.folded = false;
        p.currentBet = 0;
        
        // Auto-Post Blinds
        if (i === sbIndex) { p.balance -= 10; p.currentBet = 10; gameState.pot += 10; }
        if (i === bbIndex) { p.balance -= 20; p.currentBet = 20; gameState.pot += 20; }
    });
    
    gameState.highestBet = 20;
    // Turn starts after Big Blind
    gameState.turnIndex = (bbIndex + 1) % gameState.players.length;

    startTurnTimer();
    io.emit('gameState', gameState);
};

io.on('connection', (socket) => {
    socket.on('joinGame', async ({ userId, buyIn }) => {
        const user = await User.findById(userId);
        if (!user || user.balance < buyIn) return;

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
            await User.findByIdAndUpdate(p.dbId, { $inc: { balance: p.balance } }); // Cash out
            gameState.players.splice(pIndex, 1);
            if(gameState.players.length < 2) { 
                gameState.phase = 'waiting'; 
                gameState.pot = 0; 
                clearInterval(turnTimeout);
            }
            io.emit('gameState', gameState);
        }
    });

    socket.on('action', ({ type, amount }) => handleAction(socket.id, type, amount));
});

server.listen(process.env.PORT || 10000);