const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { OAuth2Client } = require('google-auth-library');

// --- CONFIGURATION ---
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;
const GOOGLE_CLIENT_ID = "67123336647-b00rcsb6ni8s8unhi3qqg0bk6l2es62l.apps.googleusercontent.com";

// --- MIDDLEWARE ---
app.use(cors({
    origin: "*", // Allows connections from any frontend (Mobile/Render/Localhost)
    methods: ["GET", "POST"]
}));
app.use(express.json());

// --- SOCKET.IO SETUP ---
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- DATABASE CONNECTION (SECURE) ---
// Uses Render's Environment Variable if available, otherwise Localhost
const dbURI = process.env.MONGO_URI || 'mongodb://localhost:27017/gumblevip';

mongoose.connect(dbURI)
  .then(() => console.log('✅ MongoDB Connected: Ledger Active'))
  .catch(err => console.error('❌ DB Connection Error:', err));

// --- DATA MODELS ---
const UserSchema = new mongoose.Schema({
  googleId: { type: String, required: true, unique: true },
  name: String,
  email: String,
  balance: { type: Number, default: 1000.00 }, // Starting Balance
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

// --- AUTHENTICATION ROUTE ---
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

app.post('/api/auth/google', async (req, res) => {
  const { token } = req.body;
  try {
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    
    let user = await User.findOne({ googleId: payload.sub });
    
    if (!user) {
      console.log(`🆕 New VIP Registration: ${payload.email}`);
      user = new User({ 
          googleId: payload.sub, 
          name: payload.name, 
          email: payload.email,
          balance: 1000.00 // Welcome Bonus
      });
      await user.save();
    } else {
        console.log(`👤 VIP Login: ${payload.email}`);
    }
    res.json(user);
  } catch (err) {
    console.error("Auth Failed:", err);
    res.status(401).json({ error: "Authentication failed" });
  }
});

// --- GAME LOGIC: MINES ---
app.post('/api/mines/play', async (req, res) => {
  const { userId, bet, minesCount } = req.body;
  
  // validation
  if (bet <= 0) return res.status(400).json({ error: "Invalid bet" });

  const user = await User.findById(userId);
  if (!user || user.balance < bet) return res.status(400).json({ error: "Insufficient funds" });

  // Deduct Bet
  user.balance -= bet;
  await user.save();
  io.emit('balanceUpdate', { userId, balance: user.balance });

  // Generate Grid (Server Side Only)
  let grid = Array(25).fill(0); // 0 = safe, 1 = mine
  let placed = 0;
  while(placed < minesCount) {
    let idx = Math.floor(Math.random() * 25);
    if(grid[idx] === 0) {
      grid[idx] = 1;
      placed++;
    }
  }

  // Calculate Base Multiplier Logic
  // Formula: 0.99 * (25 / (25 - mines))
  const multiplierBase = 1.0 + (minesCount / 25); 

  res.json({ success: true, grid, multiplierBase });
});

app.post('/api/mines/cashout', async (req, res) => {
  const { userId, winAmount } = req.body;
  const user = await User.findById(userId);
  user.balance += winAmount;
  await user.save();
  
  io.emit('balanceUpdate', { userId, balance: user.balance });
  res.json({ success: true, newBalance: user.balance });
});

// --- GAME LOGIC: BLACKJACK ---
// Simple stateless dealer for stability
const ranks = ['2','3','4','5','6','7','8','9','0','J','Q','K','A'];
const suits = ['H','D','C','S'];
const cardValues = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'0':10,'J':10,'Q':10,'K':10,'A':11};

const drawCard = () => {
    const r = ranks[Math.floor(Math.random()*ranks.length)];
    const s = suits[Math.floor(Math.random()*suits.length)];
    // Using deckofcardsapi images
    return { 
        code: r+s, 
        value: cardValues[r], 
        image: `https://deckofcardsapi.com/static/img/${r}${s}.png` 
    };
};

app.post('/api/blackjack/deal', async (req, res) => {
  const { userId, bet } = req.body;
  const user = await User.findById(userId);
  
  if (user.balance < bet) return res.status(400).json({ error: "Funds" });

  user.balance -= bet;
  await user.save();
  io.emit('balanceUpdate', { userId, balance: user.balance });

  const pHand = [drawCard(), drawCard()];
  const dHand = [drawCard(), drawCard()];

  res.json({ playerHand: pHand, dealerHand: dHand });
});

app.post('/api/blackjack/payout', async (req, res) => {
  const { userId, bet, multiplier } = req.body;
  const user = await User.findById(userId);
  
  const winAmount = bet * multiplier;
  user.balance += winAmount;
  await user.save();
  
  io.emit('balanceUpdate', { userId, balance: user.balance });
  res.json({ success: true });
});

// --- SERVER START ---
server.listen(PORT, () => {
  console.log(`🚀 GUMBLEVIP Server Live on Port ${PORT}`);
  console.log(`🔌 Env: ${process.env.MONGO_URI ? 'Production' : 'Local Development'}`);
});