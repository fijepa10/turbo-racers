const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O to avoid confusion
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function createRoom(ws, username, color, trackLength) {
  const code = generateCode();
  const playerId = 'p_' + Math.random().toString(36).substr(2, 6);
  const player = {
    id: playerId,
    ws,
    username: username || 'Host',
    color: color || '#3399ff',
    ready: false,
    isHost: true,
    isAI: false,
    input: { steering: 0, throttle: 0, brake: 0 },
    x: 0, y: 0, angle: 0, speed: 0, lap: 0, progress: 0, totalProgress: 0
  };

  const room = {
    code,
    state: 'lobby', // lobby, countdown, racing, finished
    hostId: playerId,
    trackLength: trackLength || 'medium',
    players: [player],
    seed: 0,
    tickInterval: null,
    raceStartTime: 0,
    createdAt: Date.now()
  };

  rooms.set(code, room);

  // Auto-expire after 30 min
  setTimeout(() => {
    if (rooms.has(code)) {
      const r = rooms.get(code);
      if (r.tickInterval) clearInterval(r.tickInterval);
      rooms.delete(code);
    }
  }, 30 * 60 * 1000);

  return {
    roomCode: code,
    playerId,
    players: [{ id: playerId, username: player.username, color: player.color, ready: false, isHost: true }]
  };
}

function joinRoom(code, ws, username, color) {
  code = (code || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) return { error: 'Room not found' };
  if (room.state !== 'lobby') return { error: 'Race already in progress' };
  if (room.players.length >= 6) return { error: 'Room is full (max 6)' };

  // Check if color is taken
  if (room.players.some(p => p.color === color)) {
    return { error: 'Color already taken. Pick another.' };
  }

  const playerId = 'p_' + Math.random().toString(36).substr(2, 6);
  const player = {
    id: playerId,
    ws,
    username: username || 'Player',
    color: color || '#3399ff',
    ready: false,
    isHost: false,
    isAI: false,
    input: { steering: 0, throttle: 0, brake: 0 },
    x: 0, y: 0, angle: 0, speed: 0, lap: 0, progress: 0, totalProgress: 0
  };

  room.players.push(player);

  return {
    roomCode: code,
    playerId,
    trackLength: room.trackLength,
    players: room.players.filter(p => !p.isAI).map(p => ({
      id: p.id, username: p.username, color: p.color, ready: p.ready, isHost: p.isHost
    }))
  };
}

function removePlayer(code, playerId) {
  const room = rooms.get(code);
  if (!room) return;

  room.players = room.players.filter(p => p.id !== playerId);

  if (room.players.filter(p => !p.isAI).length === 0) {
    // No humans left
    if (room.tickInterval) clearInterval(room.tickInterval);
    rooms.delete(code);
    return;
  }

  // If host left during lobby, assign new host
  if (room.hostId === playerId && room.state === 'lobby') {
    const newHost = room.players.find(p => !p.isAI);
    if (newHost) {
      newHost.isHost = true;
      room.hostId = newHost.id;
    }
  }
}

function getRoom(code) {
  return rooms.get(code);
}

module.exports = { createRoom, joinRoom, removePlayer, getRoom, rooms };
