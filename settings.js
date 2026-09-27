/**
 * settings.js — the numbers that decide money, in one place you can change
 * without a deploy.
 *
 * Why this exists
 * ---------------
 * What an animal is worth, how much a player may earn in a day, and how much
 * they may withdraw used to be constants in three different files. Changing
 * one meant editing code in three places, agreeing with yourself perfectly,
 * and redeploying. Miss one and the game says a rare animal is worth six
 * cents while the server pays two.
 *
 * Now there is one object. The admin page edits it, the server saves it, and
 * every part of the system asks it rather than remembering its own copy.
 *
 * Two rules it keeps for you, because they are the ones that bite:
 *
 *   · A daily cap below the most valuable animal is a cap that refuses that
 *     animal every time. Thirty cents a day with a thirty cent legendary used
 *     to mean a legendary could only ever be claimed as the very first thing
 *     you did that day. clamp() will not let you save that shape.
 *   · A withdrawal minimum above the per-request maximum is a withdrawal
 *     nobody can ever make. clamp() will not let you save that either.
 *
 * Nothing here is secret. The game is allowed to read it — it is how the
 * wallet shows the right numbers — but only the admin key may change it.
 */
'use strict';

/* ------------------------------------------------------------- the shape */

const RARITIES = ['common', 'uncommon', 'rare', 'exotic', 'legendary'];
const TIERS = ['free', 'member'];

/* The numbers the game ships with. Everything below is in cents, always, so
   there is never a question of whether a figure is dollars or not. */
const DEFAULTS = {
  /* What each kind of animal pays the first person to tame it. Common is
     zero on purpose: most of the world is common, so an ordinary animal is
     company rather than wages. */
  rates: { common: 0, uncommon: 2, rare: 6, exotic: 12, legendary: 30 },

  /* How much one account may earn in a day. */
  caps: { free: 30, member: 150 },

  /* Withdrawals, per tier. */
  withdraw: {
    free: { min: 500, maxPerRequest: 2000, maxPerDay: 2000, maxPerMonth: 5000 },
    member: { min: 300, maxPerRequest: 5000, maxPerDay: 5000, maxPerMonth: 20000 }
  },

  /* The membership that raises the daily limit. */
  membership: {
    name: 'Voxelia Member',
    priceCents: 299,
    days: 30,
    blurb: 'Five times the daily limit, and withdrawals open sooner.'
  },

  /* Switches, for when something is wrong and you want it to stop now
     rather than after a deploy. */
  earningPaused: false,
  payoutsPaused: false,

  /* Whether a player who has hit today's ceiling is topped up to it exactly.
     See topUpToCap in accounts.js for what this really means. */
  partialCredit: true
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const whole = (v, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : fallback;
};

/* ------------------------------------------------------------ the object */

class Settings {
  constructor(opts = {}) {
    this.values = clone(DEFAULTS);
    this.store = opts.store || null;       // something with load()/save()
    this.file = opts.file || 'settings.json';
    this.log = opts.log || (() => {});
    this.loaded = false;
  }

  /** Read what was saved last time, if anything ever was. */
  async load() {
    if (!this.store) { this.loaded = true; return this.values; }
    try {
      const saved = await this.store.load(this.file, null);
      if (saved && typeof saved === 'object') {
        this.values = this.clamp(this.merge(clone(DEFAULTS), saved));
        this.log('settings loaded');
      } else {
        this.log('no saved settings; using the ones the game ships with');
      }
    } catch (e) {
      this.log('could not read settings (' + (e && e.message) + '); using defaults');
    }
    this.loaded = true;
    return this.values;
  }

  save() {
    if (!this.store) return;
    try { this.store.save(this.file, this.values); } catch (e) {
      this.log('could not save settings: ' + (e && e.message));
    }
  }

  /** Everything, for the admin page. */
  all() { return clone(this.values); }

  /** Only what a browser needs, so the wallet can show the right figures. */
  publicView() {
    const v = this.values;
    return {
      rates: clone(v.rates),
      caps: clone(v.caps),
      withdraw: clone(v.withdraw),
      membership: clone(v.membership),
      earningPaused: !!v.earningPaused,
      payoutsPaused: !!v.payoutsPaused
    };
  }

  rates() { return this.values.rates; }

  /** What one animal of this kind pays. Anything unrecognised pays nothing. */
  worth(rarity) {
    const c = this.values.rates[String(rarity || 'common')];
    return Number.isFinite(c) ? Math.max(0, c) : 0;
  }

  capFor(tier) {
    return this.values.caps[tier === 'member' ? 'member' : 'free'];
  }

  withdrawFor(tier) {
    return this.values.withdraw[tier === 'member' ? 'member' : 'free'];
  }

  /* --------------------------------------------------------- changing it */

  /** Lay a patch over what is there, key by key, without losing the rest. */
  merge(base, patch) {
    for (const k of Object.keys(patch || {})) {
      const val = patch[k];
      if (val && typeof val === 'object' && !Array.isArray(val) &&
          base[k] && typeof base[k] === 'object') {
        this.merge(base[k], val);
      } else if (val !== undefined && val !== null) {
        base[k] = val;
      }
    }
    return base;
  }

  /**
   * Make a set of numbers into a set of numbers that can actually work.
   *
   * This is the part worth reading. Every rule here exists because breaking
   * it produces a game that looks configured correctly and quietly refuses
   * to pay anybody.
   */
  clamp(v) {
    const notes = [];

    // rates: whole cents, never negative, nothing absurd
    for (const r of RARITIES) {
      const was = v.rates[r];
      v.rates[r] = Math.max(0, Math.min(10000, whole(was, DEFAULTS.rates[r])));
      if (v.rates[r] !== was && was !== undefined) {
        notes.push(r + ' set to ' + v.rates[r] + 'c');
      }
    }

    // the most any single animal is worth
    const dearest = Math.max(...RARITIES.map(r => v.rates[r]));

    for (const t of TIERS) {
      // a cap has to be at least the dearest animal, or that animal can never
      // be claimed except as the first thing you do all day
      const wasCap = v.caps[t];
      v.caps[t] = Math.max(0, Math.min(1000000, whole(wasCap, DEFAULTS.caps[t])));
      if (v.caps[t] > 0 && v.caps[t] < dearest) {
        notes.push('the ' + t + ' daily limit was ' + v.caps[t] + 'c, below the ' +
                   dearest + 'c a legendary pays, so it has been raised to ' + dearest + 'c');
        v.caps[t] = dearest;
      }

      const w = v.withdraw[t] || (v.withdraw[t] = clone(DEFAULTS.withdraw[t]));
      w.min = Math.max(1, Math.min(10000000, whole(w.min, DEFAULTS.withdraw[t].min)));
      w.maxPerRequest = Math.max(1, Math.min(10000000,
        whole(w.maxPerRequest, DEFAULTS.withdraw[t].maxPerRequest)));
      w.maxPerDay = Math.max(1, Math.min(10000000,
        whole(w.maxPerDay, DEFAULTS.withdraw[t].maxPerDay)));
      w.maxPerMonth = Math.max(1, Math.min(100000000,
        whole(w.maxPerMonth, DEFAULTS.withdraw[t].maxPerMonth)));

      // a minimum above the most you may take out in one go is a withdrawal
      // nobody can ever make
      if (w.min > w.maxPerRequest) {
        notes.push('the ' + t + ' minimum (' + w.min + 'c) was above the most allowed in one ' +
                   'request, so that maximum has been raised to match');
        w.maxPerRequest = w.min;
      }
      // and the same going upwards
      if (w.maxPerRequest > w.maxPerDay) {
        notes.push('the ' + t + ' daily withdrawal limit was below one request, so it has been raised');
        w.maxPerDay = w.maxPerRequest;
      }
      if (w.maxPerDay > w.maxPerMonth) {
        notes.push('the ' + t + ' monthly withdrawal limit was below the daily one, so it has been raised');
        w.maxPerMonth = w.maxPerDay;
      }
    }

    const m = v.membership;
    m.priceCents = Math.max(0, Math.min(1000000, whole(m.priceCents, DEFAULTS.membership.priceCents)));
    m.days = Math.max(1, Math.min(3650, whole(m.days, DEFAULTS.membership.days)));
    m.name = String(m.name || DEFAULTS.membership.name).slice(0, 60);
    m.blurb = String(m.blurb || '').slice(0, 200);

    v.earningPaused = !!v.earningPaused;
    v.payoutsPaused = !!v.payoutsPaused;
    v.partialCredit = v.partialCredit !== false;

    this.lastNotes = notes;
    return v;
  }

  /**
   * Change some of it. Returns what it now is, plus anything that had to be
   * corrected — the admin page shows those, so a change that could not be
   * honoured exactly never happens silently.
   */
  update(patch) {
    this.values = this.clamp(this.merge(this.values, patch || {}));
    this.save();
    return { ok: true, settings: this.all(), notes: this.lastNotes || [] };
  }

  /** Back to the numbers the game ships with. */
  reset() {
    this.values = clone(DEFAULTS);
    this.save();
    return { ok: true, settings: this.all(), notes: ['back to the original numbers'] };
  }
}

module.exports = { Settings, DEFAULTS, RARITIES, TIERS };
