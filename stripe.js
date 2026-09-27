/**
 * stripe.js — memberships, paid for with a card, with a three day free trial.
 *
 * Why this file has no `require('stripe')` in it
 * ----------------------------------------------
 * The rest of this server has no dependencies at all: no npm install, nothing
 * to go stale, nothing to audit, and a deploy that cannot fail because a
 * package was yanked. Stripe's API is plain HTTPS with form-encoded bodies,
 * and the only clever part — checking that a webhook really came from Stripe
 * — is an HMAC that Node can do on its own. So this keeps the promise.
 *
 * What it does, in order
 * ----------------------
 *  1. The game asks for a checkout. We make a Stripe Checkout Session in
 *     `subscription` mode with `trial_period_days: 3` and send back its URL.
 *     Stripe hosts the card form, so no card number ever touches this server
 *     or the game — which is the whole reason to use hosted Checkout.
 *  2. The player pays (or starts the trial) on Stripe's page.
 *  3. Stripe calls our webhook. THAT is what turns the membership on. Not the
 *     browser coming back to a success page, which anybody could visit.
 *  4. When the trial ends without a card, or a card fails, or they cancel,
 *     Stripe tells us again and the membership goes off.
 *
 * The one rule
 * ------------
 * Nothing a browser says can grant a membership. The success page only says
 * "thank you"; the webhook is the truth. A player who taps the success URL by
 * hand gets a thank-you and no membership.
 */
'use strict';

const https = require('https');
const crypto = require('crypto');

/* Stripe's address. STRIPE_API_HOST points it somewhere else, which is only
   ever used to run the whole flow — checkout, webhook, membership — against
   a stand-in during testing. Left alone it is Stripe. */
const API = String(process.env.STRIPE_API_HOST || 'api.stripe.com');
const INSECURE = /^(127\.0\.0\.1|localhost)(:|$)/.test(API);

/** Stripe wants form encoding, including for nested things like a[b][c]. */
function form(obj, prefix, out) {
  out = out || [];
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val === undefined || val === null) continue;
    const name = prefix ? prefix + '[' + key + ']' : key;
    if (Array.isArray(val)) {
      val.forEach((v, i) => {
        if (v && typeof v === 'object') form(v, name + '[' + i + ']', out);
        else out.push(encodeURIComponent(name + '[' + i + ']') + '=' + encodeURIComponent(v));
      });
    } else if (val && typeof val === 'object') {
      form(val, name, out);
    } else {
      out.push(encodeURIComponent(name) + '=' + encodeURIComponent(val));
    }
  }
  return out.join('&');
}

class Stripe {
  constructor(opts = {}) {
    // every scrap of whitespace out: a key pasted into a hosting panel
    // often arrives wrapped across two lines, and a header cannot hold one
    const tidy = (k) => String(k || '').replace(/\s+/g, '');
    this.key = tidy(opts.key || process.env.STRIPE_SECRET_KEY);
    this.price = tidy(opts.price || process.env.STRIPE_PRICE_ID);
    this.webhookSecret = tidy(opts.webhookSecret || process.env.STRIPE_WEBHOOK_SECRET);
    this.trialDays = Math.max(0, Math.min(365,
      Math.round(Number(opts.trialDays || process.env.STRIPE_TRIAL_DAYS || 3))));
    this.log = opts.log || (() => {});
    this.site = String(opts.site || process.env.SITE_URL ||
      'https://zayaiken21.github.io/Moon-testing/').replace(/\/+$/, '') + '/';
  }

  /** Is there enough here to sell anything? */
  get ready() { return !!(this.key && this.price); }

  /** What is missing, said in a way somebody can act on. */
  get trouble() {
    if (!this.key) return 'STRIPE_SECRET_KEY is not set on Render.';
    if (!/^sk_(test|live)_/.test(this.key)) {
      return 'STRIPE_SECRET_KEY does not look like a secret key — it should start ' +
             'with sk_test_ or sk_live_. A key starting pk_ is the publishable one, ' +
             'which cannot do this.';
    }
    if (!this.price) return 'STRIPE_PRICE_ID is not set on Render.';
    if (!/^price_/.test(this.price)) {
      return 'STRIPE_PRICE_ID should start with price_. An id starting prod_ is the ' +
             'product rather than its price.';
    }
    if (!this.webhookSecret) {
      return 'STRIPE_WEBHOOK_SECRET is not set, so Stripe cannot be believed when it ' +
             'says somebody has paid, and no membership will ever turn on.';
    }
    return '';
  }

  get live() { return /^sk_live_/.test(this.key); }

  /* ------------------------------------------------------------ the wire */

  call(method, path, body) {
    return new Promise((resolve) => {
      const payload = body ? form(body) : null;
      let req;
      const wire = INSECURE ? require('http') : https;
      const bits = API.split(':');
      try {
        req = wire.request({
          host: bits[0], port: bits[1] ? Number(bits[1]) : (INSECURE ? 80 : 443),
          path: '/v1/' + path, method,
          headers: Object.assign({
            authorization: 'Bearer ' + this.key,
            'stripe-version': '2024-06-20'
          }, payload ? {
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': Buffer.byteLength(payload)
          } : {})
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
        this.log('could not build the request: ' + (e && e.message));
        return resolve({ status: 0, body: null, why: e && e.message });
      }
      req.on('error', (e) => resolve({ status: 0, body: null, why: e && e.message }));
      req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, body: null, why: 'timed out' }); });
      if (payload) req.write(payload);
      req.end();
    });
  }

  /* ------------------------------------------------------- the checkout */

  /**
   * Somewhere for this player to go and start their trial.
   *
   * `client_reference_id` carries the account id there and back, so the
   * webhook knows whose membership this is without trusting anything the
   * browser says afterwards. The metadata carries it too, because a
   * subscription event arrives without the checkout session attached.
   */
  async checkout(account, opts = {}) {
    if (!this.ready) return { ok: false, why: this.trouble };
    if (!account || !account.id) return { ok: false, why: 'No account to put it on.' };

    const body = {
      mode: 'subscription',
      line_items: [{ price: this.price, quantity: 1 }],
      client_reference_id: account.id,
      success_url: this.site + '?paid=1&session={CHECKOUT_SESSION_ID}',
      cancel_url: this.site + '?paid=0',
      allow_promotion_codes: true,
      subscription_data: {
        metadata: { account_id: account.id, username: account.username || '' }
      },
      metadata: { account_id: account.id }
    };

    /* The free trial. Three days by default, and Stripe does not charge a
       penny until it is over — but it does take a card up front, so the
       subscription simply continues rather than stopping dead and having to
       be set up again. `missing_payment_method: cancel` is the important
       one: if a card is never given, or the one given is removed, the
       subscription ends when the trial does rather than quietly becoming an
       unpaid subscription nobody is watching. */
    if (this.trialDays > 0) {
      body.subscription_data.trial_period_days = this.trialDays;
      body.subscription_data.trial_settings = {
        end_behavior: { missing_payment_method: 'cancel' }
      };
    }

    /* Use the customer we already made for them if there is one, so a second
       membership does not create a second customer with the same email. */
    if (account.stripe_customer) body.customer = account.stripe_customer;
    else if (account.email) body.customer_email = account.email;

    const res = await this.call('POST', 'checkout/sessions', body);
    if (res.status !== 200 || !res.body || !res.body.url) {
      const said = res.body && res.body.error && res.body.error.message;
      this.log('checkout refused: ' + (said || ('status ' + res.status)));
      return { ok: false, why: said || 'Stripe would not start a checkout just now.' };
    }
    return { ok: true, url: res.body.url, id: res.body.id, trialDays: this.trialDays };
  }

  /** A page where somebody can cancel, or change the card they are using. */
  async portal(account) {
    if (!this.ready) return { ok: false, why: this.trouble };
    if (!account || !account.stripe_customer) {
      return { ok: false, why: 'There is no membership on this account to manage.' };
    }
    const res = await this.call('POST', 'billing_portal/sessions', {
      customer: account.stripe_customer,
      return_url: this.site
    });
    if (res.status !== 200 || !res.body || !res.body.url) {
      const said = res.body && res.body.error && res.body.error.message;
      return { ok: false, why: said || 'Could not open the billing page.' };
    }
    return { ok: true, url: res.body.url };
  }

  async subscription(id) {
    const res = await this.call('GET', 'subscriptions/' + encodeURIComponent(id));
    return res.status === 200 ? res.body : null;
  }

  /* --------------------------------------------------------- the webhook */

  /**
   * Did this really come from Stripe?
   *
   * The signature is over the exact bytes Stripe sent, so the raw body has to
   * be kept — parsing it first and re-encoding it gives different bytes and
   * every check fails. The comparison is constant time, and anything older
   * than five minutes is refused so a captured call cannot be replayed.
   */
  verify(rawBody, signatureHeader) {
    if (!this.webhookSecret) return { ok: false, why: 'STRIPE_WEBHOOK_SECRET is not set' };
    const header = String(signatureHeader || '');
    let t = '';
    const v1 = [];
    for (const part of header.split(',')) {
      const [k, v] = part.split('=');
      if (k === 't') t = v;
      if (k === 'v1') v1.push(v);
    }
    if (!t || !v1.length) return { ok: false, why: 'no signature on the request' };

    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
    if (!Number.isFinite(age) || age > 300) {
      return { ok: false, why: 'that call is ' + age + ' seconds old' };
    }

    const want = crypto.createHmac('sha256', this.webhookSecret)
      .update(t + '.' + rawBody, 'utf8').digest('hex');
    const wantBuf = Buffer.from(want, 'hex');
    const matched = v1.some((got) => {
      let gotBuf;
      try { gotBuf = Buffer.from(got, 'hex'); } catch (e) { return false; }
      return gotBuf.length === wantBuf.length && crypto.timingSafeEqual(gotBuf, wantBuf);
    });
    if (!matched) return { ok: false, why: 'the signature does not match' };

    let event = null;
    try { event = JSON.parse(rawBody); } catch (e) {
      return { ok: false, why: 'the body was not JSON' };
    }
    return { ok: true, event };
  }

  /**
   * Turn a Stripe event into plain words about one account.
   *
   * Returns null for anything we do not care about, which is most of them:
   * Stripe sends a great many events and reacting to the wrong one is how
   * memberships get turned off at the wrong moment.
   */
  read(event) {
    if (!event || !event.type || !event.data) return null;
    const o = event.data.object || {};

    if (event.type === 'checkout.session.completed') {
      if (o.mode !== 'subscription') return null;
      return {
        what: 'started',
        account: o.client_reference_id || (o.metadata && o.metadata.account_id) || null,
        customer: typeof o.customer === 'string' ? o.customer : null,
        subscription: typeof o.subscription === 'string' ? o.subscription : null
      };
    }

    if (event.type === 'customer.subscription.created' ||
        event.type === 'customer.subscription.updated' ||
        event.type === 'customer.subscription.deleted') {
      /* `trialing` is a member: that is the whole point of the free trial.
         `active` is a member. `past_due` is given the benefit of the doubt
         for now — a card that failed once is usually retried and works, and
         switching somebody off the moment a payment is late is a harsh way
         to treat a child whose parent's card expired. Everything else —
         canceled, unpaid, incomplete, incomplete_expired, paused — is not. */
      const on = o.status === 'trialing' || o.status === 'active' || o.status === 'past_due';
      return {
        what: event.type === 'customer.subscription.deleted' ? 'ended' : 'changed',
        member: event.type === 'customer.subscription.deleted' ? false : on,
        status: o.status,
        trialing: o.status === 'trialing',
        until: o.current_period_end ? new Date(o.current_period_end * 1000).toISOString() : null,
        trialEnds: o.trial_end ? new Date(o.trial_end * 1000).toISOString() : null,
        cancelAtPeriodEnd: !!o.cancel_at_period_end,
        account: (o.metadata && o.metadata.account_id) || null,
        customer: typeof o.customer === 'string' ? o.customer : null,
        subscription: o.id || null
      };
    }

    return null;
  }
}

module.exports = { Stripe, form };
