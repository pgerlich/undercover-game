const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  allowUpgrades: true
});

app.use(express.static(path.join(__dirname, 'public')));

// Word categories for the game
const CATEGORIES = {
  'Animals': ['Dog', 'Cat', 'Elephant', 'Lion', 'Penguin', 'Dolphin', 'Eagle', 'Tiger', 'Bear', 'Wolf', 'Snake', 'Rabbit'],
  'Foods': ['Pizza', 'Sushi', 'Burger', 'Pasta', 'Tacos', 'Ice Cream', 'Chocolate', 'Steak', 'Salad', 'Soup'],
  'Movies': ['Titanic', 'Avatar', 'Inception', 'Jaws', 'Matrix', 'Frozen', 'Gladiator', 'Jurassic Park', 'Star Wars', 'Batman'],
  'Sports': ['Soccer', 'Basketball', 'Tennis', 'Golf', 'Swimming', 'Boxing', 'Baseball', 'Hockey', 'Volleyball', 'Surfing'],
  'Countries': ['Japan', 'Brazil', 'France', 'Australia', 'Canada', 'Egypt', 'India', 'Italy', 'Mexico', 'Norway'],
  'Professions': ['Doctor', 'Chef', 'Pilot', 'Teacher', 'Lawyer', 'Artist', 'Engineer', 'Firefighter', 'Detective', 'Astronaut'],
  'Emotions': ['Happy', 'Sad', 'Angry', 'Excited', 'Nervous', 'Bored', 'Surprised', 'Confused', 'Proud', 'Jealous'],
  'Holidays': ['Christmas', 'Halloween', 'Easter', 'Thanksgiving', 'New Year', 'Valentine', 'Independence Day', 'St Patrick', 'Hanukkah', 'Diwali']
};

// Game state
const lobbies = new Map();

function generateLobbyCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function createLobby(hostSocket, hostName) {
  let code = generateLobbyCode();
  while (lobbies.has(code)) {
    code = generateLobbyCode();
  }

  const lobby = {
    code,
    host: hostSocket.id,
    players: [{
      id: hostSocket.id,
      name: hostName,
      isHost: true,
      clue: null,
      vote: null,
      hasVoted: false
    }],
    state: 'waiting', // waiting, clue-phase, voting, results
    category: null,
    secretWord: null,
    chameleonId: null,
    currentPlayerIndex: 0,
    roundEndTime: null,
    clueTimer: null,
    voteTimer: null
  };

  lobbies.set(code, lobby);
  return lobby;
}

function selectCategoryAndWord() {
  const categories = Object.keys(CATEGORIES);
  const category = categories[Math.floor(Math.random() * categories.length)];
  const words = CATEGORIES[category];
  const word = words[Math.floor(Math.random() * words.length)];
  return { category, word, allWords: words };
}

function startGame(lobby) {
  // Reset player states
  lobby.players.forEach(p => {
    p.clue = null;
    p.vote = null;
    p.hasVoted = false;
  });

  // Select category and word
  const { category, word, allWords } = selectCategoryAndWord();
  lobby.category = category;
  lobby.secretWord = word;
  lobby.allWords = allWords;

  // Select chameleon randomly
  const chameleonIndex = Math.floor(Math.random() * lobby.players.length);
  lobby.chameleonId = lobby.players[chameleonIndex].id;

  // Shuffle player order for clue giving
  lobby.playerOrder = [...lobby.players].sort(() => Math.random() - 0.5);
  lobby.currentPlayerIndex = 0;

  lobby.state = 'clue-phase';
  lobby.roundEndTime = Date.now() + 60000; // 1 minute per player

  return { category, word, chameleonId: lobby.chameleonId, allWords };
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('create-lobby', (playerName) => {
    const lobby = createLobby(socket, playerName);
    socket.join(lobby.code);
    socket.emit('lobby-created', { code: lobby.code, players: lobby.players });
    console.log(`Lobby ${lobby.code} created by ${playerName}`);
  });

// Handle reconnection
  socket.on('rejoin-lobby', ({ code, playerName }) => {
    const lobby = lobbies.get(code?.toUpperCase());
    if (!lobby) {
      socket.emit('rejoin-failed');
      return;
    }

    // Find existing player by name
    const existingPlayer = lobby.players.find(p => p.name === playerName);
    if (!existingPlayer) {
      // Player not in this lobby - try to join as new player if in waiting state
      if (lobby.state === 'waiting' && lobby.players.length < 10) {
        lobby.players.push({
          id: socket.id,
          name: playerName,
          isHost: false,
          clue: null,
          vote: null,
          hasVoted: false
        });

        socket.join(lobby.code);
        socket.emit('rejoin-success', {
          code: lobby.code,
          players: lobby.players,
          state: lobby.state,
          isHost: false
        });
        io.to(lobby.code).emit('player-joined', { players: lobby.players });
        console.log(`${playerName} joined lobby ${code} via rejoin`);
      } else {
        socket.emit('rejoin-failed');
      }
      return;
    }

    if (existingPlayer) {
      // Update socket ID
      const oldId = existingPlayer.id;
      existingPlayer.id = socket.id;

      // Clear disconnected state (player is back!)
      delete existingPlayer.disconnectedAt;
      delete existingPlayer.disconnectedSocketId;

      // Update host reference if needed
      if (lobby.host === oldId) {
        lobby.host = socket.id;
      }

      // Update chameleon ID if needed
      if (lobby.chameleonId === oldId) {
        lobby.chameleonId = socket.id;
      }

      // Update player order if in game
      if (lobby.playerOrder) {
        const orderPlayer = lobby.playerOrder.find(p => p.id === oldId);
        if (orderPlayer) orderPlayer.id = socket.id;
      }

      socket.join(lobby.code);
      socket.emit('rejoin-success', {
        code: lobby.code,
        players: lobby.players,
        state: lobby.state,
        isHost: lobby.host === socket.id
      });
      console.log(`${playerName} rejoined lobby ${code}`);
    }
  });

  socket.on('join-lobby', ({ code, playerName }) => {
    const lobby = lobbies.get(code.toUpperCase());

    if (!lobby) {
      socket.emit('error', 'Lobby not found');
      return;
    }

    if (lobby.state !== 'waiting') {
      socket.emit('error', 'Game already in progress');
      return;
    }

    if (lobby.players.length >= 10) {
      socket.emit('error', 'Lobby is full');
      return;
    }

    if (lobby.players.some(p => p.name.toLowerCase() === playerName.toLowerCase())) {
      socket.emit('error', 'Name already taken');
      return;
    }

    lobby.players.push({
      id: socket.id,
      name: playerName,
      isHost: false,
      clue: null,
      vote: null,
      hasVoted: false
    });

    socket.join(lobby.code);
    socket.emit('lobby-joined', { code: lobby.code, players: lobby.players });
    io.to(lobby.code).emit('player-joined', { players: lobby.players });
    console.log(`${playerName} joined lobby ${lobby.code}`);
  });

  socket.on('start-game', (code) => {
    const lobby = lobbies.get(code);

    if (!lobby || lobby.host !== socket.id) {
      socket.emit('error', 'Only the host can start the game');
      return;
    }

    if (lobby.players.length < 3) {
      socket.emit('error', 'Need at least 3 players');
      return;
    }

    const { category, word, chameleonId, allWords } = startGame(lobby);

    // Send role info to each player
    lobby.players.forEach(player => {
      const isChameleon = player.id === chameleonId;
      io.to(player.id).emit('game-started', {
        category,
        allWords,
        secretWord: isChameleon ? null : word,
        isChameleon,
        playerOrder: lobby.playerOrder.map(p => ({ id: p.id, name: p.name })),
        currentPlayer: lobby.playerOrder[0],
        roundEndTime: lobby.roundEndTime
      });
    });

    console.log(`Game started in lobby ${code}. Undercover Agent: ${lobby.players.find(p => p.id === chameleonId)?.name}`);
  });

  socket.on('submit-clue', ({ code, clue }) => {
    const lobby = lobbies.get(code);
    if (!lobby || lobby.state !== 'clue-phase') return;

    const player = lobby.players.find(p => p.id === socket.id);
    const currentPlayer = lobby.playerOrder[lobby.currentPlayerIndex];

    if (!player || currentPlayer.id !== socket.id) {
      socket.emit('error', 'Not your turn');
      return;
    }

    player.clue = clue.trim().split(' ')[0]; // Only first word

    // Notify all players of the clue
    io.to(lobby.code).emit('clue-submitted', {
      playerId: socket.id,
      playerName: player.name,
      clue: player.clue,
      clues: lobby.players.map(p => ({ id: p.id, name: p.name, clue: p.clue }))
    });

    // Move to next player
    lobby.currentPlayerIndex++;

    if (lobby.currentPlayerIndex >= lobby.playerOrder.length) {
      // All clues submitted, move to voting
      lobby.state = 'voting';
      lobby.roundEndTime = Date.now() + 60000; // 1 minute for voting

      io.to(lobby.code).emit('voting-phase', {
        clues: lobby.players.map(p => ({ id: p.id, name: p.name, clue: p.clue })),
        roundEndTime: lobby.roundEndTime
      });
    } else {
      io.to(lobby.code).emit('next-player', {
        currentPlayer: lobby.playerOrder[lobby.currentPlayerIndex],
        roundEndTime: Date.now() + 60000
      });
    }
  });

  socket.on('submit-vote', ({ code, votedPlayerId }) => {
    const lobby = lobbies.get(code);
    if (!lobby || lobby.state !== 'voting') return;

    const player = lobby.players.find(p => p.id === socket.id);
    if (!player || player.hasVoted) return;

    player.vote = votedPlayerId;
    player.hasVoted = true;

    io.to(lobby.code).emit('vote-cast', {
      voterId: socket.id,
      voterName: player.name,
      votesCount: lobby.players.filter(p => p.hasVoted).length,
      totalPlayers: lobby.players.length
    });

    // Check if all votes are in
    if (lobby.players.every(p => p.hasVoted)) {
      showResults(lobby);
    }
  });

  socket.on('chameleon-guess', ({ code, guess }) => {
    const lobby = lobbies.get(code);
    if (!lobby || lobby.state !== 'chameleon-guessing') return;
    if (socket.id !== lobby.chameleonId) return;

    const isCorrect = guess.trim().toLowerCase() === lobby.secretWord.toLowerCase();
    lobby.chameleonGuess = guess.trim();
    lobby.chameleonGuessedCorrectly = isCorrect;

    showFinalResults(lobby);
  });

  socket.on('play-again', (code) => {
    const lobby = lobbies.get(code);
    if (!lobby || lobby.host !== socket.id) return;

    lobby.state = 'waiting';
    io.to(lobby.code).emit('reset-lobby', { players: lobby.players });
  });

  socket.on('leave-lobby', (code) => {
    const lobby = lobbies.get(code);
    if (!lobby) return;

    const playerIndex = lobby.players.findIndex(p => p.id === socket.id);
    if (playerIndex === -1) return;

    const player = lobby.players[playerIndex];
    lobby.players.splice(playerIndex, 1);
    socket.leave(lobby.code);

    if (lobby.players.length === 0) {
      lobbies.delete(code);
      console.log(`Lobby ${code} deleted - empty`);
    } else {
      // If host left, assign new host
      if (player.isHost && lobby.players.length > 0) {
        lobby.players[0].isHost = true;
        lobby.host = lobby.players[0].id;
      }

      io.to(code).emit('player-left', {
        players: lobby.players,
        leftPlayer: player.name
      });
    }
    console.log(`${player.name} left lobby ${code}`);
  });

  socket.on('disconnect', () => {
    const socketId = socket.id;

    // Find which lobby this player was in
    for (const [code, lobby] of lobbies) {
      const playerIndex = lobby.players.findIndex(p => p.id === socketId);

      if (playerIndex !== -1) {
        const player = lobby.players[playerIndex];
        const playerName = player.name;

        // Mark player as disconnected but don't remove yet (grace period for refresh)
        player.disconnectedAt = Date.now();
        player.disconnectedSocketId = socketId;

        console.log(`Player ${playerName} disconnected from lobby ${code}, waiting for reconnect...`);

        // Wait 5 seconds before actually removing (allows for refresh/reconnect)
        setTimeout(() => {
          // Check if player is still in lobby and still disconnected (same socket ID)
          const currentPlayer = lobby.players.find(p => p.name === playerName);
          if (currentPlayer && currentPlayer.disconnectedSocketId === socketId) {
            // Player didn't reconnect, remove them
            const idx = lobby.players.findIndex(p => p.name === playerName);
            if (idx !== -1) {
              lobby.players.splice(idx, 1);

              if (lobby.players.length === 0) {
                lobbies.delete(code);
                console.log(`Lobby ${code} deleted - empty`);
              } else {
                // If host left, assign new host
                if (currentPlayer.isHost && lobby.players.length > 0) {
                  lobby.players[0].isHost = true;
                  lobby.host = lobby.players[0].id;
                }

                io.to(code).emit('player-left', {
                  players: lobby.players,
                  leftPlayer: playerName
                });

                // If in game and this affected the game, end it
                if (lobby.state !== 'waiting') {
                  lobby.state = 'waiting';
                  io.to(code).emit('game-interrupted', {
                    reason: `${playerName} disconnected`,
                    players: lobby.players
                  });
                }
              }
              console.log(`Player ${playerName} removed from lobby ${code} after timeout`);
            }
          }
        }, 5000); // 5 second grace period

        break;
      }
    }
    console.log('Player disconnected:', socketId);
  });
});

function showResults(lobby) {
  // Count votes
  const voteCount = {};
  lobby.players.forEach(p => {
    if (p.vote) {
      voteCount[p.vote] = (voteCount[p.vote] || 0) + 1;
    }
  });

  // Find most voted player
  let maxVotes = 0;
  let mostVoted = null;
  for (const [playerId, count] of Object.entries(voteCount)) {
    if (count > maxVotes) {
      maxVotes = count;
      mostVoted = playerId;
    }
  }

  const chameleon = lobby.players.find(p => p.id === lobby.chameleonId);
  const caughtChameleon = mostVoted === lobby.chameleonId;

  lobby.mostVoted = mostVoted;
  lobby.voteCount = voteCount;
  lobby.caughtChameleon = caughtChameleon;

  // If chameleon was caught, give them a chance to guess the word
  if (caughtChameleon) {
    lobby.state = 'chameleon-guessing';

    io.to(lobby.code).emit('chameleon-guess-phase', {
      chameleonId: lobby.chameleonId,
      chameleonName: chameleon?.name,
      mostVotedId: mostVoted,
      mostVotedName: chameleon?.name,
      votes: lobby.players.map(p => ({
        id: p.id,
        name: p.name,
        votedFor: lobby.players.find(v => v.id === p.vote)?.name
      })),
      voteCount,
      allWords: lobby.allWords,
      category: lobby.category
    });
  } else {
    // Chameleon escaped - show results directly
    lobby.chameleonGuessedCorrectly = false;
    showFinalResults(lobby);
  }
}

function showFinalResults(lobby) {
  const chameleon = lobby.players.find(p => p.id === lobby.chameleonId);

  lobby.state = 'results';

  io.to(lobby.code).emit('game-results', {
    chameleonId: lobby.chameleonId,
    chameleonName: chameleon?.name,
    secretWord: lobby.secretWord,
    caughtChameleon: lobby.caughtChameleon,
    chameleonGuess: lobby.chameleonGuess,
    chameleonGuessedCorrectly: lobby.chameleonGuessedCorrectly,
    mostVotedId: lobby.mostVoted,
    mostVotedName: lobby.players.find(p => p.id === lobby.mostVoted)?.name,
    votes: lobby.players.map(p => ({
      id: p.id,
      name: p.name,
      votedFor: lobby.players.find(v => v.id === p.vote)?.name
    })),
    voteCount: lobby.voteCount
  });
}

const PORT = process.env.PORT || 3456;
httpServer.listen(PORT, () => {
  console.log(`🕵️ Undercover Game running on http://localhost:${PORT}`);
});
