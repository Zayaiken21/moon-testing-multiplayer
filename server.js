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
/* the game is hosted separately, so nothing here serves it */
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
    spots: new Map(),          // name -> where they last were
    vehicles: new Map(),       // id -> the one true record of every craft
    host: null,
    vehicles: new Map(),
    time: 0.28,
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

// one clock for the whole room, ticked here so nobody drifts
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.players.size) continue;
    room.time = (room.time + 2 / 600) % 1;
    room.weatherIn = (room.weatherIn || 90) - 2;
    if (room.weatherIn <= 0) {
      const kinds = ['clear', 'clear', 'cloudy', 'rain', 'snow'];
      room.weather = kinds[Math.floor(Math.random() * kinds.length)];
      room.weatherIn = 120 + Math.random() * 180;
      for (const p of room.players.values()) p.socket.send(JSON.stringify({ t: 'weather', weather: room.weather }));
    }
    const msg = JSON.stringify({ t: 'time', time: room.time });
    for (const p of room.players.values()) p.socket.send(msg);
  }
}, 2000);

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
    .filter(v => !v.private && !v.closed)
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

/* ---------- who is opening the game ---------- */
const { GitHubStore } = require('./store-github');
const { Accounts } = require('./accounts');

/* Real accounts live in Supabase; GitHub keeps a snapshot so Supabase is never
   the only copy. Nothing about money is decided in a browser. */
const accounts = new Accounts({ log: (m) => console.log('  accounts: ' + m) });
const pendingResets = [];        // shown on the admin page until email is wired up

/* The record lives in a GitHub repo, not on Render's disk, because that disk is
   wiped on every redeploy. Render reads it on boot and commits changes back. */
const store = new GitHubStore({ localDir: __dirname, log: (m) => console.log('  store: ' + m) });

const STATS_FILE = path.join(__dirname, 'stats.json');
const ADMIN_KEY = opt('admin', process.env.ADMIN_KEY || 'voxelia');

const stats = {
  total: 0, today: 0, todayKey: '', days: {}, referrers: {}, devices: {},
  countries: {}, firstSeen: new Date().toISOString(), sessions: [], peakRooms: 0
};
store.load('stats.json', null).then((saved) => {
  if (saved) Object.assign(stats, saved);
  console.log('  visits on record: ' + (stats.total || 0));
});
let statsDirty = false;
/* a room nobody is in, or whose host walked out, does not linger */
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (r.players.size === 0 && (r.closed || (r.emptiedAt && now - r.emptiedAt > 120000))) {
      rooms.delete(code);
      console.log('Cleared room ' + code + '.');
    }
  }
}, 30000);

setInterval(() => {
  if (!statsDirty) return;
  statsDirty = false;
  store.save('stats.json', stats);
}, 10000);

const dayKey = () => new Date().toISOString().slice(0, 10);

/* Who is playing right now, in a room or alone.
   Clients send a heartbeat once a minute; anyone quiet for three is gone. */
const heartbeats = new Map();     // account -> { at, mode, minutes }
const ALIVE_MS = 180000;

function markAlive(acc, mode) {
  if (!acc) return;
  const now = Date.now();
  const was = heartbeats.get(acc);
  const rec = was || { at: now, mode, minutes: 0, since: now };
  // a heartbeat within the window means another minute of play
  if (was && now - was.at < ALIVE_MS) rec.minutes += (now - was.at) / 60000;
  else rec.since = now;
  rec.at = now;
  rec.mode = mode || rec.mode;
  heartbeats.set(acc, rec);
  stats.minutes = (stats.minutes || 0) + (was && now - was.at < ALIVE_MS ? (now - was.at) / 60000 : 0);
  stats.players = stats.players || {};
  if (stats.players[acc]) stats.players[acc].minutes = Math.round(rec.minutes);
  statsDirty = true;
}

function livePlayers() {
  const now = Date.now();
  let solo = 0;
  const seen = new Set();
  for (const [acc, h] of heartbeats) {
    if (now - h.at > ALIVE_MS) { heartbeats.delete(acc); continue; }
    seen.add(acc);
    solo++;
  }
  let inRooms = 0;
  for (const r of rooms.values()) inRooms += r.players.size;
  return { total: Math.max(solo, inRooms), solo, inRooms, sessions: seen.size };
}

function recordVisit(req, body) {
  const key = dayKey();
  if (stats.todayKey !== key) { stats.todayKey = key; stats.today = 0; }
  stats.total++;
  stats.today++;
  stats.days[key] = (stats.days[key] || 0) + 1;
  const ref = (body && body.ref) || req.headers.referer || 'direct';
  const host = String(ref).replace(/^https?:\/\//, '').split('/')[0] || 'direct';
  stats.referrers[host] = (stats.referrers[host] || 0) + 1;
  const ua = String(req.headers['user-agent'] || '');
  const device = /iPhone|iPod/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad'
               : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac'
               : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'other';
  stats.devices[device] = (stats.devices[device] || 0) + 1;
  if (body && body.account) {
    stats.players = stats.players || {};
    const first = !stats.players[body.account];
    stats.players[body.account] = { first: first ? new Date().toISOString()
      : stats.players[body.account].first, last: new Date().toISOString(),
      opens: (first ? 0 : stats.players[body.account].opens) + 1 };
  }
  stats.sessions.unshift({
    at: new Date().toISOString(), device,
    from: host, mode: (body && body.mode) || 'unknown',
    standalone: !!(body && body.standalone)
  });
  if (stats.sessions.length > 200) stats.sessions.length = 200;
  const live = Array.from(rooms.values()).length;
  if (live > stats.peakRooms) stats.peakRooms = live;
  statsDirty = true;
}

/* ---------- the ledger ----------
   Money is decided here and nowhere else. The browser is only ever a display.
   A creature is identified by the world it came from plus its own spawn key,
   so the same animal can never be claimed twice, by anyone, ever.        */
const LEDGER_FILE = path.join(__dirname, 'ledger.json');
const ledger = {
  accounts: {},        // account -> { balance, caught, claims, created, lastSeen }
  claimed: {},         // creatureKey -> { account, at, cents }
  paid: 0
};
store.load('ledger.json', null).then((saved) => {
  if (saved) Object.assign(ledger, saved);
  console.log('  accounts on record: ' + Object.keys(ledger.accounts || {}).length);
});
let ledgerDirty = false;
setInterval(() => {
  if (!ledgerDirty) return;
  ledgerDirty = false;
  store.save('ledger.json', ledger);
}, 8000);

/* a redeploy should not lose the last minute of play */
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log('  shutting down, saving first...');
    store.save('stats.json', stats);
    store.save('ledger.json', ledger);
    await store.flushAll();
    process.exit(0);
  });
}

/* what a creature is worth, decided here so the client cannot argue */
const RARITY_CENTS = { common: 1, uncommon: 3, rare: 8, exotic: 15, legendary: 25 };
const DAILY_CAP_CENTS = 500;          // a sane ceiling per account per day

function account(id) {
  if (!ledger.accounts[id]) {
    ledger.accounts[id] = {
      balance: 0, caught: 0, claims: 0, today: 0, todayKey: '',
      created: new Date().toISOString(), lastSeen: null
    };
  }
  const a = ledger.accounts[id];
  const key = new Date().toISOString().slice(0, 10);
  if (a.todayKey !== key) { a.todayKey = key; a.today = 0; }
  a.lastSeen = new Date().toISOString();
  return a;
}

/* ---------- a light rate limit, per address ---------- */
const hits = new Map();          // ip -> { n, since }
const LIMIT = 120;               // requests
const WINDOW = 60000;            // per minute

function overLimit(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .toString().split(',')[0].trim();
  const now = Date.now();
  let rec = hits.get(ip);
  if (!rec || now - rec.since > WINDOW) { rec = { n: 0, since: now }; hits.set(ip, rec); }
  rec.n++;
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (now - v.since > WINDOW) hits.delete(k);
  }
  return rec.n > LIMIT;
}

/* ---------- HTTP ---------- */
const server = http.createServer((req, res) => {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (overLimit(req)) {
    res.writeHead(429, Object.assign({ 'content-type': 'application/json', 'retry-after': '60' }, cors));
    res.end(JSON.stringify({ error: 'Too many requests, try again in a minute.' }));
    return;
  }
  const url = req.url.split('?')[0];
  const json = (code, obj) => {
    res.writeHead(code, Object.assign({ 'content-type': 'application/json' }, cors));
    res.end(JSON.stringify(obj));
  };

  if (url === '/visit' && req.method === 'GET') {
    const q = req.url.split('?')[1] || '';
    const params = {};
    q.split('&').forEach(pair => {
      const [k, v] = pair.split('=');
      if (k) params[k] = decodeURIComponent(v || '');
    });
    if (params.mode === 'alive') {
      markAlive(params.account, params.play || 'survival');
      res.writeHead(200, Object.assign({ 'content-type': 'image/gif', 'cache-control': 'no-store' }, cors));
      res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
      return;
    }
    recordVisit(req, params);
    markAlive(params.account, params.play || 'survival');
    res.writeHead(200, Object.assign({ 'content-type': 'image/gif', 'cache-control': 'no-store' }, cors));
    // a one pixel answer, so it can also be used as an image if fetch is blocked
    res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
    return;
  }

  if (url === '/visit') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch (e) {}
      recordVisit(req, parsed);
      json(200, { ok: true, counted: stats.total });
    });
    return;
  }

  if (url.startsWith('/admin/accounts')) {
    const key = (req.url.split('key=')[1] || '').split('&')[0];
    if (key !== ADMIN_KEY) { json(401, { error: 'wrong key' }); return; }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', async () => {
        let m = {}; try { m = JSON.parse(body || '{}'); } catch (e) {}
        if (m.action === 'delete') { json(200, await accounts.remove(m.id)); return; }
        if (m.action === 'subscribe') { json(200, await accounts.setSubscription(m.id, !!m.on, m.until)); return; }
        if (m.action === 'create') {
          const made = await accounts.signUp({
            email: m.email, username: m.username, password: m.password || 'testerpass1'
          });
          if (made.ok) {
            const a = await accounts.find(made.account.id);
            a.role = m.role || 'tester';
            if (m.subscribed) { a.subscribed = true; }
            await accounts.put(a);
            made.account = accounts.publicView(a);
          }
          json(200, made);
          return;
        }
        json(400, { error: 'unknown action' });
      });
      return;
    }

    (async () => {
      json(200, {
        accounts: await accounts.list(100),
        resets: pendingResets.slice(0, 20),
        rates: { perCreature: 1, freeDaily: 5, memberDaily: 25 },
        supabase: accounts.enabled ? accounts.shards.length + ' project(s)' : 'not configured'
      });
    })();
    return;
  }

  if (url === '/admin/data') {
    const key = (req.url.split('key=')[1] || '').split('&')[0];
    if (key !== ADMIN_KEY) { json(401, { error: 'wrong key' }); return; }
    const days = Object.keys(stats.days).sort().slice(-30);
    const accounts = Object.entries(ledger.accounts)
      .sort((a, b) => b[1].balance - a[1].balance).slice(0, 40)
      .map(([id, a]) => ({ id, balance: a.balance, caught: a.caught, lastSeen: a.lastSeen }));
    json(200, {
      wallet: {
        paid: ledger.paid, claimed: Object.keys(ledger.claimed).length,
        accounts: Object.keys(ledger.accounts).length, top: accounts, rates: RARITY_CENTS
      },
      lifetime: (() => {
        const live = livePlayers();
        const ps = Object.values(stats.players || {});
        const mins = Math.round(stats.minutes || 0);
        return {
          players: ps.length,
          onlineNow: live.total,
          playingAlone: live.solo - live.inRooms > 0 ? live.solo - live.inRooms : 0,
          inRooms: live.inRooms,
          returning: ps.filter(p => p.opens > 1).length,
          minutes: mins,
          hours: Math.round(mins / 60),
          avgMinutes: ps.length ? Math.round(mins / ps.length) : 0
        };
      })(),
      total: stats.total, today: stats.today, firstSeen: stats.firstSeen,
      peakRooms: stats.peakRooms,
      days: days.map(d => ({ day: d, visits: stats.days[d] })),
      referrers: Object.entries(stats.referrers).sort((a, b) => b[1] - a[1]).slice(0, 12),
      devices: Object.entries(stats.devices).sort((a, b) => b[1] - a[1]),
      sessions: stats.sessions.slice(0, 40),
      rooms: Array.from(rooms.values()).map(r => ({
        code: r.code, name: r.name, players: r.players.size, max: r.max,
        public: r.public, closed: !!r.closed, edits: r.edits.size
      }))
    });
    return;
  }


  /* claim a creature. The first account to tame it is paid; nobody after. */
  if (url === '/claim' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let m = {};
      try { m = JSON.parse(body || '{}'); } catch (e) {}
      const acc = String(m.account || '').slice(0, 64);
      const key = String(m.creature || '').slice(0, 120);
      const rarity = String(m.rarity || 'common');
      const mode = String(m.mode || '');

      if (!acc || !key) { json(400, { error: 'account and creature are required' }); return; }
      if (mode !== 'survival') { json(200, { ok: false, why: 'Only survival counts.' }); return; }
      if (!/^[a-zA-Z0-9_:\-.]+$/.test(key)) { json(400, { error: 'bad creature key' }); return; }

      const a = account(acc);
      const already = ledger.claimed[key];
      if (already) {
        json(200, {
          ok: false, why: already.account === acc
            ? 'You have already been paid for this one.'
            : 'Someone else caught this one first.',
          balance: a.balance, caught: a.caught
        });
        return;
      }
      const cents = RARITY_CENTS[rarity] !== undefined ? RARITY_CENTS[rarity] : 1;
      if (a.today + cents > DAILY_CAP_CENTS) {
        json(200, { ok: false, why: 'Daily limit reached. It resets tomorrow.',
                    balance: a.balance, caught: a.caught });
        return;
      }
      ledger.claimed[key] = { account: acc, at: Date.now(), cents };
      a.balance += cents;
      a.today += cents;
      a.caught++;
      a.claims++;
      ledger.paid += cents;
      ledgerDirty = true;
      json(200, { ok: true, cents, balance: a.balance, caught: a.caught, rarity });
    });
    return;
  }

  /* an account's companions, kept here so an update to the game cannot lose them */
  if (url.startsWith('/companions') && req.method === 'GET') {
    const acc = (req.url.split('account=')[1] || '').split('&')[0];
    if (!acc) { json(400, { error: 'account required' }); return; }
    const a = account(decodeURIComponent(acc).slice(0, 64));
    json(200, { companions: a.companions || [], balance: a.balance, caught: a.caught });
    return;
  }

  if (url === '/companions' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      let m = {};
      try { m = JSON.parse(body || '{}'); } catch (e) {}
      const acc = String(m.account || '').slice(0, 64);
      if (!acc || !Array.isArray(m.companions)) { json(400, { error: 'account and companions required' }); return; }
      const a = account(acc);
      // names and species only: nothing here decides money
      a.companions = m.companions.slice(0, 500).map(c => ({
        key: String(c.key || '').slice(0, 120),
        species: String(c.species || '').slice(0, 40),
        name: String(c.name || '').slice(0, 24),
        since: c.since || Date.now()
      }));
      ledgerDirty = true;
      json(200, { ok: true, kept: a.companions.length });
    });
    return;
  }

  if (url.startsWith('/wallet')) {
    const acc = (req.url.split('account=')[1] || '').split('&')[0];
    if (!acc) { json(400, { error: 'account required' }); return; }
    const a = account(decodeURIComponent(acc).slice(0, 64));
    json(200, {
      balance: a.balance, caught: a.caught, today: a.today,
      dailyCap: DAILY_CAP_CENTS, rates: RARITY_CENTS
    });
    return;
  }

  /* a pet changing hands: the new owner is recorded, but never paid again */
  if (url === '/transfer' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      let m = {};
      try { m = JSON.parse(body || '{}'); } catch (e) {}
      const key = String(m.creature || '').slice(0, 120);
      const to = String(m.to || '').slice(0, 64);
      const rec = ledger.claimed[key];
      if (!rec) { json(200, { ok: false, why: 'That creature was never claimed.' }); return; }
      rec.owner = to;                 // ownership moves
      rec.transfers = (rec.transfers || 0) + 1;
      ledgerDirty = true;             // the payout does not move with it
      json(200, { ok: true, paidTo: rec.account, owner: to, note: 'Ownership moved; no further payment.' });
    });
    return;
  }

  /* ---------------- accounts ---------------- */
  const readBody = (cb) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => { let m = {}; try { m = JSON.parse(body || '{}'); } catch (e) {} cb(m); });
  };

  if (url === '/account/signup' && req.method === 'POST') {
    readBody(async (m) => json(200, await accounts.signUp(m)));
    return;
  }
  if (url === '/account/signin' && req.method === 'POST') {
    readBody(async (m) => json(200, await accounts.signIn(m)));
    return;
  }
  if (url === '/account/forgot' && req.method === 'POST') {
    readBody(async (m) => {
      const out = await accounts.beginReset(m.email);
      // the token is not emailed yet: it is handed to the admin page instead
      if (out.token) pendingResets.unshift({ email: String(m.email || '').toLowerCase(), token: out.token, at: Date.now() });
      if (pendingResets.length > 50) pendingResets.length = 50;
      json(200, { ok: true, sent: true });   // the same answer whether or not the email exists
    });
    return;
  }
  if (url === '/account/reset' && req.method === 'POST') {
    readBody(async (m) => json(200, await accounts.completeReset(m.token, m.password)));
    return;
  }
  if (url.startsWith('/account/me')) {
    const t = (req.url.split('session=')[1] || '').split('&')[0];
    (async () => {
      const id = accounts.sessionAccount(decodeURIComponent(t || ''));
      if (!id) { json(401, { error: 'not signed in' }); return; }
      const a = await accounts.find(id);
      json(200, a ? accounts.publicView(a) : { error: 'gone' });
    })();
    return;
  }
  if (url === '/account/companions' && req.method === 'POST') {
    readBody(async (m) => {
      const id = accounts.sessionAccount(m.session);
      if (!id) { json(401, { error: 'not signed in' }); return; }
      json(200, await accounts.setCompanions(id, m.companions));
    });
    return;
  }

  if (url === '/rooms' || url === '/games') {
    res.setHeader('cache-control', 'public, max-age=8');
    json(200, Array.from(rooms.values())
      .filter(r => r.public && !r.closed)
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

  /* This service is the multiplayer server and nothing else. The game itself
     lives on GitHub Pages, so the root here is the admin page. */
  if (url === '/' || url === '/admin' || url === '/admin/') {
    fs.readFile(path.join(__dirname, 'admin.html'), (err, data) => {
      if (err) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Voxelia server</title>' +
                '<body style="background:#081428;color:#E8F1FF;font-family:system-ui;padding:40px">' +
                '<h1>Voxelia server</h1><p>Running. The game is served from GitHub Pages; ' +
                'this address only handles rooms and the admin page.</p>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(data);
    });
    return;
  }

  if (url === '/index.html' || url === '/voxelia.html') {
    // somebody looking for the game: send them to where it actually lives
    res.writeHead(404, Object.assign({ 'content-type': 'text/plain' }, cors));
    res.end('The game is not served from here. This address is the multiplayer server.');
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
    const spot = room.spots.get(player.name) || null;
    sock.send(JSON.stringify({
      t: 'welcome', you: id, room: room.code, serverName: room.name,
      resume: spot,
      vehicles: Array.from(room.vehicles.values()),
      host: room.host === id,
      seed: room.seed, mode: room.mode, max: room.max,
      edits: Array.from(room.edits, ([k, v]) => [k, v]),
      time: room.time,
      vehicles: Array.from(room.vehicles.values()),
      weather: room.weather || 'clear',
      players: Array.from(room.players.values()).filter(p => p.id !== id)
        .map(p => ({ id: p.id, name: p.name, skin: p.skin, x: p.x, y: p.y, z: p.z, yaw: p.yaw }))
    }));
    broadcast({ t: 'join', id, name: player.name, skin: player.skin }, id);
    // tell the newcomer who is already here, so voice can be dialled up
    sock.send(JSON.stringify({ t: 'roster', players: Array.from(room.players.keys()).filter(p => p !== id) }));
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
        existing.host = id;
      enter(existing, m.player, m.skin);
        return;
      }
      const r = createRoom({ name: m.name, seed: m.seed, mode: m.mode, public: m.public, max: m.max, code: asked });
      r.host = id;
      enter(r, m.player, m.skin);
      return;
    }

    if (m.t === 'join' && !room) {
      const r = rooms.get(String(m.room || ''));
      if (!r || r.closed) { sock.send(JSON.stringify({ t: 'error', why: 'That room has closed.' })); return; }
      if (r.players.size >= r.max) { sock.send(JSON.stringify({ t: 'error', why: 'That room is full.' })); return; }
      enter(r, m.name, m.skin);
      return;
    }

    if (!room) return;
    const player = room.players.get(id);
    if (!player) return;

    if (m.t === 'move') {
      player.x = m.x; player.y = m.y; player.z = m.z; player.yaw = m.yaw;
      room.spots.set(player.name, { x: m.x, y: m.y, z: m.z, yaw: m.yaw });
      if (m.realm) player.realm = String(m.realm).slice(0, 32);
      broadcast({ t: 'move', id, name: player.name, skin: player.skin, x: m.x, y: m.y, z: m.z,
                  yaw: m.yaw, riding: m.riding || null, realm: player.realm || 'ground' }, id);
    } else if (m.t === 'edit') {
      if (!Number.isFinite(m.x) || !Number.isFinite(m.y) || !Number.isFinite(m.z)) return;
      room.edits.set((m.x | 0) + ',' + (m.y | 0) + ',' + (m.z | 0), m.b | 0);
      room.dirty = true;
      broadcast({ t: 'edit', id, x: m.x | 0, y: m.y | 0, z: m.z | 0, b: m.b | 0 }, id);
    } else if (m.t === 'vehicle') {
      // one record per craft, kept here, so nobody can end up with a copy
      const vid = String(m.id || '').slice(0, 40);
      if (!vid) return;
      if (m.gone) {
        room.vehicles.delete(vid);
        broadcast({ t: 'vehicle', id: vid, gone: true });
        return;
      }
      let v = room.vehicles.get(vid);
      if (!v) {
        v = { id: vid, item: m.item, seats: Math.max(1, Math.min(24, m.seats || 2)),
              driver: null, riders: [] };
        room.vehicles.set(vid, v);
      }
      // only the driver may move it
      if (v.driver && v.driver !== id) return;
      v.x = m.x; v.y = m.y; v.z = m.z; v.yaw = m.yaw; v.lights = m.lights;
      broadcast({ t: 'vehicle', id: vid, item: v.item, x: v.x, y: v.y, z: v.z, yaw: v.yaw,
                  lights: v.lights, seats: v.seats, driver: v.driver, riders: v.riders }, id);

    } else if (m.t === 'offer' || m.t === 'offer-reply') {
      // a companion changing hands: passed straight to the one person it is for
      const target = room.players.get(String(m.to || ''));
      if (target) {
        target.socket.send(JSON.stringify(Object.assign({}, m, { id, name: player.name })));
      }
    } else if (m.t === 'rope') {
      broadcast({ t: 'rope', id: m.id, out: !!m.out, length: m.length || 12 }, id);
    } else if (m.t === 'board') {
      const v = room.vehicles.get(String(m.id || ''));
      if (!v) { sock.send(JSON.stringify({ t: 'seat', id: m.id, ok: false, why: 'gone' })); return; }
      if (v.riders.indexOf(id) < 0) {
        if (v.riders.length >= v.seats) {
          sock.send(JSON.stringify({ t: 'seat', id: v.id, ok: false, why: 'full' }));
          return;
        }
        v.riders.push(id);
      }
      // first one aboard drives; everyone after rides
      if (!v.driver) v.driver = id;
      const seat = v.riders.indexOf(id);
      broadcast({ t: 'seat', id: v.id, ok: true, who: id, seat,
                  driver: v.driver, riders: v.riders, item: v.item,
                  x: v.x, y: v.y, z: v.z, yaw: v.yaw });

    } else if (m.t === 'unboard') {
      const v = room.vehicles.get(String(m.id || ''));
      if (!v) return;
      v.riders = v.riders.filter(r => r !== id);
      if (v.driver === id) v.driver = v.riders[0] || null;   // the wheel passes on
      broadcast({ t: 'seat', id: v.id, ok: true, who: id, left: true,
                  driver: v.driver, riders: v.riders });

    } else if (m.t === 'realm') {
      player.realm = String(m.realm || 'ground').slice(0, 32);
      broadcast({ t: 'realm', id, realm: player.realm }, id);
    } else if (m.t === 'crew') {
      // the pilot moves the whole crew at once, so nobody is left behind
      const crew = Array.isArray(m.crew) ? m.crew.slice(0, 24) : [id];
      const realm = String(m.realm || 'ground').slice(0, 32);
      for (const c of crew) {
        const cp = room.players.get(c);
        if (cp) cp.realm = realm;
      }
      broadcast({ t: 'crew', realm, planet: m.planet, crew, site: m.site || null });
    } else if (m.t === 'signal') {
      const dest = room.players.get(m.to);
      if (dest) dest.socket.send(JSON.stringify({ t: 'signal', from: id, data: m.data }));
    } else if (m.t === 'voice') {
      broadcast({ t: 'voice', id, on: !!m.on }, id);
    } else if (m.t === 'ping') {
      player.socket.send(JSON.stringify({ t: 'pong' }));
    } else if (m.t === 'chat') {
      broadcast({ t: 'chat', id, name: player.name, msg: String(m.msg).slice(0, 200) });
    }
  };

  sock.onclose = () => {
    if (!room) return;
    const player = room.players.get(id);
    if (!player) return;
    for (const v of room.vehicles.values()) {
      if (v.riders.indexOf(id) < 0) continue;
      v.riders = v.riders.filter(r => r !== id);
      if (v.driver === id) v.driver = v.riders[0] || null;
      broadcast({ t: 'seat', id: v.id, ok: true, who: id, left: true,
                  driver: v.driver, riders: v.riders });
    }
    room.spots.set(player.name, { x: player.x, y: player.y, z: player.z, yaw: player.yaw });
    room.players.delete(id);
    broadcast({ t: 'leave', id });
    // the host walking out closes the room: everyone goes back to the title
    if (room.host === id) {
      room.public = false;             // off the list at once
      room.closed = true;
      const bye = JSON.stringify({ t: 'hostleft', room: room.code });
      for (const p of room.players.values()) { p.socket.send(bye); }
      setTimeout(() => { for (const p of room.players.values()) p.socket.close(); }, 400);
      room.dirty = true;
      saveRoom(room);
      setTimeout(() => {
        if (!room.players.size) { rooms.delete(room.code); console.log('Room ' + room.code + ' closed.'); }
      }, 1500);
      console.log('Host left room ' + room.code + ' \u2014 everyone sent home.');
    }
    if (!room.players.size) { room.emptiedAt = Date.now(); saveRoom(room); }
    console.log(player.name + ' left room ' + room.code + ' (' + room.players.size + '/' + room.max + ')');
  };
});

server.listen(PORT, () => {
  console.log('');
  console.log('  Voxelia server: ' + NAME);
  console.log('  admin page:    http://localhost:' + PORT + '/');
  console.log('  the game itself is served separately, from GitHub Pages');
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
