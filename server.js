// BOUNCE! multiplayer relay server
// ---------------------------------------------------------------------
// This server does NOT run any game physics. It only does two things:
//   1. Track a public list of lobbies (create / join / leave / start / retry)
//   2. Relay input & state packets between the host and guest of a lobby
//
// Keeping it a pure relay means there's no extra simulation step adding
// latency, and no server tick rate to bottleneck on. The host's browser is
// the single source of truth for the actual game state.
//
// IMPORTANT: frequent traffic (movement input, position snapshots) is
// relayed with io.to(...).volatile.emit(...) instead of a normal emit.
// A normal ("reliable") emit will queue up behind a slow connection and
// get delivered late-and-in-order, which is what causes a game to look
// like it's running at 15-20fps even though physics ticks fine locally.
// A volatile emit is dropped instead of queued if the socket is
// congested, so the client always renders the freshest data it can get,
// never a backlog of stale frames.
// ---------------------------------------------------------------------

const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('BOUNCE! multiplayer server is running.\n');
});

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// lobbyId -> { id, name, hostId, hostName, guestId, guestName, status }
const lobbies = new Map();

function publicLobbyList() {
  return [...lobbies.values()].map(l => ({
    id: l.id,
    name: l.name,
    hostName: l.hostName,
    hasGuest: !!l.guestId,
    status: l.status
  }));
}

function broadcastLobbies() {
  io.emit('lobby-list', publicLobbyList());
}


// ---------------------------------------------------------------------
// PRO CODES
// ---------------------------------------------------------------------
// Valid codes come from the PRO_CODES environment variable on Render
// (comma-separated, e.g.  12345,67890,24680). 55555 is always accepted
// as a test code -- DELETE it from TEST_CODES below before selling.
// PRO_SECRET signs the receipt tokens; set it to any long random string
// in Render's environment settings so receipts survive restarts.
const TEST_CODES = ['55555'];
const PRO_CODES = new Set(
  (process.env.PRO_CODES || '').split(',').map(c => c.trim()).filter(Boolean).concat(TEST_CODES)
);
const PRO_SECRET = process.env.PRO_SECRET || 'change-me-set-PRO_SECRET-in-render';

function signToken(id) {
  const sig = crypto.createHmac('sha256', PRO_SECRET).update(id).digest('hex');
  return id + '.' + sig;
}
function verifyToken(token) {
  if (typeof token !== 'string') return false;
  const [id, sig] = token.split('.');
  if (!id || !sig) return false;
  const good = crypto.createHmac('sha256', PRO_SECRET).update(id).digest('hex');
  if (sig.length !== good.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}

// Rate limit: 8 wrong guesses per IP per 15 minutes.
const attempts = new Map(); // ip -> { count, resetAt }
const MAX_BAD = 8, WINDOW_MS = 15 * 60 * 1000;
function clientIp(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0].trim() : socket.handshake.address) || 'unknown';
}
function isLimited(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() > a.resetAt) { attempts.delete(ip); return false; }
  return a.count >= MAX_BAD;
}
function recordBad(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() > a.resetAt) attempts.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
  else a.count++;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, a] of attempts) if (now > a.resetAt) attempts.delete(ip);
}, 60 * 1000).unref();

io.on('connection', socket => {
  socket.data.lobbyId = null;
  socket.data.role = null; // 'host' | 'guest'

  socket.on('list-lobbies', () => {
    socket.emit('lobby-list', publicLobbyList());
  });

  socket.on('ping-check', clientTime => {
    socket.emit('pong-check', clientTime);
  });

  socket.on('create-lobby', (payload = {}) => {
    const id = Math.random().toString(36).slice(2, 8);
    const lobby = {
      id,
      name: String(payload.name || 'Bounce Match').slice(0, 40),
      hostId: socket.id,
      hostName: String(payload.hostName || 'Host').slice(0, 24),
      guestId: null,
      guestName: null,
      status: 'waiting'
    };
    lobbies.set(id, lobby);
    socket.data.lobbyId = id;
    socket.data.role = 'host';
    socket.join(id);
    socket.emit('lobby-created', { id: lobby.id, name: lobby.name });
    broadcastLobbies();
  });

  socket.on('join-lobby', (payload = {}) => {
    const lobby = lobbies.get(payload.lobbyId);
    if (!lobby) return socket.emit('join-failed', { reason: 'not-found' });
    if (lobby.guestId) return socket.emit('join-failed', { reason: 'full' });
    if (lobby.status !== 'waiting') return socket.emit('join-failed', { reason: 'in-progress' });

    lobby.guestId = socket.id;
    lobby.guestName = String(payload.guestName || 'Guest').slice(0, 24);
    socket.data.lobbyId = lobby.id;
    socket.data.role = 'guest';
    socket.join(lobby.id);

    socket.emit('join-success', { id: lobby.id, name: lobby.name, hostName: lobby.hostName });
    io.to(lobby.hostId).emit('guest-joined', { guestName: lobby.guestName });
    broadcastLobbies();
  });

  socket.on('leave-lobby', () => leaveLobby(socket));

  socket.on('start-game', settings => {
    const lobby = lobbies.get(socket.data.lobbyId);
    if (!lobby || lobby.hostId !== socket.id || !lobby.guestId) return;
    lobby.status = 'playing';
    io.to(lobby.guestId).emit('game-started', settings || {});
    broadcastLobbies();
  });

  socket.on('retry-game', settings => {
    const lobby = lobbies.get(socket.data.lobbyId);
    if (!lobby || lobby.hostId !== socket.id || !lobby.guestId) return;
    io.to(lobby.guestId).emit('game-retry', settings || {});
  });

  // High-frequency, latency-sensitive traffic — volatile on purpose (see note up top).
  socket.on('input', payload => {
    const lobby = lobbies.get(socket.data.lobbyId);
    if (!lobby || lobby.guestId !== socket.id) return;
    io.to(lobby.hostId).volatile.emit('peer-input', payload);
  });

  socket.on('state', payload => {
    const lobby = lobbies.get(socket.data.lobbyId);
    if (!lobby || lobby.hostId !== socket.id || !lobby.guestId) return;
    io.to(lobby.guestId).volatile.emit('peer-state', payload);
  });

  // Game-over is rare and important, so it goes over the normal (reliable)
  // channel even though position updates don't.
  socket.on('game-over', payload => {
    const lobby = lobbies.get(socket.data.lobbyId);
    if (!lobby || lobby.hostId !== socket.id || !lobby.guestId) return;
    io.to(lobby.guestId).emit('game-over', payload);
  });

  // ---- Pro code activation (client waits for an ack callback) ----
  socket.on('pro-activate', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const ip = clientIp(socket);
    if (isLimited(ip)) return ack({ ok: false, reason: 'rate-limit' });
    const code = String((payload && payload.code) || '').trim();
    if (/^\d{5}$/.test(code) && PRO_CODES.has(code)) {
      const id = crypto.randomBytes(12).toString('hex');
      return ack({ ok: true, token: signToken(id) });
    }
    recordBad(ip);
    ack({ ok: false, reason: 'invalid' });
  });

  // ---- Re-validates a saved receipt when the game reconnects ----
  socket.on('pro-check', (payload, ack) => {
    if (typeof ack !== 'function') return;
    ack({ ok: verifyToken(payload && payload.token) });
  });

  socket.on('disconnect', () => leaveLobby(socket));

  function leaveLobby(sock) {
    const lobby = lobbies.get(sock.data.lobbyId);
    if (!lobby) return;

    if (sock.data.role === 'host') {
      if (lobby.guestId) io.to(lobby.guestId).emit('host-left');
      lobbies.delete(lobby.id);
    } else if (sock.data.role === 'guest') {
      lobby.guestId = null;
      lobby.guestName = null;
      lobby.status = 'waiting';
      io.to(lobby.hostId).emit('guest-left');
    }

    sock.leave(lobby.id);
    sock.data.lobbyId = null;
    sock.data.role = null;
    broadcastLobbies();
  }
});

server.listen(PORT, () => console.log('BOUNCE! multiplayer server listening on port ' + PORT));
