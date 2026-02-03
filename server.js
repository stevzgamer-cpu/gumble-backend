const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { Hand } = require('pokersolver'); // Ensure you ran: npm install pokersolver

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 10000;

// DB Connection
const mongoURI = "mongodb+srv://stevzgamer-db-user:GumbleDB206@cluster0.uw2p1mi.mongodb.net/GumbleDB?retryWrites=true&w=majority";
mongoose.connect(mongoURI).then(() => console.log("🚀 Poker Engine Online")).catch(err => console.error(err));

// --- GAME LOGIC ---
const SUITS = ['d', 'c', 'h', 's'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
let rooms = {};

const createDeck = () => {
  let deck = [];
  for (let s of SUITS) {
    for (let v of VALUES) deck.push({ value: v, suit: s, code: `${v}${s}` });
  }
  return deck.sort(() => Math.random() - 0.5);
};

io.on('connection', (socket) => {
  
  socket.on('join_room', ({ roomName, username }) => {
    socket.join(roomName);
    
    if (!rooms[roomName]) {
      rooms[roomName] = {
        players: [],
        deck: [],
        communityCards: [],
        pot: 0,
        currentTurn: 0,
        phase: 'waiting', // waiting, preflop, flop, turn, river, showdown
        highestBet: 0
      };
    }
    
    const room = rooms[roomName];

    // Avoid duplicates
    if (!room.players.find(p => p.username === username)) {
      room.players.push({
        id: socket.id,
        username,
        chips: 1000,
        hand: [],
        currentBet: 0,
        folded: false
      });
    }

    // Auto-Start if 2 players present
    if (room.players.length >= 2 && room.phase === 'waiting') {
      startNewHand(roomName);
    } else {
      io.to(roomName).emit('update_room', room);
    }
  });

  socket.on('action', ({ roomName, type, amount }) => {
    const room = rooms[roomName];
    if (!room) return;

    const player = room.players[room.currentTurn];
    if (player.id !== socket.id) return; // Not your turn!

    if (type === 'fold') {
      player.folded = true;
    } else if (type === 'call') {
      const callAmt = room.highestBet - player.currentBet;
      player.chips -= callAmt;
      player.currentBet += callAmt;
      room.pot += callAmt;
    } else if (type === 'raise') {
      const raiseAmt = amount;
      player.chips -= raiseAmt;
      player.currentBet += raiseAmt;
      room.pot += raiseAmt;
      room.highestBet += raiseAmt;
    }

    nextTurn(roomName);
  });
});

function startNewHand(roomName) {
  const room = rooms[roomName];
  room.deck = createDeck();
  room.communityCards = [];
  room.pot = 0;
  room.highestBet = 0;
  room.phase = 'preflop';
  
  // Deal 2 cards to each player
  room.players.forEach(p => {
    p.hand = [room.deck.pop(), room.deck.pop()];
    p.currentBet = 0;
    p.folded = false;
  });

  room.currentTurn = 0;
  io.to(roomName).emit('update_room', room);
}

function nextTurn(roomName) {
  const room = rooms[roomName];
  
  // Move turn to next player
  let loopCount = 0;
  do {
    room.currentTurn = (room.currentTurn + 1) % room.players.length;
    loopCount++;
  } while (room.players[room.currentTurn].folded && loopCount < room.players.length);

  // Simple Phase Logic (In real poker, checks if betting matches. Here: 1 round per phase for simplicity)
  if (room.currentTurn === 0) {
    nextPhase(roomName);
  } else {
    io.to(roomName).emit('update_room', room);
  }
}

function nextPhase(roomName) {
  const room = rooms[roomName];
  
  if (room.phase === 'preflop') {
    room.phase = 'flop';
    room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
  } else if (room.phase === 'flop') {
    room.phase = 'turn';
    room.communityCards.push(room.deck.pop());
  } else if (room.phase === 'turn') {
    room.phase = 'river';
    room.communityCards.push(room.deck.pop());
  } else if (room.phase === 'river') {
    room.phase = 'showdown';
    determineWinner(roomName);
    return;
  }
  
  io.to(roomName).emit('update_room', room);
}

function determineWinner(roomName) {
  const room = rooms[roomName];
  
  // Filter active players
  const active = room.players.filter(p => !p.folded);
  
  if(active.length === 1) {
     // Winner by fold
     active[0].chips += room.pot;
     io.to(roomName).emit('hand_result', { winner: active[0].username, winnings: room.pot, handName: 'Opponents Folded' });
  } else {
     // Solve Hands
     const hands = active.map(p => {
       const h = Hand.solve([...p.hand.map(c=>c.code), ...room.communityCards.map(c=>c.code)]);
       h.owner = p.username;
       return h;
     });
     const winnerHand = Hand.winners(hands)[0];
     const winnerPlayer = room.players.find(p => p.username === winnerHand.owner);
     
     winnerPlayer.chips += room.pot;
     io.to(roomName).emit('hand_result', { winner: winnerPlayer.username, winnings: room.pot, handName: winnerHand.name });
  }

  // Restart in 5 seconds
  setTimeout(() => startNewHand(roomName), 5000);
}

// Inside your server.js game logic
if (gameState.phase === 'showdown') {
    const winners = determineWinner(gameState.communityCards, gameState.players);
    
    // Update the winner's balance in MongoDB
    const potAmount = gameState.pot;
    const houseRake = potAmount * 0.015; // Your 1.5% rake
    const finalPrize = potAmount - houseRake;

    io.emit('handOver', {
        winners: winners,
        prize: finalPrize,
        description: winners[0].descr
    });

    // Reset for next round after 5 seconds
    setTimeout(startNewHand, 5000);
}

io.on('connection', (socket) => {
  socket.on('joinTable', (userData) => {
    const player = { id: socket.id, name: userData.name, chips: 1000, cards: [] };
    gameState.players.push(player);
    
    // Auto-start game if 2 players are present
    if (gameState.players.length === 2) {
      startNewHand();
    }
    io.emit('gameStateUpdate', gameState);
  });

  socket.on('playerAction', (action) => {
    // Handle 'check', 'call', 'fold', or 'bet'
    processAction(socket.id, action);
    nextTurn();
    io.emit('gameStateUpdate', gameState);
  });
});

function startNewHand() {
  const deck = createDeck(); // Function to shuffle 52 cards
  gameState.players.forEach(p => p.cards = [deck.pop(), deck.pop()]);
  gameState.communityCards = [];
  gameState.phase = 'pre-flop';
}

const User = require('./models/User'); // Path to your User model

async function handleHandEnd(winners, potAmount) {
    const rakePercent = 0.015; // Your 1.5% rake
    const totalRake = potAmount * rakePercent;
    const prizePerWinner = (potAmount - totalRake) / winners.length;

    for (const winner of winners) {
        try {
            // Find the winner in MongoDB and add their chips
            await User.findByIdAndUpdate(winner.id, {
                $inc: { balance: prizePerWinner }
            });
            console.log(`Added ${prizePerWinner} chips to player ${winner.id}`);
        } catch (err) {
            console.error("Database update failed:", err);
        }
    }
    
    // Optional: Send the rake to a 'House' account to track your profit
    console.log(`House earned ${totalRake} in commission.`);
}

// Inside your io.on('connection') block
socket.on('joinTable', (userData) => {
    // ... your existing join logic ...
    
    if (gameState.players.length >= 2 && gameState.phase === 'waiting') {
        console.log("Starting a new perfect hand!");
        startNewHand(); // This deals the cards
        io.emit('gameStateUpdate', gameState);
    }
});

// Inside your joinTable logic in server.js
if (gameState.players.length >= 2) {
    gameState.phase = 'playing'; // Change from 'waiting'
    startNewHand(); // This deals the cards and updates the pot
    io.emit('gameStateUpdate', gameState);
}

server.listen(PORT, () => console.log(`🃏 Poker Server on ${PORT}`));

// Game State
let gameState = {
  players: [],
  communityCards: [],
  pot: 0,
  currentTurn: 0,
  phase: 'pre-flop' // pre-flop, flop, turn, river
};

