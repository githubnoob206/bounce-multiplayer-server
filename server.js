const express = require('express');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { Server } = require('socket.io');

const app = express();
const server = createServer(app);

// Configure Socket.IO with CORS enabled for your website domain
const io = new Server(server, {
  cors: {
    origin: "*", // Allows connections from any website domain (like taysh.xyz)
    methods: ["GET", "POST"]
  }
});

// Serve the index.html file to the browser
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

// Store active lobbies
const lobbies = {};

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Send the current list of lobbies to the newly connected user
  socket.emit('updateLobbies', Object.keys(lobbies));

  socket.on('createLobby', (lobbyName) => {
    if (!lobbies[lobbyName]) {
      lobbies[lobbyName] = { host: socket.id, players: [socket.id] };
      socket.join(lobbyName);
      io.emit('updateLobbies', Object.keys(lobbies)); // Update everyone's lobby list
    }
  });

  socket.on('joinLobby', (lobbyName) => {
    if (lobbies[lobbyName] && lobbies[lobbyName].players.length < 2) {
      lobbies[lobbyName].players.push(socket.id);
      socket.join(lobbyName);
      // Notify the host that a second player has joined
      io.to(lobbies[lobbyName].host).emit('playerJoined');
    }
  });

  socket.on('startGame', (lobbyName) => {
    io.to(lobbyName).emit('gameStarted');
  });

  // Relay player inputs and game state to the other player in the room
  socket.on('syncState', (lobbyName, stateData) => {
    socket.to(lobbyName).emit('stateUpdated', stateData);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

server.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});
