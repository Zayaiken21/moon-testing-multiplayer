#!/usr/bin/env node
/* =====================================================================
   Voxelia host — serves the game and runs a shared world.
   No dependencies. Node 16 or newer.

     node server.js
     node server.js --port 8080 --seed amber-meadow-421 --name "Ben's world"
     node server.js --directory http://my-directory:9000   (advertise publicly)
     node server.js --hub                                  (also BE a directory)

   Players open http://<this machine>:<port>/ and press Join, or enter
   the same address in the game's Multiplayer screen.
   ===================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------- options ---------- */
const argv = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = argv.indexOf('--' + flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (flag) => argv.includes('--' + flag);

const PORT = parseInt(opt('port', process.env.PORT || 8080), 10);
const SEED = opt('seed', 'amber-meadow-' + (100 + Math.floor(Math.random() * 900)));
const MODE = opt('mode', 'survival');
const NAME = opt('name', 'Voxelia server');
const MAX_PLAYERS = parseInt(opt('max', 16), 10);
const DIRECTORY = opt('directory', '');
const ROOM = opt('room', String(Math.floor(1000000 + Math.random() * 9000000)));
const PRIVATE = has('private');
const IS_HUB = has('hub');
const CLIENT = path.join(__dirname, opt('client', 'voxelia.html'));
const SAVE_FILE = path.join(__dirname, opt('save', 'world-' + SEED + '.json'));

/* ---------- rooms ---------- */
/* One process hosts many games. A player presses Host in the game, the relay
   makes a room and hands back a seven digit code. Nobody types an IP. */
const rooms = new Map();          // code -> { code, name, seed, mode, public, max, edits, players }

function newCode() {
  let c;
  do { c = String(Math.floor(1000000 + Math.random() * 9000000)); } while (rooms.has(c));
  return c;
}

function roomFile(code) { return path.join(__dirname, 'room-' + code + '.json'); }

function createRoom(opts) {
  const code = (opts.code && /^\d{7}$/.test(opts.code) && !rooms.has(opts.code)) ? opts.code : newCode();
  const room = {
    code,
    name: String(opts.name || 'A Voxelia world').slice(0, 48),
    seed: String(opts.seed || ('relay-' + code)).slice(0, 48),
    mode: opts.mode === 'creative' ? 'creative' : 'survival',
    public: opts.public !== false,
    max: Math.min(64, Math.max(1, opts.max | 0 || 8)),
    edits: new Map(),
    players: new Map(),
    dirty: false,
    born: Date.now()
  };
  if (fs.existsSync(roomFile(code))) {
    try {
      const d = JSON.parse(fs.readFileSync(roomFile(code), 'utf8'));
      (d.edits || []).forEach(([k, v]) => room.edits.set(k, v));
      if (d.seed) room.seed = d.seed;
    } catch (e) {}
  }
  rooms.set(code, room);
  console.log('Room ' + code + ' opened: "' + room.name + '" seed ' + room.seed +
              ' (' + (room.public ? 'public' : 'private') + ', up to ' + room.max + ')');
  return room;
}

function saveRoom(room) {
  if (!room.dirty) return;
  room.dirty = false;
  fs.writeFile(roomFile(room.code), JSON.stringify({
    format: 'voxelia-room', code: room.code, name: room.name, seed: room.seed, mode: room.mode,
    savedAt: new Date().toISOString(),
    edits: Array.from(room.edits, ([k, v]) => [k, v])
  }), () => {});
}

setInterval(() => {
  for (const room of rooms.values()) {
    saveRoom(room);
    // an empty room is kept for ten minutes so a host can rejoin the same code
    if (!room.players.size && Date.now() - (room.emptiedAt || room.born) > 600000) {
      rooms.delete(room.code);
      console.log('Room ' + room.code + ' closed (empty).');
    }
  }
}, 15000);

let nextId = 1;

/* ---------- a small, correct WebSocket implementation ---------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81;                       // FIN + text opcode
  return Buffer.concat([header, payload]);
}

class Socket {
  constructor(raw) {
    this.raw = raw;
    this.buf = Buffer.alloc(0);
    this.open = true;
    this.onmessage = null;
    this.onclose = null;
    raw.on('data', (chunk) => this.feed(chunk));
    raw.on('close', () => this.close());
    raw.on('error', () => this.close());
  }

  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2)); offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < offset + maskLen + len) return;
      const mask = masked ? this.buf.slice(offset, offset + 4) : null;
      const data = this.buf.slice(offset + maskLen, offset + maskLen + len);
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      this.buf = this.buf.slice(offset + maskLen + len);

      if (opcode === 0x8) { this.close(); return; }          // close
      if (opcode === 0x9) {                                   // ping -> pong
        const pong = Buffer.concat([Buffer.from([0x8a, data.length]), data]);
        this.raw.write(pong);
        continue;
      }
      if (opcode === 0x1 && this.onmessage) this.onmessage(data.toString('utf8'));
    }
  }

  send(text) {
    if (!this.open) return;
    try { this.raw.write(encodeFrame(text)); } catch (e) { this.close(); }
  }

  close() {
    if (!this.open) return;
    this.open = false;
    try { this.raw.destroy(); } catch (e) {}
    if (this.onclose) this.onclose();
  }
}

/* ---------- directory of advertised games ---------- */
const hub = new Map();              // address -> { name, seed, players, maxPlayers, seen }
function hubList() {
  const now = Date.now();
  for (const [k, v] of hub) if (now - v.seen > 90000) hub.delete(k);
  return Array.from(hub.values())
    .filter(v => !v.private)
    .map(v => ({
      name: v.name, seed: v.seed, address: v.address, room: v.room,
      players: v.players, maxPlayers: v.maxPlayers
    }));
}

function announce() {
  if (!DIRECTORY) return;
  const body = JSON.stringify({
    name: NAME, seed: world.seed, port: PORT, room: world.room, private: PRIVATE,
    players: players.size, maxPlayers: MAX_PLAYERS
  });
  try {
    const url = new URL(DIRECTORY.replace(/\/$/, '') + '/announce');
    const req = (url.protocol === 'https:' ? require('https') : http).request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    }, (res) => res.resume());
    req.on('error', () => {});
    req.end(body);
  } catch (e) { /* directory unreachable; carry on hosting */ }
}
if (DIRECTORY) setInterval(announce, 30000);

/* ---------- HTTP ---------- */
const server = http.createServer((req, res) => {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  const url = req.url.split('?')[0];
  const json = (code, obj) => {
    res.writeHead(code, Object.assign({ 'content-type': 'application/json' }, cors));
    res.end(JSON.stringify(obj));
  };

  if (url === '/rooms' || url === '/games') {
    json(200, Array.from(rooms.values())
      .filter(r => r.public)
      .map(r => ({ code: r.code, name: r.name, seed: r.seed, mode: r.mode,
                   players: r.players.size, max: r.max })));
    return;
  }

  if (url === '/room') {
    const code = (req.url.split('code=')[1] || '').split('&')[0];
    const r = rooms.get(code);
    if (!r) { json(404, { error: 'No room with that code is open.' }); return; }
    json(200, { code: r.code, name: r.name, seed: r.seed, mode: r.mode, players: r.players.size, max: r.max });
    return;
  }

  if (url === '/status') {
    json(200, {
      relay: NAME,
      rooms: Array.from(rooms.values()).map(r => ({
        code: r.code, name: r.name, public: r.public, players: r.players.size, max: r.max, edits: r.edits.size
      }))
    });
    return;
  }

  if (url === '/' || url === '/index.html' || url === '/voxelia.html') {
    fs.readFile(CLIENT, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('voxelia.html was not found next to server.js.');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});

/* ---------- WebSocket upgrade ---------- */
server.on('upgrade', (req, raw) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { raw.destroy(); return; }
  raw.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
  );
  const sock = new Socket(raw);
  const id = 'p' + (nextId++);
  let room = null;

  const broadcast = (obj, exceptId) => {
    if (!room) return;
    const msg = JSON.stringify(obj);
    for (const p of room.players.values()) if (p.id !== exceptId) p.socket.send(msg);
  };

  const enter = (r, name, skin) => {
    room = r;
    const player = { id, name: String(name || 'Wanderer').slice(0, 24), skin: skin || {}, socket: sock, x: 0, y: 40, z: 0, yaw: 0 };
    room.players.set(id, player);
    sock.send(JSON.stringify({
      t: 'welcome', you: id, room: room.code, serverName: room.name,
      seed: room.seed, mode: room.mode, max: room.max,
      edits: Array.from(room.edits, ([k, v]) => [k, v]),
      players: Array.from(room.players.values()).filter(p => p.id !== id)
        .map(p => ({ id: p.id, name: p.name, skin: p.skin, x: p.x, y: p.y, z: p.z, yaw: p.yaw }))
    }));
    broadcast({ t: 'join', id, name: player.name, skin: player.skin }, id);
    console.log(player.name + ' entered room ' + room.code + ' (' + room.players.size + '/' + room.max + ')');
  };

  sock.onmessage = (text) => {
    let m;
    try { m = JSON.parse(text); } catch (e) { return; }

    if (m.t === 'host' && !room) {
      // a host coming back to the same world keeps its code, as long as nobody
      // else is using it
      const asked = String(m.code || '');
      const existing = rooms.get(asked);
      if (existing && !existing.players.size) {
        existing.name = String(m.name || existing.name).slice(0, 48);
        existing.public = m.public !== false;
        existing.max = Math.min(64, Math.max(1, m.max | 0 || existing.max));
        existing.emptiedAt = 0;
        console.log('Room ' + asked + ' reopened by its host.');
        enter(existing, m.player, m.skin);
        return;
      }
      const r = createRoom({ name: m.name, seed: m.seed, mode: m.mode, public: m.public, max: m.max, code: asked });
      enter(r, m.player, m.skin);
      return;
    }

    if (m.t === 'join' && !room) {
      const r = rooms.get(String(m.room || ''));
      if (!r) { sock.send(JSON.stringify({ t: 'error', why: 'No room with that code is open.' })); return; }
      if (r.players.size >= r.max) { sock.send(JSON.stringify({ t: 'error', why: 'That room is full.' })); return; }
      enter(r, m.name, m.skin);
      return;
    }

    if (!room) return;
    const player = room.players.get(id);
    if (!player) return;

    if (m.t === 'move') {
      player.x = m.x; player.y = m.y; player.z = m.z; player.yaw = m.yaw;
      broadcast({ t: 'move', id, name: player.name, skin: player.skin, x: m.x, y: m.y, z: m.z, yaw: m.yaw }, id);
    } else if (m.t === 'edit') {
      if (!Number.isFinite(m.x) || !Number.isFinite(m.y) || !Number.isFinite(m.z)) return;
      room.edits.set((m.x | 0) + ',' + (m.y | 0) + ',' + (m.z | 0), m.b | 0);
      room.dirty = true;
      broadcast({ t: 'edit', id, x: m.x | 0, y: m.y | 0, z: m.z | 0, b: m.b | 0 }, id);
    } else if (m.t === 'chat') {
      broadcast({ t: 'chat', id, name: player.name, msg: String(m.msg).slice(0, 200) });
    }
  };

  sock.onclose = () => {
    if (!room) return;
    const player = room.players.get(id);
    if (!player) return;
    room.players.delete(id);
    broadcast({ t: 'leave', id });
    if (!room.players.size) { room.emptiedAt = Date.now(); saveRoom(room); }
    console.log(player.name + ' left room ' + room.code + ' (' + room.players.size + '/' + room.max + ')');
  };
});

server.listen(PORT, () => {
  console.log('');
  console.log('  Voxelia server: ' + NAME);
  console.log('  players open:  http://localhost:' + PORT + '/');
  for (const [iface, addrs] of Object.entries(require('os').networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log('  on your network: http://' + a.address + ':' + PORT + '/   (' + iface + ')');
    }
  }
  console.log('');
  console.log('  Rooms are made from inside the game: Multiplayer \u2192 Host.');
  console.log('  Each room gets a seven digit code and saves to room-<code>.json.');
  console.log('');
});

process.on('SIGINT', () => {
  for (const r of rooms.values()) { r.dirty = true; saveRoom(r); }
  console.log('\nRooms saved. Bye.');
  process.exit(0);
});
