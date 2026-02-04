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

// --- SESSION STORAGE ---
const games = {}; 

// --- BLACKJACK LOGIC (Hit, Stand, Double) ---
const getBjVal = (hand) => {
    let val = 0, aces = 0;
    hand.forEach(c => {
        if(['0','J','Q','K'].includes(c.rank)) val += 10;
        else if(c.rank === 'A') { val += 11; aces++; }
        else val += parseInt(c.rank);
    });
    while(val > 21 && aces > 0) { val -= 10; aces--; }
    return val;
};

// Real Card API Format: 2H, 0D (10 of Diamonds), AS, etc.
const generateDeck = () => ['2','3','4','5','6','7','8','9','0','J','Q','K','A'].flatMap(r=>['H','D','C','S'].map(s=>({code:r+s, rank:r, suit:s}))).sort(()=>Math.random()-.5);

app.post('/api/blackjack/deal', async (req, res) => {
    const { userId, bet } = req.body;
    const user = await User.findById(userId);
    if(user.balance < bet) return res.status(400).json({error: "Funds"});
    user.balance -= bet; await user.save();

    const deck = generateDeck();
    const pHand = [deck.pop(), deck.pop()];
    const dHand = [deck.pop(), deck.pop()];
    games[userId] = { type: 'bj', deck, pHand, dHand, bet, status: 'playing', canDouble: true };

    if(getBjVal(pHand) === 21) {
        user.balance += bet * 2.5; await user.save();
        games[userId].status = 'blackjack';
    }
    res.json({ ...games[userId], dHand: [dHand[0], {code:'BACK'}] });
});

app.post('/api/blackjack/action', async (req, res) => {
    const { userId, action } = req.body; 
    const g = games[userId];
    if(!g || g.type !== 'bj') return res.status(400);
    const user = await User.findById(userId);

    if(action === 'hit' || action === 'double') {
        if(action === 'double') {
            if(user.balance < g.bet) return res.status(400).json({error: "No funds to double"});
            user.balance -= g.bet;
            g.bet *= 2;
            g.pHand.push(g.deck.pop());
            // Double forces stand after 1 card usually, or we check bust immediately
            if(getBjVal(g.pHand) > 21) { g.status = 'bust'; delete games[userId]; }
            else { 
                // Auto stand logic for double
                await resolveDealer(g, user); 
            }
        } else {
            g.pHand.push(g.deck.pop());
            g.canDouble = false;
            if(getBjVal(g.pHand) > 21) { g.status = 'bust'; delete games[userId]; }
        }
    } else if (action === 'stand') {
        await resolveDealer(g, user);
    }
    await user.save();
    res.json(g);
});

async function resolveDealer(g, user) {
    while(getBjVal(g.dHand) < 17) g.dHand.push(g.deck.pop());
    const pVal = getBjVal(g.pHand);
    const dVal = getBjVal(g.dHand);
    
    if(dVal > 21 || pVal > dVal) { g.status = 'won'; user.balance += g.bet * 2; }
    else if(pVal === dVal) { g.status = 'push'; user.balance += g.bet; }
    else { g.status = 'lost'; }
    delete games[userId];
}

// --- DRAGON TOWER (Professional Logic) ---
// Multipliers: Row 1 to 9
const DRAGON_MULTS = { 
    'easy': [1.2, 1.5, 1.9, 2.4, 3.0, 4.0, 5.5, 7.5, 10.0], 
    'medium': [1.5, 2.2, 3.4, 5.1, 7.6, 11.5, 17.0, 26.0, 40.0],
    'hard': [2.9, 8.7, 26.1, 78.3, 235.0, 705.0, 2115.0, 6345.0, 19000.0] 
};

app.post('/api/dragon/start', async (req, res) => {
    const { userId, bet, difficulty } = req.body;
    const user = await User.findById(userId);
    if(user.balance < bet) return res.status(400).json({error: "Funds"});
    user.balance -= bet; await user.save();

    games[userId] = { 
        type: 'dragon', bet, difficulty, 
        row: 0, status: 'playing', multiplier: 1.0
    };
    res.json({ status: 'playing', row: 0, multiplier: 1.0 });
});

app.post('/api/dragon/step', async (req, res) => {
    const { userId, choice } = req.body; // 0, 1, 2
    const g = games[userId];
    if(!g || g.type !== 'dragon') return res.status(400);

    // Hard: 1/3 chance win. Medium: 1/2. Easy: 2/3.
    const threshold = g.difficulty === 'hard' ? 0.33 : (g.difficulty === 'medium' ? 0.5 : 0.66);
    const isSafe = Math.random() < threshold;

    if(!isSafe) {
        g.status = 'dead';
        delete games[userId];
        res.json({ status: 'dead', row: g.row });
    } else {
        g.row++;
        g.multiplier = DRAGON_MULTS[g.difficulty][g.row - 1];
        res.json({ status: 'playing', row: g.row, multiplier: g.multiplier, payout: g.bet * g.multiplier });
    }
});

app.post('/api/dragon/cashout', async (req, res) => {
    const { userId } = req.body;
    const g = games[userId];
    if(!g) return res.status(400);
    const win = g.bet * g.multiplier;
    const user = await User.findById(userId);
    user.balance += win; await user.save();
    delete games[userId];
    res.json({ status: 'cashed_out', win });
});

app.listen(process.env.PORT || 10000);