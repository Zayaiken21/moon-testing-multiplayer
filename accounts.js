/**
 * accounts.js — real accounts, kept in Supabase, sharded so they can grow.
 *
 * What lives where, and why:
 *
 *   · Supabase holds the account rows: email, username, password hash,
 *     balance, companion count, subscription. It is the live copy and it is
 *     what scales.
 *   · GitHub holds a periodic snapshot, so a Supabase outage or a wrong
 *     migration is survivable.
 *   · The browser holds nothing that decides money. It asks; the server
 *     answers. The anon key in the page can only read what row level security
 *     lets it read, and it can never write a balance.
 *
 * Sharding: give it several Supabase projects and accounts are spread across
 * them by a hash of the account id, so one project's row limit is not the
 * ceiling. Adding a shard only affects accounts created after it is added,
 * which is why the shard index is stored on the row itself.
 *
 *   SUPABASE_URLS=https://a.supabase.co,https://b.supabase.co
 *   SUPABASE_SERVICE_KEYS=key-for-a,key-for-b
 */
'use strict';

const https = require('https');
const http = require('http');
const crypto = require('crypto');

/* ---------------------------------------------------------------- earnings */

const CENTS_PER_CREATURE = 1;
const FREE_DAILY_CAP = 5;         // five cents a day without a subscription
const MEMBER_DAILY_CAP = 25;      // twenty five with one

/* ------------------------------------------------------------------ crypto */

/** scrypt, with a per-account salt. Slow on purpose. */
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return s + ':' + hash;
}

function checkPassword(password, stored) {
  if (!stored || stored.indexOf(':') < 0) return false;
  const [salt, want] = stored.split(':');
  const got = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  // constant time, so a wrong guess cannot be timed
  const a = Buffer.from(got, 'hex'), b = Buffer.from(want, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const token = () => crypto.randomBytes(24).toString('hex');
const normalEmail = (e) => String(e || '').trim().toLowerCase();

/* ----------------------------------------------------------------- the API */

class Accounts {
  constructor(opts = {}) {
    const urls = (opts.urls || process.env.SUPABASE_URLS || process.env.SUPABASE_URL || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const keys = (opts.keys || process.env.SUPABASE_SERVICE_KEYS || process.env.SUPABASE_SERVICE_KEY || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    this.shards = urls.map((url, i) => ({ url, key: keys[i] || keys[0] || '' }));
    this.table = opts.table || 'accounts';
    this.log = opts.log || (() => {});
    this.enabled = this.shards.length > 0 && !!this.shards[0].key;
    this.memory = new Map();        // the fallback when Supabase is not configured
    this.resets = new Map();        // reset token -> { email, at }
    this.sessions = new Map();      // session token -> { id, at }
  }

  /** Which project an account lives in. Stored on the row so it never moves. */
  shardFor(id) {
    if (!this.shards.length) return 0;
    const h = crypto.createHash('sha1').update(String(id)).digest();
    return h.readUInt32BE(0) % this.shards.length;
  }

  _call(shard, method, route, body, extraHeaders) {
    return new Promise((resolve) => {
      const s = this.shards[shard];
      if (!s) return resolve({ status: 0, body: null });
      const u = new URL(s.url + '/rest/v1/' + route);
      const payload = body ? JSON.stringify(body) : null;
      const mod = u.protocol === 'http:' ? http : https;
      const req = mod.request({
        host: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method,
        headers: Object.assign({
          apikey: s.key,
          authorization: 'Bearer ' + s.key,
          'content-type': 'application/json',
          prefer: 'return=representation'
        }, payload ? { 'content-length': Buffer.byteLength(payload) } : {}, extraHeaders || {})
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data || 'null'); } catch (e) {}
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', () => resolve({ status: 0, body: null }));
      req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, body: null }); });
      if (payload) req.write(payload);
      req.end();
    });
  }

  /* ---------------- reading and writing one account ---------------- */

  async find(idOrEmail) {
    const key = normalEmail(idOrEmail);
    if (!this.enabled) {
      for (const a of this.memory.values()) {
        if (a.id === idOrEmail || a.email === key || a.username === key) return a;
      }
      return null;
    }
    // an account could be in any shard, so ask the one its id points to first
    const order = [this.shardFor(idOrEmail)];
    for (let i = 0; i < this.shards.length; i++) if (order.indexOf(i) < 0) order.push(i);
    for (const shard of order) {
      const q = 'or=(id.eq.' + encodeURIComponent(idOrEmail) +
                ',email.eq.' + encodeURIComponent(key) +
                ',username.eq.' + encodeURIComponent(key) + ')&limit=1';
      const res = await this._call(shard, 'GET', this.table + '?' + q);
      if (res.status === 200 && Array.isArray(res.body) && res.body.length) {
        return Object.assign({ shard }, res.body[0]);
      }
    }
    return null;
  }

  async put(account) {
    account.updated_at = new Date().toISOString();
    if (!this.enabled) { this.memory.set(account.id, account); return account; }
    const shard = account.shard === undefined ? this.shardFor(account.id) : account.shard;
    const row = Object.assign({}, account);
    delete row.shard;
    const res = await this._call(shard, 'POST', this.table,
      [row], { prefer: 'resolution=merge-duplicates,return=representation' });
    if (res.status >= 200 && res.status < 300) return account;
    this.log('could not save ' + account.id + ' to shard ' + shard + ' (status ' + res.status + ')');
    this.memory.set(account.id, account);       // never lose it outright
    return account;
  }

  /* --------------------------- signing up --------------------------- */

  async signUp({ email, username, password }) {
    const mail = normalEmail(email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return { ok: false, why: 'That email does not look right.' };
    if (!username || String(username).trim().length < 3) return { ok: false, why: 'Pick a username of at least three letters.' };
    if (!password || String(password).length < 8) return { ok: false, why: 'Use a password of at least eight characters.' };

    const taken = await this.find(mail) || await this.find(String(username).trim().toLowerCase());
    if (taken) return { ok: false, why: 'That email or username is already in use.' };

    const id = 'acc_' + crypto.randomBytes(8).toString('hex');
    const account = {
      id,
      email: mail,
      username: String(username).trim(),
      password: hashPassword(password),
      balance: 0,
      caught: 0,
      today: 0,
      today_key: '',
      subscribed: false,
      subscription_until: null,
      companions: [],
      role: 'player',
      created_at: new Date().toISOString(),
      shard: this.shardFor(id)
    };
    await this.put(account);
    return { ok: true, account: this.publicView(account), session: this.startSession(id) };
  }

  async signIn({ email, password }) {
    const account = await this.find(normalEmail(email));
    if (!account || !checkPassword(password, account.password)) {
      // the same answer either way, so nobody can fish for valid emails
      return { ok: false, why: 'That email and password do not match.' };
    }
    return { ok: true, account: this.publicView(account), session: this.startSession(account.id) };
  }

  startSession(id) {
    const t = token();
    this.sessions.set(t, { id, at: Date.now() });
    return t;
  }

  sessionAccount(t) {
    const s = this.sessions.get(t);
    if (!s) return null;
    if (Date.now() - s.at > 30 * 24 * 3600 * 1000) { this.sessions.delete(t); return null; }
    return s.id;
  }

  /* ------------------------ forgetting a password ------------------------ */

  /** Makes a reset token. Nothing is emailed yet; the admin page shows it. */
  async beginReset(email) {
    const account = await this.find(normalEmail(email));
    const t = token();
    // a token is made either way, so nobody learns whether an email exists
    if (account) this.resets.set(t, { email: account.email, at: Date.now() });
    return { ok: true, token: account ? t : null, sent: !!account };
  }

  async completeReset(t, password) {
    const rec = this.resets.get(t);
    if (!rec) return { ok: false, why: 'That reset link is not valid.' };
    if (Date.now() - rec.at > 3600 * 1000) { this.resets.delete(t); return { ok: false, why: 'That reset link has expired.' }; }
    if (!password || String(password).length < 8) return { ok: false, why: 'Use a password of at least eight characters.' };
    const account = await this.find(rec.email);
    if (!account) return { ok: false, why: 'That account no longer exists.' };
    account.password = hashPassword(password);
    await this.put(account);
    this.resets.delete(t);
    // every existing session is dropped, in case somebody else had one
    for (const [k, v] of this.sessions) if (v.id === account.id) this.sessions.delete(k);
    return { ok: true, session: this.startSession(account.id) };
  }

  /* ----------------------------- earnings ----------------------------- */

  dailyCap(account) {
    const live = account.subscribed &&
      (!account.subscription_until || new Date(account.subscription_until) > new Date());
    return live ? MEMBER_DAILY_CAP : FREE_DAILY_CAP;
  }

  /** One creature, one cent, inside today's ceiling. */
  async credit(accountId, creatureKey, claimedAlready) {
    const account = await this.find(accountId);
    if (!account) return { ok: false, why: 'No such account.' };
    if (claimedAlready) return { ok: false, why: 'Someone else caught this one first.', balance: account.balance };

    const day = new Date().toISOString().slice(0, 10);
    if (account.today_key !== day) { account.today_key = day; account.today = 0; }

    const cap = this.dailyCap(account);
    if (account.today + CENTS_PER_CREATURE > cap) {
      return {
        ok: false,
        why: cap === FREE_DAILY_CAP
          ? 'You have reached today\u2019s five cents. A membership raises it to twenty five.'
          : 'You have reached today\u2019s twenty five cents.',
        balance: account.balance, today: account.today, cap
      };
    }
    account.today += CENTS_PER_CREATURE;
    account.balance += CENTS_PER_CREATURE;
    account.caught = (account.caught || 0) + 1;
    await this.put(account);
    return { ok: true, cents: CENTS_PER_CREATURE, balance: account.balance, today: account.today, cap };
  }

  async setSubscription(accountId, on, until) {
    const account = await this.find(accountId);
    if (!account) return { ok: false, why: 'No such account.' };
    account.subscribed = !!on;
    account.subscription_until = on ? (until || null) : null;
    await this.put(account);
    return { ok: true, account: this.publicView(account) };
  }

  async setCompanions(accountId, companions) {
    const account = await this.find(accountId);
    if (!account) return { ok: false, why: 'No such account.' };
    account.companions = (companions || []).slice(0, 500);
    await this.put(account);
    return { ok: true, kept: account.companions.length };
  }

  async remove(accountId) {
    const account = await this.find(accountId);
    if (!account) return { ok: false, why: 'No such account.' };
    if (!this.enabled) { this.memory.delete(account.id); return { ok: true }; }
    const res = await this._call(account.shard, 'DELETE',
      this.table + '?id=eq.' + encodeURIComponent(account.id));
    for (const [k, v] of this.sessions) if (v.id === account.id) this.sessions.delete(k);
    return { ok: res.status >= 200 && res.status < 300 };
  }

  async list(limit) {
    if (!this.enabled) return Array.from(this.memory.values()).map(a => this.publicView(a));
    const out = [];
    for (let i = 0; i < this.shards.length; i++) {
      const res = await this._call(i, 'GET',
        this.table + '?select=id,email,username,balance,caught,subscribed,role,created_at' +
        '&order=balance.desc&limit=' + (limit || 50));
      if (res.status === 200 && Array.isArray(res.body)) out.push(...res.body);
    }
    return out.sort((a, b) => (b.balance || 0) - (a.balance || 0)).slice(0, limit || 50);
  }

  /** What is safe to hand back to a browser. */
  publicView(a) {
    return {
      id: a.id, email: a.email, username: a.username,
      balance: a.balance || 0, caught: a.caught || 0,
      today: a.today || 0, cap: this.dailyCap(a),
      subscribed: !!a.subscribed, subscription_until: a.subscription_until || null,
      companions: (a.companions || []).length, role: a.role || 'player'
    };
  }

  /** The snapshot GitHub keeps, so Supabase is never the only copy. */
  async snapshot() {
    const rows = await this.list(5000);
    return { at: new Date().toISOString(), shards: this.shards.length, accounts: rows };
  }
}

module.exports = {
  Accounts, hashPassword, checkPassword,
  CENTS_PER_CREATURE, FREE_DAILY_CAP, MEMBER_DAILY_CAP
};
