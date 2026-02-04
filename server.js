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

// --- AUTH & WALLET ---
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

app.post('/api/login', async (req, res) => {
  const user = await User.findOne({ username: req.body.username, password: req.body.password });
  if (user) res.json(user); else res.status(400).json({ error: "Invalid credentials" });
});

app.post('/api/register', async (req, res) => {
  try {
    const user = await User.create({ username: req.body.username, password: req.body.password, balance: 10000 });
    res.json(user);
  } catch (err) { res.status(400).json({ error: "Username taken" }); }
});

// --- POKER LOGIC ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const tables = {}; 

['Casual', 'High Rollers', 'Pro'].forEach((name, i) => {
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

const broadcast = (tableId) => {
    if(tables[tableId]) io.to(tableId).emit('gameState', { ...tables[tableId], turnTimeout: null });
};

const nextStage = (tableId) => {
    const table = tables[tableId];
    clearInterval(table.turnTimeout);
    table.highestBet = 0;
    table.players.forEach(p => p.actedThisRound = false);

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
    
    // Rotate turn to first active player left of dealer
    table.turnIndex = table.dealerIndex;
    rotateTurn(tableId);
    broadcast(tableId);
    startTimer(tableId);
};

const rotateTurn = (tableId) => {
    const table = tables[tableId];
    let attempts = 0;
    do {
        table.turnIndex = (table.turnIndex + 1) % table.players.length;
        attempts++;
    } while ((table.players[table.turnIndex].folded || table.players[table.turnIndex].balance === 0) && attempts < table.players.length);
};

const startTimer = (tableId) => {
    const table = tables[tableId];
    clearInterval(table.turnTimeout);
    if(table.players.filter(p => !p.folded).length < 2) return;

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
    const p = table.players.find(player => player.id === socketId);
    
    // Strict Validation
    if(!p || table.players[table.turnIndex].id !== socketId) return;

    p.actedThisRound = true;

    if (type === 'fold') {
        p.folded = true;
        const active = table.players.filter(player => !player.folded);
        if (active.length === 1) { endHandImmediate(tableId, active[0]); return; }
    }
    else if (type === 'check') {
        if (table.highestBet > p.currentBet) return; // Cannot check if there is a bet
    }
    else if (type === 'call') {
        const toCall = table.highestBet - p.currentBet;
        const actualBet = Math.min(toCall, p.balance);
        p.balance -= actualBet;
        p.currentBet += actualBet;
        table.pot += actualBet;
    }
    else if (type === 'raise') {
        const totalBet = Number(amount);
        if (totalBet <= table.highestBet) return; // Must be higher
        const diff = totalBet - p.currentBet;
        if (p.balance < diff) return; // Insufficient funds

        p.balance -= diff;
        p.currentBet = totalBet;
        table.pot += diff;
        table.highestBet = totalBet;
        // Re-open betting for others
        table.players.forEach(pl => { if(pl.id !== p.id) pl.actedThisRound = false; });
    }

    // Check if round is over
    const active = table.players.filter(pl => !pl.folded && pl.balance > 0);
    const allMatched = active.every(pl => pl.currentBet === table.highestBet);
    const allActed = active.every(pl => pl.actedThisRound);

    if (allMatched && allActed) {
        nextStage(tableId);
    } else {
        rotateTurn(tableId);
        broadcast(tableId);
        startTimer(tableId);
    }
};

const endHandImmediate = async (tableId, winner) => {
    const table = tables[tableId];
    clearInterval(table.turnTimeout);
    table.phase = 'showdown';
    table.winners = [winner.name];
    
    // Award Pot
    const player = table.players.find(p => p.id === winner.id);
    player.balance += table.pot;
    await User.findByIdAndUpdate(player.dbId, { $inc: { balance: table.pot } });
    
    broadcast(tableId);
    setTimeout(() => startNewHand(tableId), 4000);
};

const solveHand = async (tableId) => {
    const table = tables[tableId];
    table.phase = 'showdown';
    try {
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
            if(player) player.balance += payout;
            await User.findByIdAndUpdate(w.ownerId, { $inc: { balance: payout } });
        }
    } catch(e) { console.log("Solver Error", e); }
    
    broadcast(tableId);
    setTimeout(() => startNewHand(tableId), 8000);
};

const startNewHand = (tableId) => {
    const table = tables[tableId];
    const activePlayers = table.players.filter(p => p.balance > 0);
    
    if (activePlayers.length < 2) { 
        table.phase = 'waiting'; table.communityCards = []; table.pot = 0; table.winners = [];
        broadcast(tableId); return; 
    }

    table.deck = createDeck();
    table.communityCards = [];
    table.pot = 0;
    table.phase = 'preflop';
    table.winners = [];
    
    // Move Dealer
    table.dealerIndex = (table.dealerIndex + 1) % table.players.length;
    
    // Blinds
    const sb = (table.dealerIndex + 1) % table.players.length;
    const bb = (table.dealerIndex + 2) % table.players.length;

    table.players.forEach((p, i) => {
        p.hand = [table.deck.pop(), table.deck.pop()];
        p.folded = false;
        p.actedThisRound = false;
        p.currentBet = 0;
        
        if (i === sb) { 
            const amt = Math.min(p.balance, table.smallBlind);
            p.balance -= amt; p.currentBet = amt; table.pot += amt; 
        }
        if (i === bb) { 
            const amt = Math.min(p.balance, table.bigBlind);
            p.balance -= amt; p.currentBet = amt; table.pot += amt; table.highestBet = amt; 
        }
    });

    table.turnIndex = (bb + 1) % table.players.length;
    broadcast(tableId);
    startTimer(tableId);
};

io.on('connection', (socket) => {
    socket.on('getTables', () => {
        socket.emit('tableList', Object.values(tables).map(t => ({ id: t.id, name: t.name, players: t.players.length })));
    });

    socket.on('joinTable', async ({ tableId, userId, buyIn }) => {
        const table = tables[tableId];
        const user = await User.findById(userId);
        if (!table || !user) return;
        socket.join(tableId);

        const existing = table.players.find(p => p.dbId === userId);
        if (existing) { existing.id = socket.id; broadcast(tableId); return; }

        if (user.balance < buyIn) return;
        await User.findByIdAndUpdate(userId, { $inc: { balance: -buyIn } });
        table.players.push({ id: socket.id, dbId: userId, name: user.username, balance: buyIn, hand: [], currentBet: 0, folded: false, actedThisRound: false });

        if (table.players.length >= 2 && table.phase === 'waiting') startNewHand(tableId);
        else broadcast(tableId);
    });

    socket.on('leaveTable', async ({ tableId }) => {
        const table = tables[tableId];
        if(!table) return;
        const idx = table.players.findIndex(p => p.id === socket.id);
        if (idx !== -1) {
            const p = table.players[idx];
            await User.findByIdAndUpdate(p.dbId, { $inc: { balance: p.balance } });
            table.players.splice(idx, 1);
            socket.leave(tableId);
            if(table.players.length < 2) { table.phase = 'waiting'; clearInterval(table.turnTimeout); }
            broadcast(tableId);
        }
    });

    socket.on('action', ({ tableId, type, amount }) => handleAction(tableId, socket.id, type, amount));
});

server.listen(process.env.PORT || 10000);