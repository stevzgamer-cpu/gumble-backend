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

// --- YOUR GOOGLE CLIENT ID ---
const GOOGLE_CLIENT_ID = "67123336647-b00rcsb6ni8s8unhi3qqg0bk6l2es62l.apps.googleusercontent.com"; 
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

mongoose.connect(process.env.MONGO_URI).then(() => console.log("✅ DB Connected"));

// --- AUTH ---
app.post('/api/google-login', async (req, res) => {
    const { token } = req.body;
    try {
        const ticket = await client.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
        const { name, email } = ticket.getPayload();
        let user = await User.findOne({ email });
        if (!user) user = await User.create({ username: name, email, balance: 10000 });
        res.json(user);
    } catch (error) { res.status(400).send(); }
});

app.post('/api/login', async (req, res) => {
  const user = await User.findOne({ username: req.body.username, password: req.body.password });
  if (user) res.json(user); else res.status(400).json({ error: "Fail" });
});

// --- POKER ENGINE ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const tables = {}; 

['Casual', 'High Rollers'].forEach((name, i) => {
    const id = `t${i+1}`;
    tables[id] = { id, name, sb: (i+1)*10, bb: (i+1)*20, players: [], communityCards: [], pot: 0, deck: [], phase: 'waiting', turnIndex: 0, highestBet: 0, winners: [] };
});

const startNewHand = (tableId) => {
    const t = tables[tableId];
    if (t.players.length < 2) { t.phase = 'waiting'; broadcast(tableId); return; }
    t.deck = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'].flatMap(r => ['h','c','d','s'].map(s => r+s)).sort(() => Math.random() - 0.5);
    t.communityCards = []; t.pot = 0; t.phase = 'preflop'; t.winners = [];
    t.players.forEach((p, i) => {
        p.hand = [t.deck.pop(), t.deck.pop()]; p.folded = false; p.acted = false; p.bet = 0;
        if (i === 0) { p.bet = t.sb; p.balance -= t.sb; t.pot += t.sb; }
        if (i === 1) { p.bet = t.bb; p.balance -= t.bb; t.pot += t.bb; t.highestBet = t.bb; }
    });
    t.turnIndex = t.players.length > 2 ? 2 : 0;
    broadcast(tableId);
};

const broadcast = (id) => io.to(id).emit('gameState', tables[id]);

const handleAction = (tableId, sid, type, amt) => {
    const t = tables[tableId];
    const p = t.players.find(pl => pl.id === sid);
    if (!p || t.players[t.turnIndex].id !== sid) return;

    p.acted = true;
    if (type === 'fold') {
        p.folded = true;
        const active = t.players.filter(pl => !pl.folded);
        if (active.length === 1) { 
            active[0].balance += t.pot; 
            t.phase = 'showdown'; t.winners = [active[0].name];
            broadcast(tableId); setTimeout(() => startNewHand(tableId), 4000); return;
        }
    } else if (type === 'call') {
        const diff = t.highestBet - p.bet;
        p.balance -= diff; p.bet += diff; t.pot += diff;
    } else if (type === 'raise') {
        const total = Number(amt);
        const diff = total - p.bet;
        p.balance -= diff; p.bet = total; t.pot += diff; t.highestBet = total;
        t.players.forEach(pl => { if(pl.id !== sid) pl.acted = false; });
    }

    const active = t.players.filter(pl => !pl.folded);
    if (active.every(pl => pl.bet === t.highestBet && pl.acted)) {
        if (t.phase === 'river') solve(tableId); else nextStage(tableId);
    } else {
        do { t.turnIndex = (t.turnIndex + 1) % t.players.length; } while (t.players[t.turnIndex].folded);
        broadcast(tableId);
    }
};

const nextStage = (id) => {
    const t = tables[id];
    t.highestBet = 0; t.players.forEach(pl => { pl.bet = 0; pl.acted = false; });
    if (t.phase === 'preflop') t.communityCards.push(t.deck.pop(), t.deck.pop(), t.deck.pop());
    else t.communityCards.push(t.deck.pop());
    t.phase = t.phase === 'preflop' ? 'flop' : (t.phase === 'flop' ? 'turn' : 'river');
    t.turnIndex = 0; broadcast(id);
};

const solve = (id) => {
    const t = tables[id]; t.phase = 'showdown';
    const hands = t.players.filter(pl => !pl.folded).map(pl => {
        const s = Hand.solve([...pl.hand, ...t.communityCards].map(c => c.replace('0','T')));
        s.name = pl.name; s.dbId = pl.dbId; return s;
    });
    const winners = Hand.winners(hands);
    t.winners = winners.map(w => w.name);
    const payout = t.pot / winners.length;
    winners.forEach(w => {
        const pl = t.players.find(p => p.dbId === w.dbId);
        pl.balance += payout;
        User.findByIdAndUpdate(w.dbId, { $inc: { balance: payout } }).exec();
    });
    broadcast(id); setTimeout(() => startNewHand(id), 8000);
};

io.on('connection', (s) => {
    s.on('joinTable', async ({ tableId, userId, buyIn }) => {
        const user = await User.findById(userId);
        if (!user) return;
        s.join(tableId);
        tables[tableId].players.push({ id: s.id, dbId: userId, name: user.username, balance: buyIn, hand: [], bet: 0, folded: false, acted: false });
        if (tables[tableId].players.length >= 2 && tables[tableId].phase === 'waiting') startNewHand(tableId);
        else broadcast(tableId);
    });
    s.on('action', (d) => handleAction(d.tableId, s.id, d.type, d.amount));
});

server.listen(process.env.PORT || 10000);