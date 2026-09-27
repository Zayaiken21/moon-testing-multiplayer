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
    /* The weather rides along with the clock rather than only being sent when
       it changes: a dropped packet used to leave one player in the rain and
       everyone else in sunshine, which is why one screen was darker. */
    const msg = JSON.stringify({ t: 'time', time: room.time, weather: room.weather || 'clear' });
    for (const p of room.players.values()) p.socket.send(msg);
  }
}, 2000);

/* ---------------------------------------------------------------
   The movement tick.

   Everyone's position goes out together, twenty times a second, in a single
   message per player rather than one message per player per player. In a room
   of eight that is eight messages a tick instead of fifty-six, and each one
   is a short list of numbers rather than eight copies of everybody's outfit.

   A player who has not moved is left out, so a room standing still costs
   nothing at all.
   --------------------------------------------------------------- */
const MOVE_HZ = 20;
/* Above this many players in one room, each person is only told about the
   ones near them. NEAR_RANGE is in blocks and is comfortably past how far
   anyone can see. */
const NEAR_FROM = 24;
const NEAR_RANGE = 220;
let realmBeat = 0;
setInterval(() => {
  realmBeat++;
  for (const room of rooms.values()) {
    if (room.players.size < 2) {            // nobody to tell
      for (const p of room.players.values()) p.moved = false;
      continue;
    }
    const a = [];
    for (const p of room.players.values()) {
      if (!p.moved) continue;
      p.moved = false;
      a.push([p.id,
              Math.round(p.x * 100) / 100,
              Math.round(p.y * 100) / 100,
              Math.round(p.z * 100) / 100,
              Math.round(p.yaw * 1000) / 1000,
              p.anim | 0,
              p.riding || 0]);
    }
    if (a.length) {
      /* A big room only sends you the people near you.

         Telling everybody about everybody is fine for eight and hopeless for
         hundreds: the work grows with the square of the room. Past a couple
         of dozen players the list is cut down per person to those within
         sight, which keeps the cost flat however many join. */
      if (room.players.size <= NEAR_FROM) {
        const msg = JSON.stringify({ t: 'ms', a });
        const onlyMover = a.length === 1 ? a[0][0] : null;
        for (const p of room.players.values()) {
          if (onlyMover === p.id) continue;      // no point telling them about themselves
          p.socket.send(msg);
        }
      } else {
        for (const p of room.players.values()) {
          const mine = [];
          for (const row of a) {
            if (row[0] === p.id) continue;
            const o = room.players.get(row[0]);
            if (!o) continue;
            if ((o.realm || 'ground') !== (p.realm || 'ground')) continue;
            const dx = o.x - p.x, dz = o.z - p.z;
            if (dx * dx + dz * dz > NEAR_RANGE * NEAR_RANGE) continue;
            mine.push(row);
            if (mine.length >= 40) break;
          }
          if (mine.length) p.socket.send(JSON.stringify({ t: 'ms', a: mine }));
        }
      }
    }
    /* Who is on which world. A realm message can be missed, and a missed one
       leaves somebody drawn on the wrong planet for good, so the whole picture
       goes out whenever it changes and once every ten seconds as a repair.
       A room where nobody is travelling says nothing at all. */
    if (realmBeat % 10 === 0 && room.players.size <= NEAR_FROM) {
      const r = [];
      for (const p of room.players.values()) r.push([p.id, p.realm || 'ground']);
      const stamp = JSON.stringify(r);
      const stale = !room.realmsAt || Date.now() - room.realmsAt > 10000;
      if (stamp !== room.realmsStamp || stale) {
        room.realmsStamp = stamp;
        room.realmsAt = Date.now();
        const msg = JSON.stringify({ t: 'realms', r });
        for (const p of room.players.values()) p.socket.send(msg);
      }
    }
  }
}, Math.round(1000 / MOVE_HZ));

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
const accountStore = accounts;   // the same thing, under a name nothing shadows
const pendingResets = [];        // shown on the admin page until email is wired up

/* The record lives in a GitHub repo, not on Render's disk, because that disk is
   wiped on every redeploy. Render reads it on boot and commits changes back. */
const store = new GitHubStore({ localDir: __dirname, log: (m) => console.log('  store: ' + m) });

/* Every number that decides money — what each animal pays, how much may be
   earned in a day, how much may be withdrawn and by whom — lives in one
   object the admin page edits, rather than as constants in three files that
   have to be kept in agreement by hand. */
const { Settings } = require('./settings');
const settings = new Settings({ store, log: (m) => console.log('  settings: ' + m) });
accounts.setSettings(settings);
settings.load().then(() => {
  const v = settings.values;
  console.log('  rates: ' + Object.keys(v.rates).map(k => k + ' ' + v.rates[k] + 'c').join(', '));
  console.log('  daily limit: free ' + v.caps.free + 'c, member ' + v.caps.member + 'c');
  console.log('  withdrawals: free from ' + v.withdraw.free.min + 'c, member from ' +
              v.withdraw.member.min + 'c');
});

/* Memberships, paid for with a card. Nothing here can grant one: Stripe's
   webhook does that, and only after its signature has been checked. */
const { Stripe } = require('./stripe');
const stripe = new Stripe({ log: (m) => console.log('  stripe: ' + m) });
if (stripe.ready) {
  console.log('  stripe: ready (' + (stripe.live ? 'LIVE — real cards' : 'test mode') +
              ', ' + stripe.trialDays + ' day free trial)');
  if (!stripe.webhookSecret) console.log('  stripe: ' + stripe.trouble);
} else {
  console.log('  stripe: not set up — ' + stripe.trouble);
}

const STATS_FILE = path.join(__dirname, 'stats.json');
/* The word that guards the admin page.

   It used to fall back to "voxelia", which is in the name of the game and so
   is the first thing anybody would try: every balance and every account was
   one guess away. If nothing is set, a long random one is made at boot and
   printed in the Render log instead, so an unguarded admin page cannot
   happen by accident. Set ADMIN_KEY in Render to choose your own and keep it
   the same across restarts. */
const ADMIN_KEY = opt('admin', process.env.ADMIN_KEY ||
  (() => {
    const made = require('crypto').randomBytes(12).toString('hex');
    console.log('  ADMIN_KEY is not set. Using this one until the next restart:');
    console.log('    ' + made);
    console.log('  Set ADMIN_KEY in the environment to keep one of your own.');
    return made;
  })());

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
const aliveNames = new Map();     // the same keys, with a name where we know one
const ALIVE_MS = 180000;

/**
 * Somebody is still playing.
 *
 * `who` is whoever this really is: the signed-in account when there is one,
 * and the browser's own id when there is not. It used to always be the
 * browser's id, so the same person on a phone and a laptop counted as two
 * players with half the playing time each, and the admin page could never
 * put a name to any of it.
 */
function markAlive(acc, mode, name) {
  if (!acc) return;
  const now = Date.now();
  const was = heartbeats.get(acc);
  if (name) aliveNames.set(acc, name);
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

/* The real accounts, kept to hand.

   The admin page asks for its figures every fifteen seconds and there may be
   several people looking at it. Reading the database that often would be a
   waste and, on a busy afternoon, a way to be rate limited by Supabase
   itself. So it is read at most once a minute and everything in between is
   answered from this. */
const realAccounts = { rows: [], at: 0, reading: false };
const REAL_EVERY = 60000;

function refreshRealAccounts(force) {
  /* `accounts.list()` answers from Supabase when it is configured and from
     the copy this process is holding when it is not, so this works either
     way — and a server running without keys still shows real names and real
     balances for everybody who signed up since it started, rather than an
     empty table. The `source` field on the answer says which it is. */
  if (!accounts) { realAccounts.rows = []; return; }
  const now = Date.now();
  if (!force && realAccounts.reading) return;
  if (!force && now - realAccounts.at < REAL_EVERY) return;
  realAccounts.reading = true;
  accounts.list(200).then((rows) => {
    realAccounts.rows = Array.isArray(rows) ? rows : [];
    realAccounts.at = Date.now();
  }).catch((e) => {
    console.log('  could not read accounts for the admin page: ' + (e && e.message));
    realAccounts.at = Date.now();          // do not hammer it after a failure
  }).then(() => { realAccounts.reading = false; });
}

/**
 * Act on something Stripe told us.
 *
 * Runs after the webhook has already been answered, so nothing here can make
 * Stripe wait or retry. Every path either finds the account and writes to it
 * or says in the log why it could not — a membership that silently fails to
 * turn on is the worst outcome, so it is never silent.
 */
async function handleStripeEvent(event) {
  const note = stripe.read(event);
  if (!note) return;                       // an event we do not act on

  /* Whose membership is this? The account id is put into the checkout and
     onto the subscription when it is made, so it is usually right there. An
     event made another way — cancelled from the Stripe dashboard, say —
     arrives without it, and then the customer id is the thread back. */
  let id = note.account;
  if (!id && note.customer) {
    const found = await accounts.findByCustomer(note.customer);
    if (found) id = found.id;
  }
  if (!id) {
    console.log('  stripe: ' + event.type + ' arrived with nobody attached to it');
    return;
  }

  if (note.what === 'started') {
    /* The checkout finished. The subscription's own event says whether it is
       trialing or active, and that one does the granting — but the customer
       and subscription ids are worth writing down now, so a later event
       without metadata can still be matched to this person. */
    await accounts.applyStripe(id, {
      customer: note.customer, subscription: note.subscription
    });
    console.log('  stripe: checkout finished for ' + id);
    accountsChanged();
    return;
  }

  const out = await accounts.applyStripe(id, note);
  console.log('  stripe: ' + id + ' is now ' + (note.member ? 'a member' : 'not a member') +
              ' (' + note.status + (note.trialing ? ', on the free trial' : '') + ')' +
              (out.ok ? '' : ' — BUT IT DID NOT SAVE: ' + out.why));
  accountsChanged();
}

/* Something changed that the admin page's cached list would not know about —
   somebody signed up, was paid, or took money out. Marking it stale costs
   nothing and means the next look is right, rather than up to a minute
   behind and showing "Accounts 0" next to a table with people in it. */
function accountsChanged() { realAccounts.at = 0; }

/** How long this person has played, in whole minutes. */
function playedBy(id) {
  const live = heartbeats.get(id);
  const kept = (stats.players && stats.players[id] && stats.players[id].minutes) || 0;
  return Math.round(Math.max(kept, live ? live.minutes : 0));
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

/* Visits, written somewhere that survives a restart.

   They are gathered up and sent in batches rather than one at a time: a
   busy minute should cost one round trip, not two hundred. Anything that
   cannot be sent is kept and tried again on the next batch, and the whole
   thing is best-effort — counting people must never be able to slow the
   game down or take the server with it. */
const visitQueue = [];

function queueVisit(row) {
  if (!accounts || !accounts.enabled) return;
  visitQueue.push(row);
  if (visitQueue.length > 500) visitQueue.splice(0, visitQueue.length - 500);
}

async function flushVisits() {
  if (!visitQueue.length || !accounts || !accounts.enabled) return;
  const batch = visitQueue.splice(0, 200);
  const out = await accounts.insert('visits', batch).catch(() => ({ ok: false }));
  if (!out.ok) {
    // put them back, but never let the queue grow without limit
    visitQueue.unshift(...batch.slice(0, 200 - visitQueue.length));
  }
}
setInterval(() => { flushVisits().catch(() => {}); }, 20000);

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

  queueVisit({
    device_id: String((body && body.account) || '').slice(0, 64) || null,
    account_id: (body && body.session && accounts.sessionAccount(String(body.session))) || null,
    kind: String((body && body.mode) || 'open').slice(0, 16),
    mode: String((body && body.play) || '').slice(0, 16) || null,
    ref: host.slice(0, 120),
    device,
    country: String(req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || '').slice(0, 8) || null,
    installed: !!(body && body.standalone)
  });
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

/* ---------- withdrawals waiting to be sent ----------
   The money has already left the balance by the time a row lands here, so
   this list is what you owe. It outlives a redeploy because it is saved the
   same way everything else is. */
let payoutQueue = [];
let payoutsDirty = false;
store.load('payouts.json', null).then((saved) => {
  if (Array.isArray(saved)) payoutQueue = saved;
  const open = payoutQueue.filter(p => p.status === 'requested').length;
  if (open) console.log('  withdrawals waiting to be sent: ' + open);
});

/* ---------- membership codes ----------
   One code, one membership. Made on the admin page, typed into the store in
   the game. Kept as a Map in memory and as a plain object on disk. */
const memberCodes = new Map();
let codesDirty = false;
store.load('member-codes.json', null).then((saved) => {
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(saved)) memberCodes.set(k, saved[k]);
    const spare = Array.from(memberCodes.values()).filter(c => !c.usedBy).length;
    console.log('  membership codes: ' + memberCodes.size + ' (' + spare + ' unused)');
  }
});
setInterval(() => {
  if (payoutsDirty) { payoutsDirty = false; store.save('payouts.json', payoutQueue); }
  if (codesDirty) {
    codesDirty = false;
    const out = {};
    for (const [k, v] of memberCodes) out[k] = v;
    store.save('member-codes.json', out);
  }
}, 8000);

/** A code somebody can read off a screen and type without mistakes. */
function makeCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no O/0, no I/1/L
  let s = '';
  for (let i = 0; i < 12; i++) {
    if (i === 4 || i === 8) s += '-';
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
}

/* a redeploy should not lose the last minute of play */
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log('  shutting down, saving first...');
    store.save('stats.json', stats);
    store.save('ledger.json', ledger);
    store.save('payouts.json', payoutQueue);
    store.save('settings.json', settings.values);
    const codes = {};
    for (const [k, v] of memberCodes) codes[k] = v;
    store.save('member-codes.json', codes);
    await store.flushAll();
    process.exit(0);
  });
}

/* what a creature is worth, decided here so the client cannot argue */
/* What an animal is worth.

   Most of what lives in the world is common, and common pays nothing: an
   ordinary animal is company, not wages. Only the scarcer ones are worth
   anything, and only to the first person anywhere who tames that particular
   animal. About one creature in five is above common, so this is something
   to go looking for rather than something to farm. */
/* These two are the numbers the game falls back on before settings have
   finished loading, and nothing else. Everything that decides money asks
   `settings` — see settings.js — so that changing a rate is a button on the
   admin page rather than an edit in three files and a redeploy. */
const RARITY_CENTS = { common: 0, uncommon: 2, rare: 6, exotic: 12, legendary: 30 };
const DAILY_CAP_CENTS = 500;          // only ever used if settings are missing

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
/* Requests allowed from one address per minute.

   A household is one address: two children playing, a phone, and the admin
   page open on a laptop all count together, and the admin page alone asks
   four times a minute. Two hundred leaves room for a family without leaving
   room for anybody hammering it. RATE_LIMIT raises it if you ever need to. */
const LIMIT = Math.max(30, Number(process.env.RATE_LIMIT) || 200);
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

/* A promise nobody was waiting on used to disappear without trace, taking
   the reply with it. Now it is at least written down. */
process.on('unhandledRejection', (e) => {
  console.log('  unhandled: ' + (e && e.message ? e.message : e));
});

/* ---------- HTTP ---------- */
const server = http.createServer((req, res) => {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  /* The heartbeat.

     Every open copy of the game calls this once a minute, so a free service
     that would otherwise fall asleep after fifteen quiet minutes stays up as
     long as anybody at all is playing. It is answered before the rate
     limiter and before anything that touches a disk, so it is as close to
     free as an answer can be, and it can never be the thing that runs the
     server out of room. */
  if (req.url.split('?')[0] === '/health') {
    let players = 0;
    for (const r of rooms.values()) players += r.players.size;
    res.writeHead(200, Object.assign({ 'content-type': 'application/json',
      'cache-control': 'no-store' }, cors));
    res.end(JSON.stringify({
      ok: true,
      up: Math.round(process.uptime()),
      rooms: rooms.size,
      players,
      // where accounts are kept: "supabase" once the keys are in, otherwise
      // "memory", which works but forgets everything on the next deploy
      accounts: accounts && accounts.enabled ? 'supabase' : 'memory',
      at: Date.now()
    }));
    return;
  }

  /* Stripe, telling us something.

     Answered before the rate limiter: Stripe can send a burst of events and
     being refused would mean a membership silently not turning on. It is
     safe to let through because nothing is believed until the signature has
     been checked against the webhook secret. */
  if (req.url.split('?')[0] === '/stripe/webhook' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 262144) req.destroy(); });
    req.on('end', () => {
      const checked = stripe.verify(raw, req.headers['stripe-signature']);
      if (!checked.ok) {
        console.log('  stripe: refused a webhook — ' + checked.why);
        res.writeHead(400, Object.assign({ 'content-type': 'application/json' }, cors));
        res.end(JSON.stringify({ ok: false, why: checked.why }));
        return;
      }
      /* Answer at once. Stripe gives a webhook a short time to reply and
         retries anything slow, so the work is done after the reply rather
         than making Stripe wait on a database. */
      res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, cors));
      res.end(JSON.stringify({ ok: true }));
      handleStripeEvent(checked.event).catch((e) =>
        console.log('  stripe: could not act on ' + (checked.event && checked.event.type) +
                    ': ' + (e && e.message)));
    });
    return;
  }

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
      /* A signed-in player is counted as themselves, not as the browser they
         happen to be sitting at. Without this, playing time was recorded
         against a device id and the same person on two devices looked like
         two people. */
      const who = (params.session && accounts.sessionAccount(params.session)) || params.account;
      markAlive(who, params.play || 'survival');
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

  /* ---------------- the numbers, from the admin page ----------------

     GET gives everything, POST lays a patch over it. What comes back always
     includes `notes`: anything that had to be corrected on the way in, so a
     figure that could not be honoured exactly never changes silently. */
  if (url.startsWith('/admin/settings')) {
    const key = (req.url.split('key=')[1] || '').split('&')[0];
    if (key !== ADMIN_KEY) { json(401, { error: 'wrong key' }); return; }
    if (req.method !== 'POST') {
      json(200, { ok: true, settings: settings.all(), defaults: require('./settings').DEFAULTS });
      return;
    }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let m = {};
      try { m = JSON.parse(body || '{}'); } catch (e) {}
      const out = m.reset ? settings.reset() : settings.update(m.settings || m);
      console.log('  settings changed from the admin page' +
        (out.notes && out.notes.length ? ' (' + out.notes.join('; ') + ')' : ''));
      json(200, out);
    });
    return;
  }

  /* ---------------- withdrawals, from the admin page ---------------- */
  if (url.startsWith('/admin/payouts')) {
    const key = (req.url.split('key=')[1] || '').split('&')[0];
    if (key !== ADMIN_KEY) { json(401, { error: 'wrong key' }); return; }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        (async () => {
          let m = {};
          try { m = JSON.parse(body || '{}'); } catch (e) {}
          const row = payoutQueue.find(p => p.id === String(m.id || ''));
          if (!row) { json(404, { ok: false, why: 'No such request.' }); return; }

          if (m.action === 'sent') {
            row.status = 'sent';
            row.provider_ref = String(m.ref || '').slice(0, 120);
            row.sent_at = new Date().toISOString();
            payoutsDirty = true;
            try { await accounts.insert('ledger', [{
              account_id: row.account_id, cents: -row.cents,
              reason: 'payout ' + row.id, at: row.sent_at
            }]); } catch (e) {}
            json(200, { ok: true, payout: row });
            return;
          }
          if (m.action === 'refuse') {
            /* Turned down: the money goes back, because it was taken out of
               the balance the moment it was asked for. */
            row.status = 'refused';
            row.why = String(m.why || '').slice(0, 200);
            row.closed_at = new Date().toISOString();
            payoutsDirty = true;
            const acc = await accounts.find(row.account_id);
            if (acc) {
              acc.balance = (acc.balance || 0) + row.cents;
              acc.payout_today = Math.max(0, (acc.payout_today || 0) - row.cents);
              acc.payout_month = Math.max(0, (acc.payout_month || 0) - row.cents);
              await accounts.put(acc);
            }
            json(200, { ok: true, payout: row, returned: row.cents });
            return;
          }
          json(400, { ok: false, why: 'action must be sent or refuse' });
        })().catch((e) => json(500, { ok: false, why: String(e && e.message) }));
      });
      return;
    }

    const open = payoutQueue.filter(p => p.status === 'requested');
    json(200, {
      ok: true,
      owed: open.reduce((n, p) => n + p.cents, 0),
      waiting: open,
      recent: payoutQueue.slice(0, 80),
      limits: settings.values.withdraw
    });
    return;
  }

  /* ---------------- membership codes, from the admin page ---------------- */
  if (url.startsWith('/admin/codes')) {
    const key = (req.url.split('key=')[1] || '').split('&')[0];
    if (key !== ADMIN_KEY) { json(401, { error: 'wrong key' }); return; }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 2048) req.destroy(); });
      req.on('end', () => {
        let m = {};
        try { m = JSON.parse(body || '{}'); } catch (e) {}
        const many = Math.max(1, Math.min(50, Math.round(Number(m.many) || 1)));
        const days = Math.max(1, Math.min(3650,
          Math.round(Number(m.days) || settings.values.membership.days)));
        const made = [];
        for (let i = 0; i < many; i++) {
          const shown = makeCode();
          /* Stored without its dashes, because that is how it arrives after
             somebody types it: the store strips them so a code works whether
             or not they bother with them. */
          memberCodes.set(shown.replace(/-/g, ''), {
            display: shown, days, made: Date.now(),
            note: String(m.note || '').slice(0, 80), usedBy: null
          });
          made.push(shown);
        }
        codesDirty = true;
        console.log('  ' + many + ' membership code(s) made, ' + days + ' days each');
        json(200, { ok: true, codes: made, days });
      });
      return;
    }

    const rows = Array.from(memberCodes.entries()).map(([k, v]) => ({
      code: v.display || k, days: v.days, note: v.note || '',
      made: v.made, usedBy: v.usedBy || null, usedAt: v.usedAt || null
    })).sort((a, b) => (b.made || 0) - (a.made || 0));
    json(200, {
      ok: true, codes: rows.slice(0, 200),
      unused: rows.filter(r => !r.usedBy).length, total: rows.length
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
        if (m.action === 'subscribe') {
          json(200, await accounts.setSubscription(m.id, !!m.on, m.until, m.days));
          return;
        }
        if (m.action === 'adjust') {
          /* Put money in or take it out by hand, with a reason written down.
             For fixing a mistake, not for making money appear. */
          const acc = await accounts.find(String(m.id || ''));
          if (!acc) { json(404, { ok: false, why: 'No such account.' }); return; }
          const by = Math.round(Number(m.cents) || 0);
          acc.balance = Math.max(0, (acc.balance || 0) + by);
          await accounts.put(acc);
          try { await accounts.insert('ledger', [{
            account_id: acc.id, cents: by,
            reason: 'admin: ' + String(m.why || 'no reason given').slice(0, 100),
            at: new Date().toISOString()
          }]); } catch (e) {}
          console.log('  balance of ' + acc.id + ' changed by ' + by + 'c by hand');
          json(200, { ok: true, account: accounts.publicView(acc) });
          return;
        }
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
        rates: settings.rates(),
        supabase: accounts.enabled ? accounts.shards.length + ' project(s)' : 'not configured'
      });
    })();
    return;
  }

  if (url === '/admin/data') {
    const key = (req.url.split('key=')[1] || '').split('&')[0];
    if (key !== ADMIN_KEY) { json(401, { error: 'wrong key' }); return; }
    const days = Object.keys(stats.days).sort().slice(-30);

    /* Who these people actually are.

       This table used to be built from `ledger.accounts`, which is keyed by
       the id a browser makes up for itself. So the admin page showed rows
       like "acc_zmi9tg7gmu1lz2fa · $0.00 · 0 caught" — a device, with a
       device's balance, which is always nothing for anybody who signed in,
       because a signed-in player's money goes to their real account.

       Real accounts live in Supabase. They are read on a timer rather than
       on every poll, because this page refreshes every fifteen seconds and
       nobody needs a database query that often. */
    refreshRealAccounts();
    const real = (realAccounts.rows || []).map((a) => ({
      id: a.id,
      name: a.username || a.email || a.id,
      email: a.email || '',
      balance: a.balance || 0,
      caught: a.caught || 0,
      minutes: playedBy(a.id),
      member: !!a.subscribed,
      lastSeen: a.last_seen || null,
      real: true
    }));
    /* Anybody playing without an account still counts as somebody playing,
       so they are listed too — plainly marked as a guest rather than dressed
       up as an account. */
    const guests = Object.entries(ledger.accounts)
      .filter(([id]) => !real.some(r => r.id === id))
      .map(([id, a]) => ({
        id, name: 'Guest · ' + id.slice(-6), email: '',
        balance: a.balance || 0, caught: a.caught || 0,
        minutes: playedBy(id), member: false, lastSeen: a.lastSeen, real: false
      }));
    /* Deliberately not called `accounts`: that is the name of the account
       store itself, and a local shadowing it inside this block is how a
       previous refactor turned a working route into a ReferenceError. */
    const table = real.concat(guests)
      .sort((a, b) => (b.balance - a.balance) || (b.minutes - a.minutes))
      .slice(0, 60);
    json(200, {
      wallet: {
        /* What has really been earned, which is the sum of what is sitting
           in people's accounts plus anything already paid out — not the
           running total this process happens to remember, which goes back to
           zero on every redeploy. */
        paid: real.reduce((n, a) => n + a.balance, 0) +
              payoutQueue.filter(p => p.status === 'sent').reduce((n, p) => n + p.cents, 0),
        held: real.reduce((n, a) => n + a.balance, 0),
        claimed: Object.keys(ledger.claimed).length,
        accounts: real.length,
        guests: guests.length,
        members: real.filter(a => a.member).length,
        top: table,
        rates: settings.rates(),
        source: (accountStore && accountStore.enabled) ? 'accounts' : 'memory'
      },
      lifetime: (() => {
        const live = livePlayers();
        const ps = Object.values(stats.players || {});
        const mins = Math.round(stats.minutes || 0);
        /* Hours were rounded to a whole number, so everything up to the
           first full hour anybody ever played showed as "0" — which reads
           as broken tracking rather than as a quiet week. One decimal, with
           the minutes beside it. */
        return {
          players: Math.max(ps.length, real.length),
          accounts: real.length,
          members: real.filter(a => a.member).length,
          onlineNow: live.total,
          playingAlone: live.solo - live.inRooms > 0 ? live.solo - live.inRooms : 0,
          inRooms: live.inRooms,
          returning: ps.filter(p => p.opens > 1).length,
          minutes: mins,
          hours: Math.round(mins / 6) / 10,
          avgMinutes: ps.length ? Math.round(mins / ps.length) : 0
        };
      })(),
      total: stats.total, today: stats.today, firstSeen: stats.firstSeen,
      peakRooms: stats.peakRooms,
      days: days.map(d => ({ day: d, visits: stats.days[d] })),
      referrers: Object.entries(stats.referrers).sort((a, b) => b[1] - a[1]).slice(0, 12),
      devices: Object.entries(stats.devices).sort((a, b) => b[1] - a[1]),
      sessions: stats.sessions.slice(0, 40),
      kept: !!(accountStore && accountStore.enabled),
      rooms: Array.from(rooms.values()).map(r => ({
        code: r.code, name: r.name, players: r.players.size, max: r.max,
        public: r.public, closed: !!r.closed, edits: r.edits.size
      }))
    });
    return;
  }

  /* The numbers that survive a restart.

     Everything in /admin/data lives in this process, so a redeploy or a
     spin-down takes it with it — which is why the admin page kept going
     back to zero. These come out of the database, where they stay. */
  if (url === '/admin/history') {
    const key = (req.url.split('key=')[1] || '').split('&')[0];
    if (key !== ADMIN_KEY) { json(401, { error: 'wrong key' }); return; }
    if (!accountStore || !accountStore.enabled) {
      json(200, { kept: false, why: 'Set SUPABASE_URLS and SUPABASE_SERVICE_KEYS to keep history.' });
      return;
    }
    (async () => {
      try {
        const [days, sources, devices] = await Promise.all([
          accountStore.read('visit_days?order=day.desc&limit=60'),
          accountStore.read('visit_sources?limit=15'),
          accountStore.read('visit_devices?limit=12')
        ]);
        json(200, { kept: true, days: days || [], sources: sources || [], devices: devices || [],
                    waiting: visitQueue.length });
      } catch (e) {
        json(200, { kept: true, error: String(e && e.message) });
      }
    })();
    return;
  }


  /* claim a creature. The first account to tame it is paid; nobody after. */
  if (url === '/claim' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let m = {};
      try { m = JSON.parse(body || '{}'); } catch (e) {}
      /* Whose money this is.

         The page sends a device id, which is all a guest has. If it also
         sends a session, that session is the truth: the money belongs to
         whoever is signed in, not to whatever id the page happened to make
         up, and a page cannot claim to be somebody else by sending their id.
         This is what puts earnings into a real account rather than leaving
         them on one browser. */
      const signedIn = m.session ? accounts.sessionAccount(String(m.session)) : null;
      const acc = signedIn || String(m.account || '').slice(0, 64);
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
      const cents = settings.worth(rarity);
      if (cents <= 0) {
        // it still counts as met, it simply is not worth anything
        json(200, { ok: false, why: 'A common animal. Lovely, but it pays nothing.',
                    cents: 0, balance: a.balance, caught: a.caught, rarity });
        return;
      }
      if (settings.values.earningPaused) {
        json(200, { ok: false, why: 'Earning is paused just now. Your animal is still yours.',
                    balance: a.balance, caught: a.caught });
        return;
      }

      /* Writing the claim down, in the right order.

         This used to happen here, before anybody had been paid: the creature
         was marked claimed, the in-memory figures were raised, and only then
         was the real account asked. If the account said no — the daily
         ceiling, a database that would not answer — the browser was still
         told `ok: true` with a balance taken from this process's own ledger.
         The player read "Caught! $0.06 added", their account never moved,
         and because the creature was already marked claimed they could never
         try again. Money that was never paid, and an animal burned for it.

         So nothing is written down until somebody has actually been paid.
         For a signed-in player the account is the only authority; the ledger
         below is a record of what happened, written afterwards, never the
         thing that decides. */
      const record = (paid) => {
        accountsChanged();          // balances on the admin page are now old
        ledger.claimed[key] = { account: acc, at: Date.now(), cents: paid };
        a.balance += paid;
        a.today += paid;
        a.caught++;
        a.claims++;
        ledger.paid += paid;
        ledgerDirty = true;
      };

      if (signedIn) {
        accounts.credit(signedIn, key, false, rarity).then((out) => {
          if (out && out.ok) {
            record(out.cents);
            json(200, {
              ok: true, cents: out.cents, worth: out.worth, short: !!out.short,
              balance: out.balance,
              caught: out.caught !== undefined ? out.caught : a.caught,
              today: out.today, cap: out.cap, tier: out.tier,
              rarity, account: acc, signedIn: true
            });
            return;
          }
          /* Not paid. Say so, honestly, and leave the animal unclaimed so it
             can be tried again when whatever went wrong is fixed. */
          console.log('  credit ' + signedIn + ': ' + (out && out.why));
          json(200, {
            ok: false, why: (out && out.why) || 'That could not be paid just now.',
            code: (out && out.code) || 'refused',
            cents: 0, worth: (out && out.worth) || cents,
            balance: (out && out.balance) || 0,
            today: out && out.today, cap: out && out.cap,
            rarity, account: acc, signedIn: true
          });
        }).catch((e) => {
          console.log('  credit failed: ' + (e && e.message));
          json(200, {
            ok: false, code: 'error',
            why: 'Your wallet could not be reached just then — nothing was lost, ' +
                 'and this animal can still be claimed.',
            cents: 0, rarity, account: acc, signedIn: true
          });
        });
        return;
      }

      /* A guest, with no account to pay into. The device ledger is all there
         is, and it has a ceiling of its own so one browser cannot run away
         with it. What they earn moves across when they make an account. */
      const guestCap = settings.capFor('free');
      const room = Math.max(0, guestCap - a.today);
      if (room <= 0) {
        json(200, { ok: false, code: 'capped',
                    why: 'That is all for today. A membership raises the daily limit.',
                    balance: a.balance, caught: a.caught, today: a.today, cap: guestCap });
        return;
      }
      const paid = Math.min(cents, room);
      record(paid);
      json(200, { ok: true, cents: paid, worth: cents, short: paid < cents,
                  balance: a.balance, caught: a.caught, today: a.today,
                  cap: guestCap, rarity, account: acc, signedIn: false });
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
    const q = req.url.split('?')[1] || '';
    const val = (name) => {
      const hit = q.split('&').find((kv) => kv.indexOf(name + '=') === 0);
      return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
    };
    const sess = val('session');
    const signedIn = sess ? accounts.sessionAccount(sess) : null;
    const acc = (signedIn || val('account')).slice(0, 64);
    if (!acc) { json(400, { error: 'account required' }); return; }

    /* Signed in, the wallet shown is the account's own — the one that
       follows them from their phone to a computer. A guest sees the one
       that belongs to this browser. */
    if (signedIn) {
      accounts.find(signedIn).then((a) => {
        if (!a) { json(200, { balance: 0, caught: 0, today: 0, dailyCap: settings.capFor('free'), rates: settings.rates() }); return; }
        json(200, {
          balance: a.balance || 0, caught: a.caught || 0, today: a.today || 0,
          dailyCap: accounts.dailyCap(a), rates: settings.rates(),
          tier: accounts.tier(a), member: accounts.isMember(a),
          subscription_until: a.subscription_until || null,
          withdraw: accounts.withdrawableFor(a), membership: settings.values.membership,
          username: a.username, signedIn: true
        });
      }).catch(() => json(200, { balance: 0, caught: 0, today: 0, dailyCap: settings.capFor('free'), rates: settings.rates() }));
      return;
    }
    const a = account(acc);
    json(200, {
      balance: a.balance, caught: a.caught, today: a.today,
      dailyCap: settings.capFor('free'), rates: settings.rates(),
      tier: 'free', member: false, membership: settings.values.membership,
      withdraw: { ok: false, why: 'Make an account to withdraw what you earn.', min: settings.withdrawFor('free').min, most: 0 }
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

  /* ---------------- what the numbers currently are ----------------

     The game asks this so the wallet, the map legend and the store all show
     what the server will actually do, rather than a copy of the figures that
     was right when the page was written. Anyone may read it; only the admin
     key may change it. */
  if (url === '/settings' || url === '/rates') {
    json(200, settings.publicView());
    return;
  }

  /* ---------------- withdrawals ----------------

     Money leaves an account here and nowhere else. Every limit — the
     minimum, the most in one request, the most in a day, the most in a month
     — is per tier and comes from settings, so all of it is controlled from
     the admin page.

     Nothing in this file moves real money. A request is a request: it takes
     the amount out of the balance so it cannot be asked for twice, writes it
     down, and waits for a person to send it. */
  if (url.startsWith('/payout/quote')) {
    const sess = (req.url.split('session=')[1] || '').split('&')[0];
    (async () => {
      try {
        const id = accounts.sessionAccount(decodeURIComponent(sess || ''));
        if (!id) { json(200, { ok: false, why: 'Sign in to withdraw what you have earned.' }); return; }
        json(200, await accounts.withdrawable(id));
      } catch (e) {
        json(200, { ok: false, why: 'The server hit a problem: ' + (e && e.message) });
      }
    })();
    return;
  }

  if (url === '/payout/request' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      (async () => {
        let m = {};
        try { m = JSON.parse(body || '{}'); } catch (e) {}
        try {
          const id = accounts.sessionAccount(String(m.session || ''));
          if (!id) { json(200, { ok: false, why: 'Sign in to withdraw what you have earned.' }); return; }
          const out = await accounts.requestPayout(id, m.cents, m.method, m.destination);
          if (out.ok) {
            console.log('  payout asked for: ' + out.payout.cents + 'c by ' +
                        (out.payout.username || out.payout.account_id));
            payoutQueue.unshift(out.payout);
            if (payoutQueue.length > 500) payoutQueue.length = 500;
            payoutsDirty = true;
            accountsChanged();
          }
          json(200, out);
        } catch (e) {
          console.log('  /payout/request failed: ' + (e && e.message));
          json(200, { ok: false, why: 'The server hit a problem. Nothing was taken.' });
        }
      })();
    });
    return;
  }

  /* ---------------- the membership store ----------------

     What a membership does is raise the daily earning limit and open
     withdrawals sooner; both figures are settings, so what is being sold is
     whatever the admin page currently says it is.

     Being straight about payment: nothing here is connected to a card
     processor, and this does not pretend otherwise. A membership is turned
     on by a code, and codes are made on the admin page — which is a real
     way to sell one (take payment however you already do, then hand over a
     code) rather than a checkout that only looks like it works. */
  if (url === '/store/plans') {
    const v = settings.values;
    json(200, {
      ok: true,
      membership: v.membership,
      free: { cap: v.caps.free, withdraw: v.withdraw.free },
      member: { cap: v.caps.member, withdraw: v.withdraw.member },
      /* What the store should offer. With Stripe set up it is a card and a
         free trial; without it, the code the admin page makes. Both work at
         once, because a code is still how you hand a membership to a friend
         or put right a payment that went wrong. */
      checkout: stripe.ready ? 'card' : 'code',
      card: stripe.ready,
      trialDays: stripe.ready ? stripe.trialDays : 0,
      testMode: stripe.ready ? !stripe.live : false,
      note: stripe.ready
        ? (stripe.trialDays
            ? stripe.trialDays + ' days free, then ' +
              (v.membership.priceCents / 100).toFixed(2) + ' a month. Cancel any time.'
            : 'Cancel any time.')
        : 'Memberships are turned on with a code.'
    });
    return;
  }

  /* Somewhere to go and start the free trial.

     All this does is ask Stripe for a page and hand back its address. No card
     number comes anywhere near this server or the game — Stripe hosts the
     form — and nothing here turns a membership on. That happens when Stripe
     calls the webhook back. */
  if (url === '/store/checkout' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      (async () => {
        let m = {};
        try { m = JSON.parse(body || '{}'); } catch (e) {}
        try {
          const id = accounts.sessionAccount(String(m.session || ''));
          if (!id) {
            json(200, { ok: false, why: 'Sign in first, so the membership has somewhere to go.' });
            return;
          }
          const account = await accounts.find(id);
          if (!account) { json(200, { ok: false, why: 'No such account.' }); return; }
          if (accounts.isMember(account)) {
            json(200, { ok: false, why: 'You are already a member.', member: true });
            return;
          }
          const out = await stripe.checkout(account);
          if (!out.ok) console.log('  stripe: no checkout for ' + id + ' — ' + out.why);
          json(200, out);
        } catch (e) {
          console.log('  /store/checkout failed: ' + (e && e.message));
          json(200, { ok: false, why: 'Could not reach the card machine just then.' });
        }
      })();
    });
    return;
  }

  /* Cancelling, or changing the card. Stripe hosts this too. */
  if (url === '/store/manage' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      (async () => {
        let m = {};
        try { m = JSON.parse(body || '{}'); } catch (e) {}
        try {
          const id = accounts.sessionAccount(String(m.session || ''));
          if (!id) { json(200, { ok: false, why: 'Sign in first.' }); return; }
          const account = await accounts.find(id);
          json(200, await stripe.portal(account));
        } catch (e) {
          json(200, { ok: false, why: 'Could not open the billing page.' });
        }
      })();
    });
    return;
  }

  if (url === '/store/redeem' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      (async () => {
        let m = {};
        try { m = JSON.parse(body || '{}'); } catch (e) {}
        try {
          const id = accounts.sessionAccount(String(m.session || ''));
          if (!id) { json(200, { ok: false, why: 'Sign in first, so the membership has somewhere to go.' }); return; }
          const code = String(m.code || '').trim().toUpperCase().replace(/[\s-]+/g, '');
          const rec = memberCodes.get(code);
          if (!rec) { json(200, { ok: false, why: 'That code is not one of ours.' }); return; }
          if (rec.usedBy) { json(200, { ok: false, why: 'That code has already been used.' }); return; }
          if (rec.expires && Date.now() > rec.expires) {
            json(200, { ok: false, why: 'That code has run out.' }); return;
          }
          const days = rec.days || settings.values.membership.days;
          const out = await accounts.setSubscription(id, true, null, days);
          if (!out.ok) { json(200, out); return; }
          rec.usedBy = id;
          rec.usedAt = Date.now();
          codesDirty = true;
          accountsChanged();          // they are a member now; say so at once
          console.log('  membership on for ' + id + ' (' + days + ' days, code ' + code + ')');
          json(200, {
            ok: true, until: out.until, days,
            cap: settings.capFor('member'),
            account: out.account,
            note: 'Membership on until ' + String(out.until || '').slice(0, 10) + '.'
          });
        } catch (e) {
          json(200, { ok: false, why: 'The server hit a problem: ' + (e && e.message) });
        }
      })();
    });
    return;
  }

  /* ---------------- accounts ---------------- */
  /* Read what was sent, and answer even when it is too much.

     This used to call `req.destroy()` the moment a body went over the
     limit, which does not refuse the request — it cuts the connection
     underneath it. The caller sees "fetch failed", which is the same thing
     it would see if the server were down, so it cannot tell a request it
     should shrink from a server it should wait for. Now the rest is thrown
     away, the connection is left alone, and the answer says what happened. */
  const MOST = 65536;
  const readBody = (cb) => {
    let body = '';
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      body += c;
      if (body.length > MOST) { over = true; body = ''; }
    });
    req.on('end', () => {
      if (over) {
        json(413, { ok: false, why: 'That was too much to send at once. ' +
                                    'Send it in smaller pieces.' });
        return;
      }
      let m = {};
      try { m = JSON.parse(body || '{}'); } catch (e) {}
      cb(m);
    });
  };

  /* Answer, always.

     These used to be `readBody(async m => json(200, await ...))`. If the work
     inside threw — a mistyped Supabase address was enough — the rejected
     promise went nowhere, no reply was ever written, and the page sat waiting
     for an answer that was never coming. That is what "could not reach the
     server" really was: the server, reached, saying nothing.

     Now every one of them ends in a reply, even if the reply is bad news. */
  const answer = (work) => readBody(async (m) => {
    try {
      const out = await work(m);
      json(200, out === undefined ? { ok: true } : out);
    } catch (e) {
      console.log('  ' + url + ' failed: ' + (e && e.message));
      json(500, { ok: false, why: 'The server hit a problem: ' + (e && e.message || 'unknown') });
    }
  });

  if (url === '/account/signup' && req.method === 'POST') {
    answer(async (m) => {
      const out = await accounts.signUp(m);
      if (out && out.ok) accountsChanged();
      return out;
    });
    return;
  }
  if (url === '/account/signin' && req.method === 'POST') {
    answer((m) => accounts.signIn(m));
    return;
  }
  if (url === '/account/forgot' && req.method === 'POST') {
    answer(async (m) => {
      const out = await accounts.beginReset(m.email);
      // the token is not emailed yet: it is handed to the admin page instead
      if (out.token) pendingResets.unshift({ email: String(m.email || '').toLowerCase(), token: out.token, at: Date.now() });
      if (pendingResets.length > 50) pendingResets.length = 50;
      return { ok: true, sent: true };   // the same answer whether or not the email exists
    });
    return;
  }
  if (url === '/account/reset' && req.method === 'POST') {
    answer((m) => accounts.completeReset(m.token, m.password));
    return;
  }
  if (url.startsWith('/account/me')) {
    const t = (req.url.split('session=')[1] || '').split('&')[0];
    (async () => {
      try {
        const id = accounts.sessionAccount(decodeURIComponent(t || ''));
        if (!id) { json(401, { error: 'not signed in' }); return; }
        const a = await accounts.find(id);
        json(200, a ? accounts.publicView(a) : { error: 'gone' });
      } catch (e) {
        console.log('  /account/me failed: ' + (e && e.message));
        json(500, { ok: false, why: 'The server hit a problem.' });
      }
    })();
    return;
  }
  /* The creature index, which belongs to the person rather than to the save
     file they happen to be playing. Only ever adds, so a message that goes
     astray costs nothing — the next one carries the same names again. */
  if (url === '/account/creatures' && req.method === 'POST') {
    answer(async (m) => {
      const id = accounts.sessionAccount(m.session);
      if (!id) return { ok: false, why: 'not signed in' };
      const list = Array.isArray(m.species) ? m.species.slice(0, 400) : [];
      if (!list.length) return { ok: false, why: 'nothing to add' };
      const out = await accounts.meetCreatures(id, list);
      if (out.ok && out.added) accountsChanged();
      return out;
    });
    return;
  }

  if (url === '/account/companions' && req.method === 'POST') {
    answer(async (m) => {
      const id = accounts.sessionAccount(m.session);
      if (!id) return { ok: false, why: 'not signed in' };
      return accounts.setCompanions(id, m.companions);
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
        .map(p => ({ id: p.id, name: p.name, skin: p.skin, x: p.x, y: p.y, z: p.z, yaw: p.yaw,
                     realm: p.realm || 'ground' }))
    }));
    broadcast({ t: 'join', id, name: player.name, skin: player.skin }, id);
    // tell the newcomer who is already here, so voice can be dialled up
    sock.send(JSON.stringify({ t: 'roster', players: Array.from(room.players.keys()).filter(p => p !== id) }));
    for (const [pid, other] of room.players) {
      if (pid !== id && other.avatar) sock.send(JSON.stringify({ t: 'avatar', id: pid, avatar: other.avatar }));
    }
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

    if (m.t === 'avatar') {
      // a compact, checked description of how a player looks: never geometry
      const ok = (v) => typeof v === 'string' && /^[a-z0-9_]{3,40}$/.test(v);
      const hex = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
      const a = m.avatar || {};
      if (!ok(a.presetId)) return;
      const colors = {};
      for (const k of Object.keys(a.colors || {}).slice(0, 16)) if (hex(a.colors[k])) colors[k] = a.colors[k];
      player.avatar = { presetId: a.presetId, colors, options: { glasses: !!(a.options && a.options.glasses) } };
      broadcast({ t: 'avatar', id, avatar: player.avatar }, id);
      return;
    }
    if (m.t === 'move' || m.t === 'm') {
      /* Where somebody is.

         This used to go straight back out as its own message to every other
         player, carrying their name and their whole outfit thirty times a
         second: in a room of eight that was four hundred kilobytes a second
         leaving the server, and the jerking everyone complained about was the
         queue behind it. Now a move is only recorded here, and once every
         fiftieth of a second the room gets ONE message with everybody's
         position in it. Name and outfit are sent when they change, not with
         every step.

         'm' is the packed form: [x, y, z, yaw, anim, riding].              */
      let x, y, z, yaw, anim, riding;
      if (m.t === 'm') {
        const a = m.a;
        if (!Array.isArray(a) || a.length < 4) return;
        x = a[0]; y = a[1]; z = a[2]; yaw = a[3];
        anim = a[4] | 0; riding = a[5] || null;
      } else {
        x = m.x; y = m.y; z = m.z; yaw = m.yaw;
        anim = typeof m.anim === 'number' ? m.anim : 0;
        riding = m.riding || null;
        if (m.realm) player.realm = String(m.realm).slice(0, 32);
      }
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
      player.x = x; player.y = y; player.z = z; player.yaw = Number.isFinite(yaw) ? yaw : 0;
      player.anim = anim & 31;
      player.riding = riding ? String(riding).slice(0, 40) : null;
      player.moved = true;
      room.spots.set(player.name, { x, y, z, yaw: player.yaw });

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

    } else if (m.t === 'life' || m.t === 'herd') {
      /* The wildlife belongs to the host. Passing on anyone else's version
         would put two answers in the room, which is the thing this is for. */
      if (room.host !== id) return;
      if (m.t === 'life') {
        const add = Array.isArray(m.add) ? m.add.slice(0, 220) : [];
        if (add.length) broadcast({ t: 'life', add }, id);
      } else {
        const a = Array.isArray(m.a) ? m.a.slice(0, 120) : [];
        if (a.length) broadcast({ t: 'herd', a }, id);
      }

    } else if (m.t === 'summon') {
      /* Asking somebody to come to you. It is only ever an invitation: their
         own game decides, and they are told who is asking. */
      const dest = room.players.get(String(m.to || ''));
      if (!dest) return;
      dest.socket.send(JSON.stringify({
        t: 'summon', from: id, name: player.name,
        x: +m.x || 0, y: +m.y || 0, z: +m.z || 0,
        realm: String(m.realm || 'ground').slice(0, 32)
      }));

    } else if (m.t === 'summonReply') {
      const asker = room.players.get(String(m.to || ''));
      if (!asker) return;
      asker.socket.send(JSON.stringify({ t: 'summonReply', name: player.name, ok: !!m.ok }));

    } else if (m.t === 'settime' || m.t === 'setweather') {
      // the host sets the sky for everybody
      if (room.host !== id) return;
      if (m.t === 'settime') {
        const t = Number(m.time);
        if (!Number.isFinite(t)) return;
        room.time = ((t % 1) + 1) % 1;
        const msg = JSON.stringify({ t: 'time', time: room.time, weather: room.weather || 'clear' });
        for (const p of room.players.values()) p.socket.send(msg);
      } else {
        const kinds = ['clear', 'cloudy', 'rain', 'snow'];
        if (kinds.indexOf(m.weather) < 0) return;
        room.weather = m.weather;
        room.weatherIn = 120 + Math.random() * 180;
        const msg = JSON.stringify({ t: 'weather', weather: room.weather });
        for (const p of room.players.values()) p.socket.send(msg);
      }

    } else if (m.t === 'mode') {
      /* The host decides how the room plays. Everyone follows, so one player
         cannot be flying about in creative while the others are mining. */
      if (room.host !== id) return;
      room.mode = m.mode === 'creative' ? 'creative' : 'survival';
      room.dirty = true;
      const msg = JSON.stringify({ t: 'mode', mode: room.mode });
      for (const p of room.players.values()) p.socket.send(msg);

    } else if (m.t === 'drop') {
      // something put on the ground where everyone can see it
      if (!Number.isFinite(+m.x) || !Number.isFinite(+m.y) || !Number.isFinite(+m.z)) return;
      broadcast({ t: 'drop', id, b: m.b | 0, x: +m.x, y: +m.y, z: +m.z }, id);

    } else if (m.t === 'bust') {
      // which block somebody is part way through breaking
      if (!Number.isFinite(+m.x) || !Number.isFinite(+m.y) || !Number.isFinite(+m.z)) return;
      broadcast({ t: 'bust', id, x: m.x | 0, y: m.y | 0, z: m.z | 0,
                  p: Math.max(0, Math.min(1, +m.p || 0)) }, id);

    } else if (m.t === 'look') {
      /* What somebody is wearing. Sent when it changes rather than with every
         step, which is what made every movement packet six times its size. */
      const raw = m.skin && typeof m.skin === 'object' ? m.skin : null;
      if (!raw) return;
      const hex = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
      const skin = {};
      for (const k of ['head', 'torso', 'arms', 'legs', 'hair', 'accent']) if (hex(raw[k])) skin[k] = raw[k];
      if (typeof raw.name === 'string') skin.name = raw.name.replace(/[<>&"']/g, '').slice(0, 24);
      if (typeof raw.body === 'string') skin.body = raw.body.slice(0, 12);
      for (const k of ['goggles', 'scuba', 'jetpack']) skin[k] = !!raw[k];
      player.skin = skin;
      if (skin.name) player.name = skin.name;
      broadcast({ t: 'look', id, skin }, id);

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
      // the craft has left the ground with them, so nobody is still in a seat:
      // leaving them recorded as riders kept their bodies hidden on arrival
      for (const v of room.vehicles.values()) {
        const before = v.riders.length;
        v.riders = v.riders.filter(r => crew.indexOf(r) < 0);
        if (v.driver && crew.indexOf(v.driver) >= 0) v.driver = v.riders[0] || null;
        if (v.riders.length !== before) {
          broadcast({ t: 'seat', id: v.id, ok: true, who: null, left: true,
                      driver: v.driver, riders: v.riders });
        }
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
