require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const { Server } = require('socket.io');
const { Hand } = require('pokersolver'); // Requires: npm install pokersolver
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
  players: [], 
  communityCards: [],
  pot: 0,
  deck: [],
  phase: 'waiting', 
  turnIndex: 0,
  dealerIndex: 0,
  highestBet: 0,
  timer: 30
};

let turnTimeout;

const createDeck = () => {
  const suits = ['h', 'd', 'c', 's'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  let deck = [];
  for (let s of suits) for (let r of ranks) deck.push(r + s);
  return deck.sort(() => Math.random() - 0.5);
};

const startTurnTimer = () => {
    clearInterval(turnTimeout);
    gameState.timer = 30;
    turnTimeout = setInterval(() => {
        gameState.timer--;
        if (gameState.timer <= 0) {
            clearInterval(turnTimeout);
            // Auto-Fold on timeout
            const p = gameState.players[gameState.turnIndex];
            if(p) handleAction(p.id, 'fold', 0);
        }
        io.emit('gameState', gameState);
    }, 1000);
};

const checkRoundComplete = () => {
    const activePlayers = gameState.players.filter(p => !p.folded);
    
    // 1. If only one player left, they win immediately
    if (activePlayers.length === 1) { endHand(activePlayers[0]); return; }

    // 2. Check if everyone has acted and matched the bet
    const allMatched = activePlayers.every(p => p.currentBet === gameState.highestBet && p.actedThisRound);
    
    if (allMatched) {
        nextStage();
    } else {
        nextTurn();
    }
};

const nextStage = () => {
    clearInterval(turnTimeout);
    
    // Move bets to pot and reset player round stats
    gameState.players.forEach(p => {
        p.currentBet = 0;
        p.actedThisRound = false; 
    });
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
        determineWinner(); return; 
    }
    
    // Reset turn to first active player left of dealer
    gameState.turnIndex = gameState.dealerIndex;
    rotateTurnToActive();
    
    io.emit('gameState', gameState);
    startTurnTimer();
};

const rotateTurnToActive = () => {
    do {
        gameState.turnIndex = (gameState.turnIndex + 1) % gameState.players.length;
    } while (gameState.players[gameState.turnIndex].folded);
};

const nextTurn = () => {
    rotateTurnToActive();
    io.emit('gameState', gameState);
    startTurnTimer();
};

const handleAction = (socketId, type, amount) => {
    const player = gameState.players.find(p => p.id === socketId);
    if (!player || gameState.players[gameState.turnIndex].id !== socketId) return;

    player.actedThisRound = true;

    if (type === 'fold') {
        player.folded = true;
    } else if (type === 'call') {
        const toCall = gameState.highestBet - player.currentBet;
        if (player.balance >= toCall) {
            player.balance -= toCall;
            player.currentBet += toCall;
            gameState.pot += toCall;
        } else {
            // All-in logic simplified
            player.currentBet += player.balance;
            gameState.pot += player.balance;
            player.balance = 0;
        }
    } else if (type === 'raise') {
        const totalBet = Number(amount);
        const added = totalBet - player.currentBet;
        if (player.balance >= added && totalBet > gameState.highestBet) {
            player.balance -= added;
            player.currentBet = totalBet;
            gameState.pot += added;
            gameState.highestBet = totalBet;
            // Re-open action for others
            gameState.players.forEach(p => { if(p.id !== player.id && !p.folded) p.actedThisRound = false; });
        }
    }

    checkRoundComplete();
};

const determineWinner = async () => {
    gameState.phase = 'showdown';
    io.emit('gameState', gameState);

    const activePlayers = gameState.players.filter(p => !p.folded);
    
    // Solver needs format like 'Ad', 'Ks' (T -> 10 converted automatically by some, but let's be safe)
    const solvedHands = activePlayers.map(p => {
        const cards = [...p.hand, ...gameState.communityCards].map(c => c.replace('0', 'T'));
        const solved = Hand.solve(cards);
        solved.owner = p.dbId;
        return solved;
    });

    const winners = Hand.winners(solvedHands);
    const winnerId = winners[0].owner;
    const winnerPlayer = gameState.players.find(p => p.dbId === winnerId);

    if (winnerPlayer) {
        winnerPlayer.balance += gameState.pot;
        await User.findByIdAndUpdate(winnerPlayer.dbId, { $inc: { balance: gameState.pot } });
    }

    setTimeout(startNewHand, 8000);
};

const endHand = async (winner) => {
    clearInterval(turnTimeout);
    gameState.phase = 'showdown';
    winner.balance += gameState.pot;
    await User.findByIdAndUpdate(winner.dbId, { $inc: { balance: gameState.pot } });
    io.emit('gameState', gameState);
    setTimeout(startNewHand, 5000);
};

const startNewHand = () => {
    if (gameState.players.length < 2) { 
        gameState.phase = 'waiting'; 
        gameState.communityCards = [];
        gameState.pot = 0;
        io.emit('gameState', gameState); 
        return; 
    }

    gameState.deck = createDeck();
    gameState.communityCards = [];
    gameState.pot = 0;
    gameState.phase = 'preflop';
    
    // Rotate Dealer
    gameState.dealerIndex =