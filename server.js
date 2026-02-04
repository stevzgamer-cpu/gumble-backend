require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
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

// --- GAME 1: BLACKJACK LOGIC ---
const generateDeck = () => ['2','3','4','5','6','7','8','9','10','J','Q','K','A'].flatMap(r=>['h','d','c','s'].map(s=>({rank:r, suit:s}))).sort(()=>Math.random()-.5);
const getVal = (hand) => {
    let val = 0, aces = 0;
    hand.forEach(c => {
        if(['J','Q','K'].includes(c.rank)) val += 10;
        else if(c.rank === 'A') { val += 11; aces++; }
        else val += parseInt(c.rank);
    });
    while(val > 21 && aces > 0) { val -= 10; aces--; }
    return val;
};

// Store active blackjack games in memory
const bjGames = {}; 

app.post('/api/blackjack/deal', async (req, res) => {
    const { userId, bet } = req.body;
    const user = await User.findById(userId);
    if(user.balance < bet) return res.status(400).json({error: "No Funds"});
    
    user.balance -= bet;
    await user.save();

    const deck = generateDeck();
    const playerHand = [deck.pop(), deck.pop()];
    const dealerHand = [deck.pop(), deck.pop()];
    
    bjGames[userId] = { deck, playerHand, dealerHand, bet, status: 'playing' };
    
    // Check Instant Blackjack
    if(getVal(playerHand) === 21) {
        user.balance += bet * 2.5;
        await user.save();
        bjGames[userId].status = 'won';
    }

    res.json({ ...bjGames[userId], dealerHand: [dealerHand[0], {rank:'?', suit:'?'}] }); // Hide dealer 2nd card
});

app.post('/api/blackjack/hit', async (req, res) => {
    const game = bjGames[req.body.userId];
    if(!game || game.status !== 'playing') return res.status(400).json({error: "No Game"});
    
    game.playerHand.push(game.deck.pop());
    const val = getVal(game.playerHand);
    
    if(val > 21) {
        game.status = 'bust';
        // No refund
    }
    res.json({ ...game, dealerHand: [game.dealerHand[0], {rank:'?', suit:'?'}] });
});

app.post('/api/blackjack/stand', async (req, res) => {
    const { userId } = req.body;
    const game = bjGames[userId];
    if(!game) return res.status(400).json({error: "No Game"});
    
    let dVal = getVal(game.dealerHand);
    while(dVal < 17) {
        game.dealerHand.push(game.deck.pop());
        dVal = getVal(game.dealerHand);
    }
    
    const pVal = getVal(game.playerHand);
    const user = await User.findById(userId);

    if(dVal > 21 || pVal > dVal) {
        game.status = 'won';
        user.balance += game.bet * 2;
    } else if (pVal === dVal) {
        game.status = 'push';
        user.balance += game.bet;
    } else {
        game.status = 'lost';
    }
    await user.save();
    res.json(game); // Reveal all
});


// --- GAME 2: MINES LOGIC ---
app.post('/api/mines/play', async (req, res) => {
    const { userId, bet, minesCount, clickedTile } = req.body;
    // Simplified: Single Request = Full Game for simplicity, or complex state.
    // Let's do a simple "Result" logic for immediate outcome (Provably Fair style)
    
    const user = await User.findById(userId);
    if(user.balance < bet) return res.status(400).json({error: "No Funds"});
    
    user.balance -= bet;
    
    // Generate grid
    let grid = Array(25).fill('gem');
    for(let i=0; i<minesCount; i++) grid[i] = 'bomb';
    grid = grid.sort(() => Math.random() - 0.5);

    // If user clicked a bomb
    const result = grid[clickedTile];
    let win = 0;
    
    if (result === 'gem') {
        // Simple multiplier logic: 1.2x to 5x based on mines
        const mult = 1 + (minesCount * 0.15); 
        win = Math.floor(bet * mult);
        user.balance += win;
    }
    
    await user.save();
    res.json({ result, grid, newBalance: user.balance, win });
});


// --- GAME 3: KENO LOGIC ---
app.post('/api/keno/play', async (req, res) => {
    const { userId, bet, numbers } = req.body;
    const user = await User.findById(userId);
    if(user.balance < bet) return res.status(400).json({error: "No Funds"});
    
    user.balance -= bet;
    
    // Draw 10 numbers
    const draw = [];
    while(draw.length < 10) {
        const n = Math.floor(Math.random() * 40) + 1;
        if(!draw.includes(n)) draw.push(n);
    }
    
    const matches = numbers.filter(n => draw.includes(n)).length;
    let payout = 0;
    
    // Payout Table
    if(matches >= 2) payout = bet * matches; 
    if(matches >= 5) payout = bet * (matches * 2);
    
    user.balance += payout;
    await user.save();
    res.json({ draw, matches, payout, newBalance: user.balance });
});

// --- GAME 4: DRAGON TOWER LOGIC ---
app.post('/api/dragon/play', async (req, res) => {
    const { userId, bet, difficulty } = req.body; // difficulty: 'easy' (2/3 safe), 'hard' (1/3 safe)
    const user = await User.findById(userId);
    if(user.balance < bet) return res.status(400).json({error: "No Funds"});

    user.balance -= bet;

    const isSafe = Math.random() > (difficulty === 'hard' ? 0.6 : 0.3);
    let win = 0;
    
    if(isSafe) {
        const mult = difficulty === 'hard' ? 2.5 : 1.4;
        win = Math.floor(bet * mult);
        user.balance += win;
    }

    await user.save();
    res.json({ result: isSafe ? 'safe' : 'dead', win, newBalance: user.balance });
});

app.listen(process.env.PORT || 10000);