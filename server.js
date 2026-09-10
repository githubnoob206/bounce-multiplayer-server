const express = require("express");
const { createServer } = require("node:http");
const { join } = require("node:path");
const { Server } = require("socket.io");

const app = express();
const server = createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.get("/", (req, res) => {
  res.sendFile(join(__dirname, "index.html"));
});

const lobbies = new Map();

// Multiplayer uses one shared logical arena. The client scales this to the
// size of its browser, so the server boundary and the visible boundary match.
const ARENA = {
  width: 1000,
  height: 650,
  playerRadius: 19,
  bulletRadius: 13,
  padding: 0
};

const MAX_PLAYERS = 2;
const TICK = 1000 / 60;

function makeId() {
  return Math.random().toString(36).slice(2, 9);
}

function publicLobbies() {
  return [...lobbies.values()].map(lobby => ({
    id: lobby.id,
    name: lobby.name,
    players: lobby.players.length,
    maxPlayers: MAX_PLAYERS,
    status: lobby.status
  }));
}

function broadcastLobbies() {
  io.emit("updateLobbies", publicLobbies());
}

function sendLobby(lobby) {
  io.to(lobby.id).emit("lobbyState", {
    id: lobby.id,
    name: lobby.name,
    host: lobby.host,
    status: lobby.status,
    players: lobby.players.map(id => ({
      id,
      name: lobby.playerNames[id] || "Player"
    }))
  });
}

function makePlayer(index) {
  return {
    x: index === 0 ? 250 : 750,
    y: ARENA.height / 2,
    r: ARENA.playerRadius,
    vx: 0,
    vy: 0,
    speed: 255,
    color: index === 0 ? "#ef5549" : "#3b78d8",
    cool: 0,
    aim: index === 0 ? 0 : Math.PI,
    shooting: false,
    keys: {
      w: false,
      a: false,
      s: false,
      d: false
    }
  };
}

function makeGame() {
  return {
    status: "waiting",
    players: {},
    bullets: [],
    winner: null
  };
}

function resetGame(lobby) {
  lobby.status = "waiting";
  lobby.game = makeGame();

  lobby.players.forEach((id, index) => {
    lobby.game.players[id] = makePlayer(index);
  });

  sendLobby(lobby);
}

function startGame(lobby) {
  if (lobby.players.length !== 2) return;

  lobby.status = "playing";
  lobby.game = makeGame();
  lobby.game.status = "playing";

  lobby.players.forEach((id, index) => {
    lobby.game.players[id] = makePlayer(index);
  });

  io.to(lobby.id).emit("gameStarted", {
    players: lobby.game.players
  });

  sendGameState(lobby);
}

function fire(lobby, playerId) {
  const game = lobby.game;
  const p = game.players[playerId];

  if (!p || game.status !== "playing") return;
  if (p.cool > 0) return;

  p.cool = 2;

  const speed = 285;

  game.bullets.push({
    x: p.x + Math.cos(p.aim) * 23,
    y: p.y + Math.sin(p.aim) * 23,
    vx: Math.cos(p.aim) * speed,
    vy: Math.sin(p.aim) * speed,
    owner: playerId,
    age: 0,
    curve: (Math.random() - 0.5) * 8,
    rot: p.aim
  });
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function segmentCircleHit(x1, y1, x2, y2, cx, cy, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const fx = x1 - cx;
  const fy = y1 - cy;
  const rr = r * r;

  if (fx * fx + fy * fy <= rr) return true;

  const len2 = dx * dx + dy * dy;

  if (len2 === 0) return false;

  const t = clamp(
    -(fx * dx + fy * dy) / len2,
    0,
    1
  );

  const px = x1 + dx * t;
  const py = y1 + dy * t;

  return (
    (px - cx) * (px - cx) +
    (py - cy) * (py - cy)
  ) <= rr;
}

function updateGame(lobby, dt) {
  const game = lobby.game;

  if (!game || game.status !== "playing") return;

  const left =
    ARENA.padding +
    ARENA.playerRadius;

  const right =
    ARENA.width -
    ARENA.padding -
    ARENA.playerRadius;

  const top =
    ARENA.padding +
    ARENA.playerRadius;

  const bottom =
    ARENA.height -
    ARENA.padding -
    ARENA.playerRadius;

  // -----------------------------
  // PLAYER MOVEMENT
  // -----------------------------

  for (const id of lobby.players) {
    const p = game.players[id];

    if (!p) continue;

    let x = 0;
    let y = 0;

    if (p.keys.d) x++;
    if (p.keys.a) x--;
    if (p.keys.s) y++;
    if (p.keys.w) y--;

    const len = Math.hypot(x, y) || 1;

    p.vx =
      x / len *
      p.speed;

    p.vy =
      y / len *
      p.speed;

    p.x = clamp(
      p.x + p.vx * dt,
      left,
      right
    );

    p.y = clamp(
      p.y + p.vy * dt,
      top,
      bottom
    );

    p.cool = Math.max(
      0,
      p.cool - dt
    );

    if (p.shooting) {
      fire(lobby, id);
    }
  }

  // -----------------------------
  // BULLET BOUNDS
  // -----------------------------

  const L =
    ARENA.padding +
    ARENA.bulletRadius;

  const R =
    ARENA.width -
    ARENA.padding -
    ARENA.bulletRadius;

  const T =
    ARENA.padding +
    ARENA.bulletRadius;

  const B =
    ARENA.height -
    ARENA.padding -
    ARENA.bulletRadius;

  // -----------------------------
  // BULLETS
  // -----------------------------

  for (
    let i = game.bullets.length - 1;
    i >= 0;
    i--
  ) {
    const b = game.bullets[i];

    b.age += dt;

    const speed =
      Math.hypot(
        b.vx,
        b.vy
      ) || 1;

    const nx =
      -b.vy /
      speed;

    const ny =
      b.vx /
      speed;

    b.vx +=
      nx *
      b.curve *
      dt;

    b.vy +=
      ny *
      b.curve *
      dt;

    const oldX = b.x;
    const oldY = b.y;

    b.x +=
      b.vx *
      dt;

    b.y +=
      b.vy *
      dt;

    b.rot =
      Math.atan2(
        b.vy,
        b.vx
      );

    // Bounce off left/right walls
    if (b.x < L) {
      b.x =
        L +
        (L - b.x);

      b.vx =
        Math.abs(b.vx);

      b.curve *= -1;
    }

    if (b.x > R) {
      b.x =
        R -
        (b.x - R);

      b.vx =
        -Math.abs(b.vx);

      b.curve *= -1;
    }

    // Bounce off top/bottom walls
    if (b.y < T) {
      b.y =
        T +
        (T - b.y);

      b.vy =
        Math.abs(b.vy);

      b.curve *= -1;
    }

    if (b.y > B) {
      b.y =
        B -
        (b.y - B);

      b.vy =
        -Math.abs(b.vy);

      b.curve *= -1;
    }

    let remove = false;

    // -----------------------------
    // BULLET COLLISIONS
    // -----------------------------

    for (const id of lobby.players) {
      const target =
        game.players[id];

      if (!target) continue;

      // Prevent a newly fired bullet
      // from immediately hitting its owner.
      if (
        id === b.owner &&
        b.age < 1
      ) {
        continue;
      }

      if (
        segmentCircleHit(
          oldX,
          oldY,
          b.x,
          b.y,
          target.x,
          target.y,
          target.r + 7
        )
      ) {
        game.status = "finished";

        game.winner =
          id === b.owner
            ? lobby.players.find(
                x => x !== id
              )
            : b.owner;

        io.to(lobby.id).emit(
          "gameOver",
          {
            winner:
              game.winner
          }
        );

        remove = true;

        break;
      }
    }

    if (remove) {
      game.bullets.splice(
        i,
        1
      );
    }
  }

  sendGameState(lobby);
}

function sendGameState(lobby) {
  const game = lobby.game;

  if (!game) return;

  io.to(lobby.id).emit(
    "stateUpdated",
    {
      status:
        game.status,

      winner:
        game.winner,

      players:
        game.players,

      bullets:
        game.bullets,

      serverTime:
        Date.now()
    }
  );
}

// ============================================================
// SOCKET.IO
// ============================================================

io.on("connection", socket => {
  console.log(
    "Connected:",
    socket.id
  );

  socket.emit(
    "updateLobbies",
    publicLobbies()
  );

  // ==========================================================
  // CREATE LOBBY
  // ==========================================================

  socket.on(
    "createLobby",
    rawName => {
      let name =
        String(
          rawName || ""
        ).trim();

      if (!name) {
        socket.emit(
          "errorMessage",
          "Please enter a server name."
        );

        return;
      }

      if (name.length > 32) {
        name =
          name.slice(
            0,
            32
          );
      }

      if (socket.data.lobbyId) {
        socket.emit(
          "errorMessage",
          "You are already in a server."
        );

        return;
      }

      const id =
        makeId();

      const lobby = {
        id,
        name,
        host:
          socket.id,

        players: [
          socket.id
        ],

        playerNames: {
          [socket.id]:
            "Player 1"
        },

        status:
          "waiting",

        game:
          makeGame()
      };

      lobby.game.players[
        socket.id
      ] =
        makePlayer(0);

      lobbies.set(
        id,
        lobby
      );

      socket.join(id);

      socket.data.lobbyId =
        id;

      socket.emit(
        "lobbyCreated",
        {
          id,
          name
        }
      );

      sendLobby(lobby);

      broadcastLobbies();

      console.log(
        `Lobby created: ${name} (${id})`
      );
    }
  );

  // ==========================================================
  // JOIN LOBBY
  // ==========================================================

  socket.on(
    "joinLobby",
    lobbyId => {
      const lobby =
        lobbies.get(
          lobbyId
        );

      if (!lobby) {
        socket.emit(
          "errorMessage",
          "That server no longer exists."
        );

        return;
      }

      if (
        lobby.players.length >=
        MAX_PLAYERS
      ) {
        socket.emit(
          "errorMessage",
          "That server is full."
        );

        return;
      }

      if (
        lobby.status ===
        "playing"
      ) {
        socket.emit(
          "errorMessage",
          "That game has already started."
        );

        return;
      }

      if (
        socket.data.lobbyId
      ) {
        socket.emit(
          "errorMessage",
          "You are already in a server."
        );

        return;
      }

      lobby.players.push(
        socket.id
      );

      lobby.playerNames[
        socket.id
      ] =
        "Player 2";

      lobby.game.players[
        socket.id
      ] =
        makePlayer(1);

      socket.join(
        lobby.id
      );

      socket.data.lobbyId =
        lobby.id;

      io.to(
        lobby.host
      ).emit(
        "playerJoined"
      );

      sendLobby(lobby);

      broadcastLobbies();
    }
  );

  // ==========================================================
  // START GAME
  // ==========================================================

  socket.on(
    "startGame",
    () => {
      const lobby =
        lobbies.get(
          socket.data.lobbyId
        );

      if (!lobby) return;

      if (
        socket.id !==
        lobby.host
      ) {
        socket.emit(
          "errorMessage",
          "Only the host can start the game."
        );

        return;
      }

      if (
        lobby.players.length !==
        2
      ) {
        socket.emit(
          "errorMessage",
          "You need 2 players to start."
        );

        return;
      }

      startGame(
        lobby
      );

      broadcastLobbies();
    }
  );

  // ==========================================================
  // RETRY / REMATCH
  // ==========================================================

  socket.on(
    "retryGame",
    () => {
      const lobby =
        lobbies.get(
          socket.data.lobbyId
        );

      if (!lobby) return;

      if (
        socket.id !==
        lobby.host
      ) {
        socket.emit(
          "errorMessage",
          "Only the host can retry."
        );

        return;
      }

      resetGame(
        lobby
      );

      io.to(
        lobby.id
      ).emit(
        "waitingForStart"
      );

      broadcastLobbies();
    }
  );

  // ==========================================================
  // LEAVE
  // ==========================================================

  socket.on(
    "leaveLobby",
    () => {
      leaveLobby(
        socket
      );
    }
  );

  // ==========================================================
  // INPUT
  // ==========================================================

  socket.on(
    "input",
    data => {
      const lobby =
        lobbies.get(
          socket.data.lobbyId
        );

      if (
        !lobby ||
        lobby.status !==
          "playing"
      ) {
        return;
      }

      const p =
        lobby.game.players[
          socket.id
        ];

      if (!p) return;

      const keys =
        data &&
        data.keys
          ? data.keys
          : {};

      p.keys.w =
        !!keys.w;

      p.keys.a =
        !!keys.a;

      p.keys.s =
        !!keys.s;

      p.keys.d =
        !!keys.d;

      if (
        typeof data.aim ===
          "number" &&
        Number.isFinite(
          data.aim
        )
      ) {
        p.aim =
          data.aim;
      }

      p.shooting =
        !!data.shooting;
    }
  );

  // ==========================================================
  // DISCONNECT
  // ==========================================================

  socket.on(
    "disconnect",
    () => {
      console.log(
        "Disconnected:",
        socket.id
      );

      leaveLobby(
        socket
      );
    }
  );
});

// ============================================================
// LEAVE LOBBY
// ============================================================

function leaveLobby(
  socket
) {
  const lobbyId =
    socket.data.lobbyId;

  if (!lobbyId) return;

  const lobby =
    lobbies.get(
      lobbyId
    );

  if (!lobby) {
    socket.data.lobbyId =
      null;

    return;
  }

  // ==========================================================
  // HOST LEAVES
  // ==========================================================

  // The host leaving destroys
  // the entire public lobby.

  if (
    socket.id ===
    lobby.host
  ) {
    io.to(
      lobby.id
    ).emit(
      "hostLeft"
    );

    lobbies.delete(
      lobby.id
    );

    io.in(
      lobby.id
    ).socketsLeave(
      lobby.id
    );

    console.log(
      `Lobby removed because host left: ${lobby.name}`
    );

    broadcastLobbies();

    socket.data.lobbyId =
      null;

    return;
  }

  // ==========================================================
  // NORMAL PLAYER LEAVES
  // ==========================================================

  lobby.players =
    lobby.players.filter(
      id =>
        id !==
        socket.id
    );

  delete lobby.playerNames[
    socket.id
  ];

  delete lobby.game.players[
    socket.id
  ];

  socket.leave(
    lobby.id
  );

  socket.data.lobbyId =
    null;

  if (
    lobby.players.length ===
    0
  ) {
    lobbies.delete(
      lobby.id
    );
  } else {
    lobby.status =
      "waiting";

    lobby.game.status =
      "waiting";

    lobby.game.bullets =
      [];

    lobby.game.winner =
      null;

    sendLobby(
      lobby
    );
  }

  broadcastLobbies();
}

// ============================================================
// 60 FPS SERVER LOOP
// ============================================================

let lastTick =
  Date.now();

setInterval(
  () => {
    const now =
      Date.now();

    const dt =
      Math.min(
        (now - lastTick) /
          1000,
        0.05
      );

    for (
      const lobby of
        lobbies.values()
    ) {
      updateGame(
        lobby,
        dt
      );
    }

    lastTick =
      now;
  },
  TICK
);

// ============================================================
// SERVER
// ============================================================

const PORT =
  process.env.PORT ||
  3000;

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `BOUNCE server running on port ${PORT}`
    );
  }
);
