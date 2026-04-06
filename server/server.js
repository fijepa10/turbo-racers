const http = require('http');
const { WebSocketServer } = require('ws');
const { createRoom, joinRoom, getRoom, removePlayer, rooms } = require('./room');

const PORT = process.env.PORT || 3000;

const httpServer = http.createServer((req, res) => {
  // CORS headers for health check
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.playerId = null;
  ws.roomCode = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'create_room': {
        const result = createRoom(ws, msg.username, msg.color, msg.trackLength);
        ws.playerId = result.playerId;
        ws.roomCode = result.roomCode;
        ws.send(JSON.stringify({
          type: 'room_created',
          roomCode: result.roomCode,
          players: result.players,
          you: result.playerId
        }));
        break;
      }

      case 'join_room': {
        const result = joinRoom(msg.roomCode, ws, msg.username, msg.color);
        if (result.error) {
          ws.send(JSON.stringify({ type: 'error', message: result.error }));
          return;
        }
        ws.playerId = result.playerId;
        ws.roomCode = result.roomCode;
        ws.send(JSON.stringify({
          type: 'room_joined',
          roomCode: result.roomCode,
          players: result.players,
          you: result.playerId,
          trackLength: result.trackLength
        }));
        // Notify others
        const room = getRoom(result.roomCode);
        if (room) broadcastToRoom(room, {
          type: 'player_joined',
          players: result.players
        }, ws);
        break;
      }

      case 'player_ready': {
        const room = getRoom(ws.roomCode);
        if (!room) return;
        const p = room.players.find(p => p.id === ws.playerId);
        if (p) p.ready = true;
        broadcastToRoom(room, {
          type: 'player_update',
          players: room.players.map(serializePlayer)
        });
        break;
      }

      case 'start_game': {
        const room = getRoom(ws.roomCode);
        if (!room || room.hostId !== ws.playerId) return;
        if (room.state !== 'lobby') return;
        startGame(room);
        break;
      }

      case 'input': {
        const room = getRoom(ws.roomCode);
        if (!room || room.state !== 'racing') return;
        const p = room.players.find(p => p.id === ws.playerId);
        if (p) {
          p.input = { steering: msg.steering || 0, throttle: msg.throttle || 0, brake: msg.brake || 0 };
          if (msg.x !== undefined) p.x = msg.x;
          if (msg.y !== undefined) p.y = msg.y;
          if (msg.angle !== undefined) p.angle = msg.angle;
          if (msg.speed !== undefined) p.speed = msg.speed;
          if (msg.lap !== undefined) p.lap = msg.lap;
          if (msg.progress !== undefined) p.progress = msg.progress;
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.roomCode) {
      const room = getRoom(ws.roomCode);
      if (room) {
        removePlayer(ws.roomCode, ws.playerId);
        if (room.players.length === 0) return; // room auto-deleted
        broadcastToRoom(room, {
          type: 'player_left',
          players: room.players.map(serializePlayer),
          leftId: ws.playerId
        });
      }
    }
  });
});

function serializePlayer(p) {
  return { id: p.id, username: p.username, color: p.color, ready: p.ready, isHost: p.isHost };
}

function broadcastToRoom(room, msg, excludeWs) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p.ws && p.ws !== excludeWs && p.ws.readyState === 1) {
      p.ws.send(data);
    }
  }
}

function startGame(room) {
  room.state = 'countdown';
  room.seed = (Math.random() * 2 ** 32) | 0;

  // Fill remaining slots with AI
  const aiColors = ['#3399ff', '#ff4444', '#bbbbbb', '#44ff44', '#cc44ff', '#ffaa00'];
  const usedColors = new Set(room.players.map(p => p.color));
  let aiIdx = 0;
  while (room.players.length < 6) {
    let color = aiColors.find(c => !usedColors.has(c));
    if (!color) break;
    usedColors.add(color);
    const aiNames = { '#3399ff': 'Blue Bolt', '#ff4444': 'Red Fury', '#bbbbbb': 'Chrome', '#44ff44': 'Green Machine', '#cc44ff': 'Purple Phantom', '#ffaa00': 'Gold Rush' };
    room.players.push({
      id: 'ai_' + aiIdx++,
      username: aiNames[color] || 'Bot',
      color,
      ready: true,
      isHost: false,
      isAI: true,
      ws: null,
      input: { steering: 0, throttle: 0, brake: 0 },
      // AI state will be initialized by clients
      x: 0, y: 0, angle: 0, speed: 0, lap: 0, progress: 0, totalProgress: 0
    });
  }

  const startMsg = {
    type: 'game_starting',
    seed: room.seed,
    trackLength: room.trackLength,
    players: room.players.map(p => ({
      id: p.id,
      username: p.username,
      color: p.color,
      isAI: !!p.isAI
    }))
  };

  broadcastToRoom(room, startMsg);

  // Countdown
  let count = 3;
  const countdownInterval = setInterval(() => {
    broadcastToRoom(room, { type: 'countdown', value: count });
    count--;
    if (count < 0) {
      clearInterval(countdownInterval);
      room.state = 'racing';
      broadcastToRoom(room, { type: 'race_start' });
      startGameLoop(room);
    }
  }, 800);
}

function startGameLoop(room) {
  // Server tick at 20Hz - relay player positions
  room.tickInterval = setInterval(() => {
    if (room.state !== 'racing') {
      clearInterval(room.tickInterval);
      return;
    }

    // Collect all human player states from their latest input
    // The actual physics runs on each client - server just relays positions
    // This is a relay-authority model for simplicity
    const states = [];
    for (const p of room.players) {
      if (!p.isAI) {
        states.push({
          id: p.id,
          input: p.input,
          x: p.x, y: p.y, angle: p.angle, speed: p.speed,
          lap: p.lap, progress: p.progress
        });
      }
    }

    // Broadcast inputs to all clients so they can simulate
    broadcastToRoom(room, {
      type: 'state',
      players: states
    });

    // Check for race timeout (15 min)
    if (Date.now() - room.raceStartTime > 15 * 60 * 1000) {
      room.state = 'finished';
      broadcastToRoom(room, { type: 'race_timeout' });
      clearInterval(room.tickInterval);
    }
  }, 50);

  room.raceStartTime = Date.now();
}

// Heartbeat - clean up dead connections
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

httpServer.listen(PORT, () => {
  console.log(`Race server running on port ${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}`);
});
