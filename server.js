const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;
const GOOGLE_CLIENT_ID = "67123336647-b00rcsb6ni8s8unhi3qqg0bk6l2es62l.apps.googleusercontent.com";

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());

const io = new Server(server, { cors: { origin: "*" } });

// DB Connection
const dbURI = process.env.MONGO_URI || 'mongodb://localhost:27017/gumblevip';
mongoose.connect(dbURI)
  .then(() => console.log('✅ Ledger Active'))
  .catch(err => console.error('❌ DB Error:', err));

const UserSchema = new mongoose.Schema({
  googleId: String, name: String, email: String, balance: { type: Number, default: 1000.00 }
});
const User = mongoose.model('User', UserSchema);

const client = new OAuth2Client(GOOGLE_CLIENT_ID);

// --- AUTH ---
app.post('/api/auth/google', async (req, res) => {
  const { token } = req.body;
  try {
    const ticket = await client.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    let user = await User.findOne({ googleId: payload.sub });
    if (!user) {
      user = new User({ googleId: payload.sub, name: payload.name, email: payload.email, balance: 1000 });
      await user.save();
    }
    res.json(user);
  } catch (err) { res.status(401).json({ error: "Auth failed" }); }
});

// --- HELPER: UPDATE BALANCE ---
async function updateBalance(userId, amount, socketId) {
    const user = await User.findById(userId);
    user.balance += amount;
    await user.save();
    io.emit('balanceUpdate', { userId, balance: user.balance });
    return user.balance;
}

// --- GAME 1: MINES ---
app.post('/api/mines/play', async (req, res) => {
  const { userId, bet, minesCount } = req.body;
  await updateBalance(userId, -bet);
  
  let grid = Array(25).fill(0);
  let placed = 0;
  while(placed < minesCount) {
    let i = Math.floor(Math.random()*25);
    if(grid[i]===0) { grid[i]=1; placed++; }
  }
  res.json({ grid });
});

app.post('/api/mines/cashout', async (req, res) => {
  const { userId, winAmount } = req.body;
  await updateBalance(userId, winAmount);
  res.json({ success: true });
});

// --- GAME 2: BLACKJACK ---
// (Simplified for reliability)
const getCard = () => {
    const r = ['2','3','4','5','6','7','8','9','0','J','Q','K','A'][Math.floor(Math.random()*13)];
    const s = ['H','D','C','S'][Math.floor(Math.random()*4)];
    const v = (r==='A') ? 11 : (['J','Q','K','0'].includes(r) ? 10 : parseInt(r));
    return { code: r+s, value: v, image: `https://deckofcardsapi.com/static/img/${r}${s}.png` };
};

app.post('/api/blackjack/deal', async (req, res) => {
    const { userId, bet } = req.body;
    await updateBalance(userId, -bet);
    res.json({ playerHand: [getCard(), getCard()], dealerHand: [getCard(), getCard()] });
});

app.post('/api/blackjack/hit', async (req, res) => {
    res.json({ card: getCard() });
});

app.post('/api/blackjack/payout', async (req, res) => {
    const { userId, amount } = req.body;
    await updateBalance(userId, amount);
    res.json({ success: true });
});

// --- GAME 3: DRAGON TOWER ---
// Logic: 9 Rows. Difficulty determines bombs per row.
app.post('/api/dragon/play', async (req, res) => {
    const { userId, bet, difficulty } = req.body;
    // Easy: 1 Bomb (2 Safe), Medium: 1 Bomb (2 Safe) - Adjusted for demo
    // Hard: 2 Bombs (1 Safe)
    await updateBalance(userId, -bet);
    
    const rows = [];
    const bombCount = difficulty === 'HARD' ? 2 : 1;
    
    for(let i=0; i<9; i++) {
        let row = [0, 0, 0]; // 0=Safe, 1=Dragon
        let bombs = 0;
        while(bombs < bombCount) {
            let r = Math.floor(Math.random()*3);
            if(row[r]===0) { row[r]=1; bombs++; }
        }
        rows.push(row);
    }
    res.json({ rows });
});

app.post('/api/dragon/cashout', async (req, res) => {
    const { userId, amount } = req.body;
    await updateBalance(userId, amount);
    res.json({ success: true });
});

// --- GAME 4: KENO ---
app.post('/api/keno/play', async (req, res) => {
    const { userId, bet, picks } = req.body;
    await updateBalance(userId, -bet);

    // Draw 10 numbers (1-40)
    let drawn = [];
    while(drawn.length < 10) {
        let n = Math.floor(Math.random()*40)+1;
        if(!drawn.includes(n)) drawn.push(n);
    }
    
    // Calculate Matches
    let matches = 0;
    picks.forEach(p => { if(drawn.includes(p)) matches++; });
    
    // Payout Table
    const multipliers = {0:0, 1:0, 2:0, 3:1.2, 4:3, 5:5, 6:10, 7:25, 8:50, 9:100, 10:500};
    const win = bet * multipliers[matches];
    
    if(win > 0) await updateBalance(userId, win);
    
    res.json({ drawn, matches, win });
});

server.listen(PORT, () => console.log(`Engine Running on ${PORT}`));