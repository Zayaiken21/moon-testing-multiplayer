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

/* What each kind of animal is worth, in cents.

   Common pays nothing on purpose: roughly four creatures in five are common,
   so an ordinary animal is company rather than wages, and the money is
   something to go looking for. Only the first account anywhere to tame a
   particular animal is paid for it. */
const RARITY_CENTS = { common: 0, uncommon: 2, rare: 6, exotic: 12, legendary: 30 };
const CENTS_PER_CREATURE = 1;          // kept for anything still asking
/* How much an account may earn in a day.

   These have to sit above what a single animal is worth or the ceiling
   refuses the very thing it is meant to allow: at five cents a day, taming
   one rare animal (six) was turned down every time, so a free player could
   never be paid for anything above uncommon at all. Thirty lets a free
   player have a good day — a legendary, or five rare ones — and a
   membership raises it fivefold.

   Change these two numbers to change what the game costs you. Nothing else
   needs touching: the wallet shows whatever they say. */
const FREE_DAILY_CAP = 30;        // thirty cents a day without a subscription
const MEMBER_DAILY_CAP = 150;     // a dollar fifty with one

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

/* The columns the accounts table has. Only these are ever sent.

   Anything here that the table does not have makes PostgREST refuse the whole
   row with a 400, so this list is deliberately the smallest one that works,
   and matches schema.sql exactly. If a column is ever added here, add it to
   schema.sql in the same change. */
const ACCOUNT_COLUMNS = [
  'id', 'email', 'username', 'password', 'balance', 'caught', 'today', 'today_key',
  'subscribed', 'subscription_until', 'companions', 'role', 'created_at',
  'last_seen', 'shard',
  /* what has already been taken out, so the per-day and per-month
     withdrawal ceilings survive a restart */
  'payout_today', 'payout_day_key', 'payout_month', 'payout_month_key',
  /* who this person is to Stripe, so a membership can be matched back to
     them when Stripe tells us something about it later */
  'stripe_customer', 'stripe_subscription', 'trial_used'
];
const normalEmail = (e) => String(e || '').trim().toLowerCase();

/* ----------------------------------------------------------------- the API */

class Accounts {
  static COLUMNS = ACCOUNT_COLUMNS;

  constructor(opts = {}) {
    const urls = (opts.urls || process.env.SUPABASE_URLS || process.env.SUPABASE_URL || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const keys = (opts.keys || process.env.SUPABASE_SERVICE_KEYS || process.env.SUPABASE_SERVICE_KEY || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    /* Tidy each address up rather than trusting it.

       "oxmjxuuymplhnbcdltho.supabase.co" pasted without https:// in front of
       it is an easy thing to type into Render, and it used to make new URL()
       throw deep inside a request — which surfaced as a page that waited for
       ever for an answer that was never coming. */
    /* Clean both, rather than trusting either.

       Two things go wrong when these are pasted into a hosting panel, and
       both of them used to break every account request:

       • an address without https:// in front made new URL() throw;
       • a key that picked up a line break on the way in made Node refuse to
         put it in a header at all — "Invalid character in header content".

       A Supabase key is a JWT: three dot-separated runs of plain characters
       with no spaces anywhere in it. So every scrap of whitespace can be
       taken out with no risk of damaging a good key, and a key that arrived
       wrapped across two lines simply works. */
    const tidyKey = (k) => String(k || '').replace(/\s+/g, '');
    this.shards = urls.map((url, i) => ({
      url: String(url).replace(/\s+/g, '').replace(/\/+$/, '').replace(/^(?!https?:\/\/)/, 'https://'),
      key: tidyKey(keys[i] || keys[0] || '')
    }));
    this.table = opts.table || 'accounts';
    this.log = opts.log || (() => {});
    /* Where the money numbers come from. Given one, every rate and ceiling
       is read from it live, so the admin page changes them without a deploy.
       Without one, the constants at the top of this file are used, which is
       what keeps this module usable on its own in a test. */
    this.settings = opts.settings || null;
    this.enabled = this.shards.length > 0 && !!this.shards[0].key;

    /* Say plainly, once, at boot, whether this is going to work. Finding out
       from a child's sign-in screen is not the way to learn that a key was
       pasted wrong. */
    this.shards.forEach((sh, i) => {
      if (!sh.key) { this.log('shard ' + i + ' (' + sh.url + ') has no service key'); return; }
      const looksJwt = /^[\w-]+\.[\w-]+\.[\w-]+$/.test(sh.key);
      let role = '';
      try {
        const body = JSON.parse(Buffer.from(sh.key.split('.')[1], 'base64').toString('utf8'));
        role = body && body.role || '';
      } catch (e) {}
      if (!looksJwt) {
        this.log('shard ' + i + ': that key does not look like a Supabase key. ' +
                 'Copy the service_role key from Settings → API Keys.');
      } else if (role === 'anon') {
        this.log('shard ' + i + ': that is the ANON key, which can do nothing here. ' +
                 'Use the service_role key instead.');
      } else {
        this.log('shard ' + i + ' ready: ' + sh.url + (role ? ' (' + role + ')' : ''));
      }
    });
    this.memory = new Map();        // the fallback when Supabase is not configured
    this.resets = new Map();        // reset token -> { email, at }
    this.sessions = new Map();      // session token -> { id, at }
  }

  /* A way in for anything else that needs the database.

     Analytics are kept here too, because a count on Render's own disk does
     not survive a redeploy and quietly goes back to zero. These two are the
     whole of that: put rows in, read a view back out. */
  async insert(table, rows) {
    if (!this.enabled || !rows || !rows.length) return { ok: false };
    const res = await this._call(0, 'POST', table, rows, { prefer: 'return=minimal' });
    if (res.status >= 200 && res.status < 300) return { ok: true };
    const said = res.body && (res.body.message || res.body.details);
    this.log('could not write to ' + table + ': ' + res.status + (said ? ' ' + said : ''));
    return { ok: false, status: res.status, why: said };
  }

  async read(route) {
    if (!this.enabled) return null;
    const res = await this._call(0, 'GET', route);
    return res.status === 200 ? res.body : null;
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
      let u;
      try {
        u = new URL(s.url + '/rest/v1/' + route);
      } catch (e) {
        // a bad address is a configuration problem, not a reason to go silent
        this.log('SUPABASE_URLS does not look like an address: ' + s.url);
        return resolve({ status: 0, body: null, why: 'bad supabase url' });
      }
      const payload = body ? JSON.stringify(body) : null;
      const mod = u.protocol === 'http:' ? http : https;
      let req;
      try {
        req = mod.request({
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
      } catch (e) {
        // a header the runtime will not accept, most often a key with a line
        // break in it: say so, and answer, rather than throwing into the void
        this.log('could not build the request: ' + (e && e.message));
        return resolve({ status: 0, body: null, why: e && e.message });
      }
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
    account.last_seen = new Date().toISOString();
    if (!this.enabled) { this.memory.set(account.id, account); return account; }
    const shard = account.shard === undefined ? this.shardFor(account.id) : account.shard;

    /* Send the columns the table has, and nothing else.

       A row was built by copying the whole account object, so anything the
       code happened to hang on it went to the database too — a note about
       whether the last save worked, a timestamp the table did not have — and
       PostgREST refuses the lot with a 400 the moment one name is unknown.
       Listing the columns means a field added in the code can never again
       stop people signing up. */
    const row = {};
    for (const col of Accounts.COLUMNS) {
      if (account[col] !== undefined) row[col] = account[col];
    }

    const res = await this._call(shard, 'POST', this.table,
      [row], { prefer: 'resolution=merge-duplicates,return=representation' });
    if (res.status >= 200 && res.status < 300) { account.saved = true; return account; }
    /* It did not save. Keep it in memory so nothing is lost outright, but
       say so: a caller that tells somebody "welcome, your account is made"
       when it is not has done them real harm — they will come back tomorrow
       and find no account at all. */
    /* Whatever the database said, say it. A bare "answered 400" is not
       something anybody can act on; "column accounts.updated_at does not
       exist" is fixed in a minute. */
    const said = res.body && (res.body.message || res.body.hint || res.body.details);
    const why = res.status === 401 || res.status === 403
      ? 'the service key was refused (' + res.status + ')'
      : res.status === 0 ? 'the database could not be reached'
      : res.status === 404 ? 'there is no accounts table — run schema.sql in Supabase'
      : 'the database answered ' + res.status + (said ? ': ' + said : '');
    this.log('could not save ' + account.id + ' to shard ' + shard + ': ' + why);
    this.memory.set(account.id, account);
    account.saved = false;
    account.whyNotSaved = why;
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
    /* Only say the account exists if it really does. Told "welcome" over an
       account that was never written, somebody comes back tomorrow to find
       nothing there and no idea why. */
    if (this.enabled && account.saved === false) {
      return { ok: false,
               why: 'Your account could not be saved — ' + (account.whyNotSaved || 'the database refused it') +
                    '. Nothing was lost; try again in a minute.' };
    }
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

  /** Is this membership live right now? An expired one is not. */
  isMember(account) {
    return !!(account && account.subscribed &&
      (!account.subscription_until || new Date(account.subscription_until) > new Date()));
  }

  tier(account) { return this.isMember(account) ? 'member' : 'free'; }

  dailyCap(account) {
    if (this.settings) return this.settings.capFor(this.tier(account));
    return this.isMember(account) ? MEMBER_DAILY_CAP : FREE_DAILY_CAP;
  }

  worthOf(rarity) {
    if (this.settings) return this.settings.worth(rarity);
    const c = RARITY_CENTS[String(rarity || 'common')];
    return c === undefined ? 0 : c;
  }

  /**
   * Pay an account for taming one animal.
   *
   * Two things in here were wrong for a long time and are worth spelling out,
   * because between them they meant a player could be told they had been paid
   * and have nothing to show for it.
   *
   * 1. **A refusal has to reach the caller.** This function has always
   *    returned `ok: false` when it would not pay — but /claim used to answer
   *    the browser `ok: true` regardless, using a figure from its own
   *    in-memory ledger. The player saw "Caught! $0.06 added" and their real
   *    account never moved. That is fixed in server.js; this end simply has
   *    to be trusted, so it now never returns ok unless money genuinely
   *    landed in the database.
   *
   * 2. **A save that failed is not a payment.** The balance used to be
   *    raised, `put` allowed to fail quietly, and success returned anyway.
   *    Now the account is put back exactly as it was and the caller is told
   *    the truth, so the animal can be claimed again once the database is
   *    healthy rather than being burned for ever.
   *
   * And the ceiling now tops you up rather than turning you away: if you have
   * four cents of room left and tame a thirty cent legendary, you are paid
   * the four. You reach your limit exactly once a day instead of stopping
   * somewhere short of it because nothing fits in the gap.
   */
  async credit(accountId, creatureKey, claimedAlready, rarity) {
    const account = await this.find(accountId);
    if (!account) return { ok: false, why: 'No such account.', code: 'no-account' };
    if (claimedAlready) {
      return { ok: false, why: 'Someone else caught this one first.',
               code: 'taken', balance: account.balance };
    }

    if (this.settings && this.settings.values.earningPaused) {
      return { ok: false, why: 'Earning is paused just now. Your animal is still yours.',
               code: 'paused', balance: account.balance };
    }

    const full = this.worthOf(rarity);
    if (full <= 0) {
      return { ok: false, why: 'A common animal. Lovely, but it pays nothing.',
               code: 'common', cents: 0, balance: account.balance };
    }

    const day = new Date().toISOString().slice(0, 10);
    if (account.today_key !== day) { account.today_key = day; account.today = 0; }

    const cap = this.dailyCap(account);
    const room = Math.max(0, cap - (account.today || 0));
    const topUp = !this.settings || this.settings.values.partialCredit !== false;

    if (room <= 0) {
      return {
        ok: false,
        why: this.tier(account) === 'free'
          ? 'That is all for today. A membership raises the daily limit.'
          : 'That is all for today. It starts again tomorrow.',
        code: 'capped',
        balance: account.balance, today: account.today, cap, worth: full
      };
    }
    /* The whole animal if it fits, otherwise whatever room is left — which
       is what puts you exactly on your limit rather than leaving you short
       of it holding an animal too valuable to fit. */
    const cents = topUp ? Math.min(full, room) : (full <= room ? full : 0);
    if (cents <= 0) {
      return {
        ok: false,
        why: 'Only ' + room + 'c left today, and this one is worth ' + full + 'c.',
        code: 'capped', balance: account.balance, today: account.today, cap, worth: full
      };
    }

    /* Keep what to put back, in case the database will not take the change. */
    const before = {
      balance: account.balance, today: account.today,
      caught: account.caught, today_key: account.today_key
    };
    account.today = (account.today || 0) + cents;
    account.balance = (account.balance || 0) + cents;
    account.caught = (account.caught || 0) + 1;

    await this.put(account);

    if (this.enabled && account.saved === false) {
      // it did not reach the database, so it did not happen
      account.balance = before.balance;
      account.today = before.today;
      account.caught = before.caught;
      account.today_key = before.today_key;
      return {
        ok: false, code: 'not-saved',
        why: 'Your wallet could not be reached just then — nothing was taken, ' +
             'and this animal can still be claimed.',
        detail: account.whyNotSaved || '', balance: before.balance
      };
    }

    return {
      ok: true, cents, worth: full,
      short: cents < full,                 // paid less than it was worth: the cap
      balance: account.balance, caught: account.caught,
      today: account.today, cap, tier: this.tier(account)
    };
  }

  /* ---------------------------- withdrawals --------------------------- */

  /**
   * What this account may take out right now, and why not if it may not.
   *
   * Every limit is per tier and lives in settings, so the whole shape of it
   * is changed from the admin page rather than from here.
   */
  async withdrawable(accountId) {
    const account = await this.find(accountId);
    if (!account) return { ok: false, why: 'No such account.' };
    return this.withdrawableFor(account);
  }

  withdrawableFor(account) {
    const tier = this.tier(account);
    const rules = this.settings
      ? this.settings.withdrawFor(tier)
      : { min: 500, maxPerRequest: 2000, maxPerDay: 2000, maxPerMonth: 5000 };
    const paused = !!(this.settings && this.settings.values.payoutsPaused);

    const day = new Date().toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const takenToday = (account.payout_day_key === day) ? (account.payout_today || 0) : 0;
    const takenMonth = (account.payout_month_key === month) ? (account.payout_month || 0) : 0;

    const balance = account.balance || 0;
    const most = Math.min(
      balance,
      rules.maxPerRequest,
      Math.max(0, rules.maxPerDay - takenToday),
      Math.max(0, rules.maxPerMonth - takenMonth)
    );

    let why = '';
    if (paused) why = 'Withdrawals are paused just now.';
    else if (balance < rules.min) why = 'Withdrawals open at ' + rules.min + 'c. You have ' + balance + 'c.';
    else if (rules.maxPerDay - takenToday <= 0) why = 'That is all you may take out today.';
    else if (rules.maxPerMonth - takenMonth <= 0) why = 'That is all you may take out this month.';
    else if (most < rules.min) why = 'What is left of your limit is below the ' + rules.min + 'c minimum.';

    return {
      ok: !why, why, tier, rules, balance,
      min: rules.min, most: Math.max(0, most),
      takenToday, takenMonth, paused
    };
  }

  /**
   * Record a withdrawal request. The money leaves the balance here, so it
   * cannot be requested twice while somebody is deciding whether to send it.
   * Nothing in this file talks to a payment company: a request is a request.
   */
  async requestPayout(accountId, cents, method, destination) {
    const account = await this.find(accountId);
    if (!account) return { ok: false, why: 'No such account.' };

    const want = Math.round(Number(cents) || 0);
    const room = this.withdrawableFor(account);
    if (!room.ok) return { ok: false, why: room.why, room };
    if (want < room.min) return { ok: false, why: 'The smallest withdrawal is ' + room.min + 'c.', room };
    if (want > room.most) return { ok: false, why: 'The most you may take out right now is ' + room.most + 'c.', room };

    const day = new Date().toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    if (account.payout_day_key !== day) { account.payout_day_key = day; account.payout_today = 0; }
    if (account.payout_month_key !== month) { account.payout_month_key = month; account.payout_month = 0; }

    const before = { balance: account.balance, today: account.payout_today, month: account.payout_month };
    account.balance -= want;
    account.payout_today = (account.payout_today || 0) + want;
    account.payout_month = (account.payout_month || 0) + want;

    await this.put(account);
    if (this.enabled && account.saved === false) {
      account.balance = before.balance;
      account.payout_today = before.today;
      account.payout_month = before.month;
      return { ok: false, why: 'Your wallet could not be reached just then. Nothing was taken.' };
    }

    const row = {
      id: 'pay_' + token().slice(0, 16),
      account_id: account.id,
      username: account.username || '',
      email: account.email || '',
      cents: want,
      method: String(method || 'unsaid').slice(0, 40),
      destination: String(destination || '').slice(0, 200),
      status: 'requested',
      requested_at: new Date().toISOString()
    };
    /* The database gives payouts a number of its own, so our id goes in `ref`
       rather than in `id` — sending a text id to a bigserial column makes
       PostgREST refuse the whole row. The list the admin page works from is
       kept by the server either way, so a database that will not take this
       row does not lose the request. */
    try {
      await this.insert('payouts', [{
        account_id: row.account_id, username: row.username, email: row.email,
        cents: row.cents, method: row.method, destination: row.destination,
        status: row.status, requested_at: row.requested_at, ref: row.id
      }]);
    } catch (e) {
      this.log('payout row not written to the database: ' + (e && e.message));
    }

    return { ok: true, payout: row, balance: account.balance,
             took: want, left: this.withdrawableFor(account) };
  }

  /**
   * Turn a membership on or off.
   *
   * Given `days`, the time is added to whatever is left rather than replacing
   * it, so renewing a month early gives you thirteen months rather than
   * throwing away the one you paid for.
   */
  async setSubscription(accountId, on, until, days) {
    const account = await this.find(accountId);
    if (!account) return { ok: false, why: 'No such account.' };

    if (on && days) {
      const now = Date.now();
      const standing = account.subscription_until
        ? new Date(account.subscription_until).getTime() : 0;
      const from = (this.isMember(account) && standing > now) ? standing : now;
      until = new Date(from + Number(days) * 86400000).toISOString();
    }

    account.subscribed = !!on;
    account.subscription_until = on ? (until || null) : null;
    await this.put(account);
    if (this.enabled && account.saved === false) {
      return { ok: false, why: 'Could not save that — ' + (account.whyNotSaved || 'the database refused it') };
    }
    return { ok: true, account: this.publicView(account), until: account.subscription_until };
  }

  /**
   * Add creatures to this account's index.
   *
   * The index used to live in the save file, so it started again from
   * nothing with every new world and was lost outright on a new phone —
   * which makes a thing you are meant to fill in over months rather
   * pointless. It belongs to the account.
   *
   * Only ever adds. A creature met once is met for good, so there is no
   * ordering problem between two devices and nothing to lose if a message
   * goes astray: the next one carries the same names again.
   */
  async meetCreatures(accountId, species) {
    const account = await this.find(accountId);
    if (!account) return { ok: false, why: 'No such account.' };

    const had = Array.isArray(account.creatures) ? account.creatures : [];
    const all = new Set(had);
    const before = all.size;
    for (const k of (species || [])) {
      const name = String(k || '').slice(0, 60);
      if (name) all.add(name);
      if (all.size > 5000) break;          // a roster of 999: this is plenty
    }
    if (all.size === before) {
      return { ok: true, count: before, added: 0, creatures: had };
    }

    account.creatures = Array.from(all);
    await this.put(account);
    if (this.enabled && account.saved === false) {
      return { ok: false, why: account.whyNotSaved || 'could not be saved', count: before };
    }
    return { ok: true, count: all.size, added: all.size - before, creatures: account.creatures };
  }

  /** Point every rate and ceiling at a live settings object. */
  setSettings(s) { this.settings = s; return this; }

  /* ----------------------------- Stripe ------------------------------- */

  /**
   * Which account is this Stripe customer?
   *
   * Most subscription events carry the account id in their metadata, because
   * it is put there when the checkout is made. But an event can arrive
   * without it — one made by hand in the Stripe dashboard, for instance —
   * and then the customer id is the only thread back to the person. Without
   * this, a membership cancelled from the dashboard would never switch off
   * in the game.
   */
  async findByCustomer(customerId) {
    const want = String(customerId || '');
    if (!want) return null;
    if (!this.enabled) {
      for (const a of this.memory.values()) if (a.stripe_customer === want) return a;
      return null;
    }
    for (let shard = 0; shard < this.shards.length; shard++) {
      const res = await this._call(shard, 'GET',
        this.table + '?stripe_customer=eq.' + encodeURIComponent(want) + '&limit=1');
      if (res.status === 200 && Array.isArray(res.body) && res.body.length) {
        return Object.assign({ shard }, res.body[0]);
      }
    }
    return null;
  }

  /**
   * What Stripe just told us about somebody's membership.
   *
   * This is the only thing that turns a membership on, and it is only ever
   * called from a webhook whose signature has been checked. Nothing a
   * browser sends can reach it.
   */
  async applyStripe(accountId, note) {
    const account = await this.find(accountId);
    if (!account) return { ok: false, why: 'No such account.' };

    if (note.customer) account.stripe_customer = note.customer;
    if (note.subscription) account.stripe_subscription = note.subscription;
    if (note.trialing) account.trial_used = true;

    if (note.member !== undefined) {
      account.subscribed = !!note.member;
      /* Stripe knows when this runs out, so that date is used rather than one
         worked out here. A membership that is ending at the end of the month
         stays on until then, which is what somebody who cancelled expects.

         During a free trial there is no billing period yet, so the only date
         Stripe gives is when the trial ends. Taking `until` alone left a
         trialing account with no end date at all — and no end date means a
         membership that never expires, so a cancellation webhook that went
         astray would have left somebody a member for good. The trial's own
         end is the right answer while the trial is running. */
      const ends = note.until || note.trialEnds || null;
      account.subscription_until = note.member ? ends : null;
    }

    await this.put(account);
    if (this.enabled && account.saved === false) {
      return { ok: false, why: account.whyNotSaved || 'could not be saved' };
    }
    return { ok: true, account: this.publicView(account), member: this.isMember(account) };
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
      member: this.isMember(a), tier: this.tier(a),
      companions: (a.companions || []).length, role: a.role || 'player',
      /* the index, and how far through it they are */
      creatures: Array.isArray(a.creatures) ? a.creatures : [],
      creaturesMet: Array.isArray(a.creatures) ? a.creatures.length : 0,
      withdraw: this.withdrawableFor(a)
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
  CENTS_PER_CREATURE, RARITY_CENTS, FREE_DAILY_CAP, MEMBER_DAILY_CAP
};
