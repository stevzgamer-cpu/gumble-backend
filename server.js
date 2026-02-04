const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const client = new OAuth2Client("67123336647-b00rcsb6ni8s8unhi3qqg0bk6l2es62l.apps.googleusercontent.com");

app.use(cors());
app.use(express.json());

// --- Database Connection ---
mongoose.connect('mongodb://localhost:27017/gumblevip', { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB Connected: GUMBLEVIP Ledger Active'));

// --- Schemas ---
const UserSchema = new mongoose.Schema({
  googleId: String,
  name: String,
  email: String,
  balance: { type: Number, default: 1000.00 } // Default $1000 balance
});
const User = mongoose.model('User', UserSchema);

// --- Auth Routes ---
app.post('/api/auth/google', async (req, res) => {
  const { token } = req.body;
  try {
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: "67123336647-b00rcsb6ni8s8unhi3qqg0bk6l2es62l.apps.googleusercontent.com"
    });
    const payload = ticket.getPayload();
    
    let user = await User.findOne({ googleId: payload.sub });
    if (!user) {
      user = new User({ googleId: payload.sub, name: payload.name, email: payload.email });
      await user.save();
    }
    res.json(user);
  } catch (err) {
    res.status(401).json({ error: "Auth failed" });
  }
});

app.get('/api/user/:id', async (req, res) => {
  const user = await User.findById(req.params.id);
  res.json(user);
});

// --- GAME LOGIC ENDPOINTS ---

// 1. MINES LOGIC
app.post('/api/mines/play', async (req, res) => {
  const { userId, bet, minesCount } = req.body;
  const user = await User.findById(userId);
  if (user.balance < bet) return res.status(400).json({ error: "Insufficient funds" });

  user.balance -= bet;
  await user.save();
  
  // Logic: Create grid, hide mines (0 = safe, 1 = mine)
  // In production, we salt and hash this.
  let grid = Array(25).fill(0);
  let indices = [];
  while(indices.length < minesCount) {
    let r = Math.floor(Math.random() * 25);
    if(indices.indexOf(r) === -1) { indices.push(r); grid[r] = 1; }
  }

  // Calculate multipliers based on mine count
  const multiplierBase = 0.99 * (25 / (25 - minesCount)); // House edge math
  
  io.emit('balanceUpdate', { userId, balance: user.balance });
  res.json({ active: true, grid: grid, multiplierBase, currentMult: 1.0 });
});

app.post('/api/mines/cashout', async (req, res) => {
  const { userId, winAmount } = req.body;
  const user = await User.findById(userId);
  user.balance += winAmount;
  await user.save();
  io.emit('balanceUpdate', { userId, balance: user.balance });
  res.json({ success: true, newBalance: user.balance });
});

// 2. BLACKJACK LOGIC (Simplified for Demo)
// Note: In a full prod env, we persist deck state in DB to prevent refresh cheating.
const cardValues = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '0': 10, 'J': 10, 'Q': 10, 'K': 10, 'A': 11 };

app.post('/api/blackjack/deal', async (req, res) => {
  const { userId, bet } = req.body;
  const user = await User.findById(userId);
  if (user.balance < bet) return res.status(400).json({ error: "Insufficient funds" });

  user.balance -= bet;
  await user.save();
  io.emit('balanceUpdate', { userId, balance: user.balance });

  // Draw 4 cards (Player, Dealer, Player, Dealer)
  // Using DeckOfCardsAPI format: { code: 'AS', value: 'ACE', image: '...' }
  // Here we mock the internal logic or call external API. 
  // For speed/reliability, we generate internal state.
  const suits = ['H', 'D', 'C', 'S'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '0', 'J', 'Q', 'K', 'A'];
  
  const draw = () => {
    const s = suits[Math.floor(Math.random() * suits.length)];
    const r = ranks[Math.floor(Math.random() * ranks.length)];
    return { code: r+s, value: cardValues[r], image: `https://deckofcardsapi.com/static/img/${r}${s}.png` };
  };

  const playerHand = [draw(), draw()];
  const dealerHand = [draw(), draw()];

  res.json({ playerHand, dealerHand, status: 'playing' });
});

app.post('/api/blackjack/payout', async (req, res) => {
  const { userId, multiplier, bet } = req.body;
  const user = await User.findById(userId);
  user.balance += (bet * multiplier);
  await user.save();
  io.emit('balanceUpdate', { userId, balance: user.balance });
  res.json({ success: true });
});

// 3. DRAGON TOWER
app.post('/api/tower/play', async (req, res) => {
  const { userId, bet, difficulty } = req.body; // diff: 'easy' (2/3), 'medium' (1/2), 'hard' (1/3)
  const user = await User.findById(userId);
  if (user.balance < bet) return res.status(400).json({ error: "Funds" });
  
  user.balance -= bet;
  await user.save();
  io.emit('balanceUpdate', { userId, balance: user.balance });

  // Generate 9 rows
  let rows = [];
  let width = 3; // usually 3 or 4 columns
  for(let i=0; i<9; i++) {
    let row = [0, 0, 0]; // 0 = safe, 1 = dragon
    let bombCount = difficulty === 'hard' ? 2 : difficulty === 'medium' ? 1 : 1; 
    // Logic for easy usually 3 cols, 2 safe.
    // Simplifying to: Hard=1 safe, Med=1 safe (of 2), Easy=2 safe (of 3)
    
    let bombIndices = [];
    while(bombIndices.length < bombCount) {
      let r = Math.floor(Math.random() * 3);
      if(!bombIndices.includes(r)) bombIndices.push(r);
    }
    bombIndices.forEach(idx => row[idx] = 1);
    rows.push(row);
  }
  
  res.json({ rows });
});

// 4. KENO
app.post('/api/keno/play', async (req, res) => {
  const { userId, bet, picks } = req.body; // picks is array of 10 numbers
  const user = await User.findById(userId);
  if (user.balance < bet) return res.status(400).json({ error: "Funds" });

  user.balance -= bet;
  await user.save();

  let drawn = [];
  while(drawn.length < 10) {
    let r = Math.floor(Math.random() * 40) + 1;
    if(!drawn.includes(r)) drawn.push(r);
  }

  // Calculate matches
  let matches = 0;
  picks.forEach(p => { if(drawn.includes(p)) matches++; });

  // Payout Table (Simplified)
  const payouts = { 0:0, 1:0, 2:0, 3:1.5, 4:4, 5:10, 6:25, 7:100, 8:500, 9:2000, 10:10000 };
  let win = bet * payouts[matches];
  
  if(win > 0) {
    user.balance += win;
    await user.save();
  }
  
  io.emit('balanceUpdate', { userId, balance: user.balance });
  res.json({ drawn, matches, win });
});

server.listen(5000, () => console.log("GUMBLEVIP Server Running on Port 5000"));