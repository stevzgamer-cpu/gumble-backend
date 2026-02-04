require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { OAuth2Client } = require('google-auth-library');
const User = require('./models/User');

const app = express();
app.use(cors());
app.use(express.json());

const GOOGLE_CLIENT_ID = "67123336647-b00rcsb6ni8s8unhi3qqg0bk6l2es62l.apps.googleusercontent.com"; 
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

mongoose.connect(process.env.MONGO_URI).then(() => console.log("✅ DB Connected"));

// --- AUTH ---
app.post('/api/auth/google', async (req, res) => {
    try {
        const ticket = await client.verifyIdToken({ idToken: req.body.token, audience: GOOGLE_CLIENT_ID });
        const { name, email } = ticket.getPayload();
        let user = await User.findOne({ email });
        if (!user) user = await User.create({ username: name, email, balance: 10000 });
        res.json(user);
    } catch (e) { res.status(400).json({ error: "Auth Failed" }); }
});

app.get('/api/user/:id', async (req, res) => {
    const user = await User.findById(req.params.id);
    res.json(user);
});

// --- IN-MEMORY GAME STATE (For active sessions) ---
const games = {}; // { userId: { type: 'mines', bet: 10, state: ... } }

// --- GAME 1: BLACKJACK (Standard) ---
const generateDeck = () => ['2','3','4','5','6','7','8','9','10','J','Q','K','A'].flatMap(r=>['h','d','c','s'].map(s=>({rank:r, suit:s}))).sort(()=>Math.random()-.5);
const getBjVal = (hand) => {
    let val = 0, aces = 0;
    hand.forEach(c => {
        if(['J','Q','K'].includes(c.rank)) val += 10;
        else if(c.rank === 'A') { val += 11; aces++; }
        else val += parseInt(c.rank);
    });
    while(val > 21 && aces > 0) { val -= 10; aces--; }
    return val;
};

app.post('/api/blackjack/deal', async (req, res) => {
    const { userId, bet } = req.body;
    const user = await User.findById(userId);
    if(user.balance < bet) return res.status(400).json({error: "Funds"});
    user.balance -= bet; await user.save();

    const deck = generateDeck();
    const pHand = [deck.pop(), deck.pop()];
    const dHand = [deck.pop(), deck.pop()];
    games[userId] = { type: 'bj', deck, pHand, dHand, bet, status: 'playing' };

    if(getBjVal(pHand) === 21) {
        user.balance += bet * 2.5; await user.save();
        games[userId].status = 'blackjack';
    }
    res.json({ ...games[userId], dHand: [dHand[0], {rank:'?', suit:'?'}] });
});

app.post('/api/blackjack/action', async (req, res) => {
    const { userId, action } = req.body; // hit or stand
    const g = games[userId];
    if(!g || g.type !== 'bj') return res.status(400);

    if(action === 'hit') {
        g.pHand.push(g.deck.pop());
        if(getBjVal(g.pHand) > 21) { g.status = 'bust'; delete games[userId]; }
    } else {
        while(getBjVal(g.dHand) < 17) g.dHand.push(g.deck.pop());
        const pVal = getBjVal(g.pHand);
        const dVal = getBjVal(g.dHand);
        const user = await User.findById(userId);
        
        if(dVal > 21 || pVal > dVal) { g.status = 'won'; user.balance += g.bet * 2; }
        else if(pVal === dVal) { g.status = 'push'; user.balance += g.bet; }
        else { g.status = 'lost'; }
        await user.save();
        delete games[userId];
    }
    res.json(g);
});

// --- GAME 2: MINES (With Cashout & Multipliers) ---
app.post('/api/mines/start', async (req, res) => {
    const { userId, bet, mines } = req.body;
    const user = await User.findById(userId);
    if(user.balance < bet) return res.status(400).json({error: "Funds"});
    user.balance -= bet; await user.save();

    // Generate Board
    let grid = Array(25).fill('gem');
    for(let i=0; i<mines; i++) grid[i] = 'bomb';
    grid = grid.sort(()=>Math.random()-.5);

    games[userId] = { 
        type: 'mines', bet, mines, grid, 
        revealed: Array(25).fill(false), 
        status: 'playing', multiplier: 1.0, 
        nextPayout: bet 
    };
    res.json({ status: 'playing', revealed: Array(25).fill(false), multiplier: 1.0, nextPayout: bet });
});

app.post('/api/mines/click', async (req, res) => {
    const { userId, tile } = req.body;
    const g = games[userId];
    if(!g || g.type !== 'mines') return res.status(400);

    if(g.grid[tile] === 'bomb') {
        g.status = 'boom';
        g.revealed[tile] = true;
        delete games[userId];
        res.json({ status: 'boom', grid: g.grid }); // Show all
    } else {
        g.revealed[tile] = true;
        // Calculate Multiplier: Classic Probability Math
        const tilesLeft = 25 - g.revealed.filter(Boolean).length;
        const gemsLeft = 25 - g.mines - (g.revealed.filter(Boolean).length - 1); // -1 because we just found one? No.
        // Simplified Math: 0.99 * (25 / (25 - mines - found))
        const found = g.revealed.filter(Boolean).length;
        g.multiplier = g.multiplier * ( (25 - found + 1) / (25 - g.mines - found + 1) );
        g.nextPayout = g.bet * g.multiplier;
        
        res.json({ status: 'playing', revealed: g.revealed, multiplier: g.multiplier, nextPayout: g.nextPayout });
    }
});

app.post('/api/mines/cashout', async (req, res) => {
    const { userId } = req.body;
    const g = games[userId];
    if(!g || g.type !== 'mines') return res.status(400);

    const win = g.bet * g.multiplier;
    const user = await User.findById(userId);
    user.balance += win;
    await user.save();
    delete games[userId];
    res.json({ status: 'cashed_out', win });
});

// --- GAME 3: DRAGON TOWER (Row by Row) ---
const DRAGON_MULTS = { 'easy': [1.2, 1.5, 1.9, 2.4, 3.1, 4.0, 5.2, 7.0], 'hard': [1.9, 3.8, 7.6, 15.2, 30.4, 60.8] };

app.post('/api/dragon/start', async (req, res) => {
    const { userId, bet, difficulty } = req.body;
    const user = await User.findById(userId);
    if(user.balance < bet) return res.status(400).json({error: "Funds"});
    user.balance -= bet; await user.save();

    games[userId] = { 
        type: 'dragon', bet, difficulty, 
        row: 0, status: 'playing', 
        history: [] // record safe steps
    };
    res.json({ status: 'playing', row: 0, multiplier: 1.0 });
});

app.post('/api/dragon/step', async (req, res) => {
    const { userId, choice } = req.body; // 0, 1, 2
    const g = games[userId];
    if(!g || g.type !== 'dragon') return res.status(400);

    // Logic: Hard = 1 safe out of 3. Easy = 2 safe out of 3.
    const isSafe = Math.random() > (g.difficulty === 'hard' ? 0.66 : 0.33);
    
    if(!isSafe) {
        g.status = 'dead';
        delete games[userId];
        res.json({ status: 'dead' });
    } else {
        g.row++;
        g.history.push(choice);
        const mult = DRAGON_MULTS[g.difficulty][g.row - 1] || (g.row * 2); // Fallback
        g.multiplier = mult;
        res.json({ status: 'playing', row: g.row, multiplier: mult, payout: g.bet * mult });
    }
});

app.post('/api/dragon/cashout', async (req, res) => {
    const { userId } = req.body;
    const g = games[userId];
    if(!g) return res.status(400);
    
    const win = g.bet * (g.multiplier || 1);
    const user = await User.findById(userId);
    user.balance += win; await user.save();
    delete games[userId];
    res.json({ status: 'cashed_out', win });
});

app.listen(process.env.PORT || 10000);