require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const { Server } = require('socket.io');
const { Hand } = require('pokersolver'); 
const { OAuth2Client } = require('google-auth-library');
const User = require('./models/User');

const app = express();
app.use(cors());
app.use(express.json());

// --- ⚠️ PASTE YOUR GOOGLE CLIENT ID HERE ---
const GOOGLE_CLIENT_ID = "67123336647-b00rcsb6ni8s8unhi3qqg0bk6l2es62l.apps.googleusercontent.com"; 
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ DB Error:", err));

// --- AUTH ---
app.post('/api/google-login', async (req, res) => {
    const { token } = req.body;
    try {
        const ticket = await client.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
        const { name, email } = ticket.getPayload();
        let user = await User.findOne({ email });
        if (!user) user = await User.create({ username: name, email, balance: 10000, password: "" });
        res.json(user);
    } catch (error) { res.status(400).json({ error: "Google Auth Failed" }); }
});

app.post('/api/register', async (req, res) => {
  try {
    const user = await User.create({ username: req.body.username, password: req.body.password, balance: 10000 });
    res.json(user);
  } catch (err) { res.status(400).json({ error: "Username taken" }); }
});

app.post('/api/login', async (req, res) => {
  const user = await User.findOne({ username: req.body.username, password: req.body.password });
  if (user) res.json(user);
  else res.status(400).json({ error: "Invalid credentials" });
});

// --- ENGINE ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const tables = {}; 

['Casual', 'High Rollers'].forEach((name, i) => {
    const id = `t${i+1}`;
    tables[id] = {
        id, name, smallBlind: (i+1)*10, bigBlind: (i+1)*20,
        players: [], communityCards: [], pot: 0, deck: [],
        phase: 'waiting', turnIndex: 0, dealerIndex: 0, highestBet: 0, 
        timer: 30, winners: [], turnTimeout: null
    };
});

const createDeck = () => {
  const suits = ['h', 'd', 'c', 's'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  let deck = [];
  for (let s of suits) for (let r of ranks) deck.push(r + s);
  return deck.sort(() => Math.random() - 0.5);
};

const broadcastTable = (tableId) => {
    if(tables[tableId]) io.to(tableId).emit('gameState', { ...tables[tableId], turnTimeout: null });
};

const nextStage = (tableId) => {
    const table = tables[tableId];
    clearInterval(table.turnTimeout);
    table.players.forEach(p => { p.currentBet = 0; });
    table.highestBet = 0;

    if (table.phase === 'preflop') {
        table.phase = 'flop';
        table.communityCards.push(table.deck.pop(), table.deck.pop(), table.deck.pop());
    } else if (table.phase === 'flop') {
        table.phase = 'turn';
        table.communityCards.push(table.deck.pop());
    } else if (table.phase === 'turn') {
        table.phase = 'river';
        table.communityCards.push(table.deck.pop());
    } else {
        solveHand(tableId); return;
    }
    
    // Start betting left of dealer
    table.turnIndex = (table.dealerIndex + 1) % table.players.length;
    // Ensure we start on an active player
    if(table.players[table.turnIndex].folded) rotateTurn(tableId);
    
    broadcastTable(tableId);
    startTurnTimer(tableId);
};

const rotateTurn = (tableId) => {
    const table = tables[tableId];
    let attempts = 0;
    do {
        table.turnIndex = (table.turnIndex + 1) % table.players.length;
        attempts++;
    } while (table.players[table.turnIndex].folded && attempts < table.players.length);
};

const startTurnTimer = (tableId) => {
    const table = tables[tableId];
    clearInterval(table.turnTimeout);
    table.timer = 30;
    table.turnTimeout = setInterval(() => {
        table.timer--;
        if (table.timer <= 0) {
            clearInterval(table.turnTimeout);
            const p = table.players[table.turnIndex];
            if(p) handleAction(tableId, p.id, 'fold', 0);
        }
        io.to(tableId).emit('timerUpdate', table.timer); 
    }, 1000);
};

const handleAction = (tableId, socketId, type, amount) => {
    const table = tables[tableId];
    if(!table) return;
    
    const player = table.players.find(p => p.id === socketId);
    // STRICT VALIDATION: Is it your turn?
    if (!player || table.players[table.turnIndex].id !== socketId) return;

    if (type === 'fold') player.folded = true;
    else if (type === 'call') {
        const toCall = table.highestBet - player.currentBet;
        player.balance -= toCall;
        player.currentBet += toCall;
        table.pot += toCall;
    } else if (type === 'raise') {
        const total = Number(amount);
        const diff = total - player.currentBet;
        player.balance -= diff;
        player.currentBet = total;
        table.pot += diff;
        table.highestBet = total;
    }

    const active = table.players.filter(p => !p.folded);
    const allMatched = active.every(p => p.currentBet === table.highestBet);
    
    // If everyone matched bets (and it's not just one person left), next stage
    if (allMatched && active.length > 1 && (table.highestBet > 0 || type === 'check')) {
         // Logic check: if everyone checked (bet=0) or called raise
         nextStage(tableId);
    } else {
        rotateTurn(tableId);
        broadcastTable(tableId);
        startTurnTimer(tableId);
    }
};

const solveHand = async (tableId) => {
    const table = tables[tableId];
    table.phase = 'showdown';
    const playersForSolver = table.players.filter(p => !p.folded).map(p => {
        const sevenCards = [...p.hand, ...table.communityCards].map(c => c.replace('0', 'T'));
        const hand = Hand.solve(sevenCards);
        hand.ownerId = p.dbId;
        hand.originalName = p.name;
        return hand;
    });

    const winners = Hand.winners(playersForSolver);
    const payout = Math.floor(table.pot / winners.length);
    table.winners = winners.map(w => w.originalName);

    for (let w of winners) {
        const player = table.players.find(p => p.dbId === w.ownerId);
        if (player) player.balance += payout;
        await User.findByIdAndUpdate(w.ownerId, { $inc: { balance: payout } });
    }
    broadcastTable(tableId);
    setTimeout(() => startNewHand(tableId), 8000);
};

const startNewHand = (tableId) => {
    const table = tables[tableId];
    if (table.players.length < 2) { 
        table.phase = 'waiting'; table.communityCards = []; table.pot = 0; table.winners = [];
        broadcastTable(tableId); return; 
    }
    table.deck = createDeck();
    table.communityCards = [];
    table.pot = 0;
    table.phase = 'preflop';
    table.winners = [];
    table.dealerIndex = (table.dealerIndex + 1) % table.players.length;
    
    // Blinds Logic
    const sb = (table.dealerIndex + 1) % table.players.length;
    const bb = (table.dealerIndex + 2) % table.players.length;

    table.players.forEach((p, i) => {
        p.hand = [table.deck.pop(), table.deck.pop()];
        p.folded = false;
        p.currentBet = 0;
        if (i === sb) { p.balance -= table.smallBlind; p.currentBet = table.smallBlind; table.pot += table.smallBlind; }
        if (i === bb) { p.balance -= table.bigBlind; p.currentBet = table.bigBlind; table.pot += table.bigBlind; table.highestBet = table.bigBlind; }
    });

    // Turn starts AFTER Big Blind
    table.turnIndex = (bb + 1) % table.players.length;
    
    broadcastTable(tableId);
    startTurnTimer(tableId);
};

io.on('connection', (socket) => {
    socket.on('getTables', () => {
        const list = Object.values(tables).map(t => ({ id: t.id, name: t.name, players: t.players.length }));
        socket.emit('tableList', list);
    });

    socket.on('joinTable', async ({ tableId, userId, buyIn }) => {
        const table = tables[tableId];
        const user = await User.findById(userId);
        if (!table || !user) return;
        socket.join(tableId);

        // RECONNECTION FIX
        const existing = table.players.find(p => p.dbId === userId);
        if (existing) { existing.id = socket.id; broadcastTable(tableId); return; }

        if (user.balance < buyIn) return;
        await User.findByIdAndUpdate(userId, { $inc: { balance: -buyIn } });
        table.players.push({ id: socket.id, dbId: userId, name: user.username, balance: buyIn, hand: [], currentBet: 0, folded: false });

        if (table.players.length >= 2 && table.phase === 'waiting') startNewHand(tableId);
        else broadcastTable(tableId);
    });
    
    socket.on('action', ({ tableId, type, amount }) => handleAction(tableId, socket.id, type, amount));
});

server.listen(process.env.PORT || 10000);