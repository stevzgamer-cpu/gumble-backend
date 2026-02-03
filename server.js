require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const { Server } = require('socket.io');
const { Hand } = require('pokersolver'); 
const User = require('./models/User');

const app = express();
app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ DB Error:", err));

// --- AUTH & WALLET ---
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

    if (type === 'deposit') user.balance += Number(amount);
    if (type === 'withdraw') {
        if (user.balance < amount) return res.status(400).json({ error: "Insufficient funds" });
        user.balance -= Number(amount);
    }
    await user.save();
    res.json(user);
});

// --- POKER ENGINE ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let gameState = {
  roomId: "HighRollers",
  players: [], communityCards: [], pot: 0, deck: [],
  phase: 'waiting', turnIndex: 0, dealerIndex: 0, highestBet: 0, timer: 30, winners: []
};
let turnTimeout;

const createDeck = () => {
  const suits = ['h', 'd', 'c', 's'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  let deck = [];
  for (let s of suits) for (let r of ranks) deck.push(r + s);
  return deck.sort(() => Math.random() - 0.5);
};

const nextStage = () => {
    clearInterval(turnTimeout);
    gameState.players.forEach(p => { p.currentBet = 0; });
    gameState.highestBet = 0;

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
        solveHand(); return;
    }
    
    rotateTurn();
    io.emit('gameState', gameState);
    startTurnTimer();
};

const rotateTurn = () => {
    let attempts = 0;
    do {
        gameState.turnIndex = (gameState.turnIndex + 1) % gameState.players.length;
        attempts++;
    } while (gameState.players[gameState.turnIndex].folded && attempts < gameState.players.length);
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

const handleAction = (socketId, type, amount) => {
    const player = gameState.players.find(p => p.id === socketId);
    if (!player || gameState.players[gameState.turnIndex].id !== socketId) return;

    if (type === 'fold') player.folded = true;
    else if (type === 'call') {
        const toCall = gameState.highestBet - player.currentBet;
        player.balance -= toCall;
        player.currentBet += toCall;
        gameState.pot += toCall;
    } else if (type === 'raise') {
        const total = Number(amount);
        const diff = total - player.currentBet;
        player.balance -= diff;
        player.currentBet = total;
        gameState.pot += diff;
        gameState.highestBet = total;
    }

    const active = gameState.players.filter(p => !p.folded);
    const allMatched = active.every(p => p.currentBet === gameState.highestBet);
    
    if (allMatched && active.length > 1) nextStage();
    else {
        rotateTurn();
        io.emit('gameState', gameState);
        startTurnTimer();
    }
};

const solveHand = async () => {
    gameState.phase = 'showdown';
    const playersForSolver = gameState.players.filter(p => !p.folded).map(p => {
        const sevenCards = [...p.hand, ...gameState.communityCards].map(c => c.replace('0', 'T'));
        const hand = Hand.solve(sevenCards);
        hand.ownerId = p.dbId;
        hand.originalName = p.name;
        return hand;
    });

    const winners = Hand.winners(playersForSolver);
    const payout = Math.floor(gameState.pot / winners.length);
    gameState.winners = winners.map(w => w.originalName);

    for (let w of winners) {
        const player = gameState.players.find(p => p.dbId === w.ownerId);
        if (player) player.balance += payout;
        await User.findByIdAndUpdate(w.ownerId, { $inc: { balance: payout } });
    }

    io.emit('gameState', gameState);
    setTimeout(startNewHand, 8000);
};

const startNewHand = () => {
    if (gameState.players.length < 2) { 
        gameState.phase = 'waiting'; gameState.communityCards = []; gameState.pot = 0; gameState.winners = [];
        io.emit('gameState', gameState); return; 
    }

    gameState.deck = createDeck();
    gameState.communityCards = [];
    gameState.pot = 0;
    gameState.phase = 'preflop';
    gameState.winners = [];
    gameState.dealerIndex = (gameState.dealerIndex + 1) % gameState.players.length;
    
    const sb = (gameState.dealerIndex + 1) % gameState.players.length;
    const bb = (gameState.dealerIndex + 2) % gameState.players.length;

    gameState.players.forEach((p, i) => {
        p.hand = [gameState.deck.pop(), gameState.deck.pop()];
        p.folded = false;
        p.currentBet = 0;
        if (i === sb) { p.balance -= 10; p.currentBet = 10; gameState.pot += 10; }
        if (i === bb) { p.balance -= 20; p.currentBet = 20; gameState.pot += 20; gameState.highestBet = 20; }
    });

    gameState.turnIndex = (bb + 1) % gameState.players.length;
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
        const idx = gameState.players.findIndex(p => p.id === socket.id);
        if (idx !== -1) {
            const p = gameState.players[idx];
            await User.findByIdAndUpdate(p.dbId, { $inc: { balance: p.balance } });
            gameState.players.splice(idx, 1);
            if(gameState.players.length < 2) { gameState.phase = 'waiting'; clearInterval(turnTimeout); }
            io.emit('gameState', gameState);
        }
    });

    socket.on('action', ({ type, amount }) => handleAction(socket.id, type, amount));
});

server.listen(process.env.PORT || 10000);