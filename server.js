const WebSocket = require("ws");
const http = require("http");

const server = http.createServer();
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

/* -------------------- DATA -------------------- */

const ROLES = ["heca", "mahsi", "vireta"];

const ROLE_STATS = {
  heca: { maxHp: 30, hp: 30 },
  mahsi: { maxHp: 50, hp: 50 },
  vireta: { maxHp: 25, hp: 25 }
};

const ACTIONS = {
  heca: ["attack", "defend", "heal"],
  mahsi: ["attack", "defend", "taunt"],
  vireta: ["attack", "defend", "fireball"]
};

function createBattle(id) {
  if (id === 1) {
    return [
      { name: "Goblin A", hp: 20, maxHp: 20 },
      { name: "Goblin B", hp: 20, maxHp: 20 },
      { name: "Goblin C", hp: 20, maxHp: 20 }
    ];
  }

  if (id === 2) {
    return [
      { name: "Orc Boss", hp: 60, maxHp: 60 },
      { name: "Dire Wolf 1", hp: 25, maxHp: 25 },
      { name: "Dire Wolf 2", hp: 25, maxHp: 25 }
    ];
  }
}

const lobbies = new Map();

/* -------------------- LOBBY -------------------- */

function createLobby(isPrivate = false) {
  const code = Math.random().toString(36).substring(2, 7).toUpperCase();

  const lobby = {
    code,
    private: isPrivate,
    players: [],
    host: null,
    battleNumber: 1,
    enemies: createBattle(1),
    phase: "battle", // battle | rest | finished
    submittedActions: {},
    ready: new Set()
  };

  lobbies.set(code, lobby);
  return lobby;
}

/* -------------------- UTIL -------------------- */

function send(ws, type, data) {
  ws.send(JSON.stringify({ type, data }));
}

function broadcast(lobby, type, data) {
  lobby.players.forEach(p => send(p.ws, type, data));
}

function getPublicLobby() {
  for (const lobby of lobbies.values()) {
    if (!lobby.private && lobby.players.length < 3) {
      return lobby;
    }
  }
  return createLobby(false);
}

/* -------------------- TURN SYSTEM -------------------- */

function allPlayersSubmitted(lobby) {
  return lobby.players.every(p => lobby.submittedActions[p.id]);
}

function resolveTurn(lobby) {
  const log = [];

  // PLAYER ACTIONS
  for (const player of lobby.players) {
    const action = lobby.submittedActions[player.id];
    if (!action) continue;

    const targetEnemy = lobby.enemies[action.target];

    if (!targetEnemy || targetEnemy.hp <= 0) continue;

    if (action.type === "attack") {
      targetEnemy.hp -= 8;
      log.push(`${player.role} attacks ${targetEnemy.name} for 8`);
    }

    if (action.type === "defend") {
      player.defending = true;
      log.push(`${player.role} defends`);
    }

    if (action.type === "heal") {
      player.hp = Math.min(player.maxHp, player.hp + 10);
      log.push(`Heca heals for 10`);
    }

    if (action.type === "taunt") {
      player.taunting = true;
      log.push(`Mahsi taunts enemies`);
    }

    if (action.type === "fireball") {
      lobby.enemies.forEach(e => {
        if (e.hp > 0) e.hp -= 6;
      });
      log.push(`Vireta casts fireball`);
    }
  }

  // ENEMY TURN
  for (const enemy of lobby.enemies) {
    if (enemy.hp <= 0) continue;

    const targets = lobby.players.filter(p => p.hp > 0);
    if (!targets.length) break;

    const target =
      targets.find(p => p.taunting) ||
      targets[Math.floor(Math.random() * targets.length)];

    let dmg = 6;
    if (target.defending) dmg = 3;

    target.hp -= dmg;

    log.push(`${enemy.name} hits ${target.role} for ${dmg}`);
  }

  // CLEAN FLAGS
  lobby.players.forEach(p => {
    p.defending = false;
    p.taunting = false;
  });

  lobby.submittedActions = {};

  checkBattleEnd(lobby, log);

  broadcast(lobby, "turnResult", {
    log,
    enemies: lobby.enemies,
    players: lobby.players.map(p => ({
      role: p.role,
      hp: p.hp,
      maxHp: p.maxHp
    })),
    phase: lobby.phase
  });
}

/* -------------------- BATTLE FLOW -------------------- */

function checkBattleEnd(lobby, log) {
  const enemiesAlive = lobby.enemies.some(e => e.hp > 0);
  const playersAlive = lobby.players.some(p => p.hp > 0);

  if (!playersAlive) {
    lobby.phase = "finished";
    log.push("Party defeated!");
    return;
  }

  if (!enemiesAlive) {
    if (lobby.battleNumber === 1) {
      lobby.phase = "rest";
      log.push("Battle won! Entering rest phase.");
    } else {
      lobby.phase = "finished";
      log.push("Victory! Game complete.");
    }
  }
}

/* -------------------- CONNECTION -------------------- */

let idCounter = 1;

wss.on("connection", ws => {
  const player = {
    id: idCounter++,
    ws,
    role: null,
    lobby: null,
    hp: 0,
    maxHp: 0
  };

  ws.on("message", message => {
    let msg;

    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    handleMessage(player, msg);
  });

  ws.on("close", () => {
    if (player.lobby) {
      const lobby = player.lobby;
      lobby.players = lobby.players.filter(p => p !== player);
      broadcast(lobby, "system", `${player.role} disconnected`);
    }
  });
});

/* -------------------- MESSAGE HANDLER -------------------- */

function handleMessage(player, msg) {
  const { type, data } = msg;

  // CHAT
  if (type === "chat") {
    broadcast(player.lobby, "chat", {
      role: player.role,
      message: data
    });
  }

  // CREATE LOBBY
  if (type === "createLobby") {
    const lobby = createLobby(data.private);
    joinLobby(player, lobby);
  }

  // JOIN PUBLIC
  if (type === "joinPublic") {
    const lobby = getPublicLobby();
    joinLobby(player, lobby);
  }

  // JOIN PRIVATE
  if (type === "joinPrivate") {
    const lobby = lobbies.get(data.code);
    if (lobby) joinLobby(player, lobby);
  }

  // CHOOSE ROLE
  if (type === "chooseRole") {
    if (!player.lobby) return;

    const taken = player.lobby.players.some(p => p.role === data.role);
    if (taken) return;

    player.role = data.role;
    const stats = ROLE_STATS[data.role];
    player.hp = stats.hp;
    player.maxHp = stats.maxHp;

    broadcast(player.lobby, "system", `${data.role} joined`);

    sendState(player.lobby);
  }

  // SUBMIT ACTION
  if (type === "action") {
    const lobby = player.lobby;
    if (!lobby || lobby.phase !== "battle") return;

    lobby.submittedActions[player.id] = data;

    if (allPlayersSubmitted(lobby)) {
      resolveTurn(lobby);
    }
  }

  // READY DURING REST
  if (type === "ready") {
    const lobby = player.lobby;
    if (!lobby || lobby.phase !== "rest") return;

    lobby.ready.add(player.id);

    if (lobby.ready.size === lobby.players.length) {
      lobby.ready.clear();
      lobby.battleNumber++;
      lobby.enemies = createBattle(lobby.battleNumber);
      lobby.phase = "battle";

      broadcast(lobby, "system", "Next battle begins!");
      sendState(lobby);
    }
  }
}

/* -------------------- JOIN -------------------- */

function joinLobby(player, lobby) {
  if (lobby.players.length >= 3) return;

  lobby.players.push(player);
  player.lobby = lobby;

  if (!lobby.host) lobby.host = player;

  send(player.ws, "joined", {
    code: lobby.code,
    host: lobby.host === player
  });

  sendState(lobby);
}

/* -------------------- STATE -------------------- */

function sendState(lobby) {
  broadcast(lobby, "state", {
    players: lobby.players.map(p => ({
      role: p.role,
      hp: p.hp,
      maxHp: p.maxHp
    })),
    enemies: lobby.enemies,
    phase: lobby.phase,
    battleNumber: lobby.battleNumber,
    code: lobby.code
  });
}

/* -------------------- START -------------------- */

server.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});