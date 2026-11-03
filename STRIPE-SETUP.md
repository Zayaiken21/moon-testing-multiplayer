# Stripe: the three day free trial, start to finish

Everything here happens in **Stripe's dashboard** and in **Render's
environment**. Nothing goes in the game page, and nothing here needs code
changing — the server already does all of it.

Work in **test mode** first. There is a switch at the top right of the Stripe
dashboard. Nothing in test mode can move real money, and the whole thing can
be tried end to end with a fake card.

---

## What you are setting up

A player presses **Start my 3 day free trial**. Stripe takes their card, bills
them nothing, and gives them the membership straight away. Three days later
Stripe charges the monthly price by itself and tells the server. If they
cancel during the trial, they are never charged.

The important part: **nothing in the browser can grant a membership.** Not the
game, not the page Stripe sends people back to. Stripe tells the server, the
server checks the signature, and only then does anybody become a member.

---

## 1. Make the product and its price

Stripe dashboard → **Product catalogue** → **+ Add product**.

- **Name**: `Voxelia Member`
- **Pricing model**: Recurring
- **Price**: what you want to charge — `$2.99`
- **Billing period**: Monthly
- Save.

Now open the product and find the **price** id under the price you just made.
It starts `price_`. Copy it.

> Two ids look similar and only one works. The **product** id starts `prod_`.
> The **price** id starts `price_`. You need `price_`. The server refuses a
> `prod_` and says so in the log rather than failing quietly.

**Do not set a trial on the price itself.** The server asks for the trial when
it creates the checkout, which is what lets you change the length later by
changing one setting on Render instead of making a new price.

---

## 2. Get your secret key

Stripe dashboard → **Developers** → **API keys**.

Copy the **Secret key** — it starts `sk_test_` in test mode and `sk_live_`
when you go live.

> The **publishable** key starts `pk_`. That one is safe in a web page and is
> not what this needs. The secret key can move money and must only ever be in
> Render's environment. If it ever ends up in the game page, roll it in
> Stripe → Developers → API keys → **Roll key**.

---

## 3. Tell Stripe where to reach the server

Stripe dashboard → **Developers** → **Webhooks** → **Add endpoint**.

- **Endpoint URL**:
  `https://moon-testing-multiplayer.onrender.com/stripe/webhook`
- **Events to send** — add exactly these four:

  | Event | Why |
  |---|---|
  | `checkout.session.completed` | remembers which Stripe customer is which player |
  | `customer.subscription.created` | the trial starting: this is what grants the membership |
  | `customer.subscription.updated` | the trial turning into a paid month, or a payment failing |
  | `customer.subscription.deleted` | cancelled or run out: the membership ends |

Add the endpoint, then open it and reveal the **Signing secret**. It starts
`whsec_`. Copy it.

> Without this secret the server cannot tell a real message from Stripe from
> anybody on the internet posting to that address, so it refuses every one of
> them and **no membership will ever turn on**. The server says so on boot.

---

## 4. Put the four values on Render

Render → your service → **Environment** → Add environment variable.

| Name | Value |
|---|---|
| `STRIPE_SECRET_KEY` | the `sk_test_…` key from step 2 |
| `STRIPE_PRICE_ID` | the `price_…` id from step 1 |
| `STRIPE_WEBHOOK_SECRET` | the `whsec_…` secret from step 3 |
| `STRIPE_TRIAL_DAYS` | `3` |
| `SITE_URL` | `https://zayaiken21.github.io/Moon-testing/` |

`STRIPE_TRIAL_DAYS` is the only place the trial length lives. Change it to `7`
and the next person to start one gets seven days; nothing else needs touching.
Set it to `0` and there is no trial and people are charged at once.

Save and let Render redeploy.

### Checking it took

The deploy log says one line:

```
stripe: ready (test mode, 3 day free trial)
```

If something is missing it says which, in plain words:

```
stripe: not set up — STRIPE_PRICE_ID should start with price_. An id
        starting prod_ is the product rather than its price.
```

`https://<your-render-address>/store/plans` should also now say
`"checkout":"card"` and `"trialDays":3`.

---

## 5. Try it, with a card that is not real

1. Open the game, make an account, and sign in.
2. Wallet → **Membership** → **Start my 3 day free trial**.
3. Stripe's page opens. Use the test card **4242 4242 4242 4242**, any future
   expiry, any three digit code, any postcode.
4. You land back in the game. Within a second or two you are a member: the
   wallet says **member** and your daily limit is the higher one.

Check the Render log:

```
stripe: checkout finished for acc_...
stripe: acc_... is now a member (trialing, on the free trial)
```

And in Stripe → **Subscriptions**, the subscription reads **Trialing** with
its trial ending in three days.

**Other test cards worth trying**

| Card | What happens |
|---|---|
| `4242 4242 4242 4242` | works |
| `4000 0000 0000 9995` | declined — the trial never starts, nobody becomes a member |
| `4000 0025 0000 3155` | asks for the bank's extra confirmation |

### Watching the trial end without waiting three days

Stripe → **Subscriptions** → open it → **Actions** → **End trial now**. Stripe
bills the card and sends `customer.subscription.updated` with `active`. The
Render log says so, and the membership carries on with a month on it instead
of three days.

### Cancelling

In the game: Wallet → Membership → **Manage membership**. That opens Stripe's
own page, where they can cancel or change the card. On cancelling, Stripe
sends `customer.subscription.deleted`, the log says
`is now not a member (canceled)`, and the daily limit goes back to the free
one.

---

## 6. Going live

1. Switch the Stripe dashboard out of test mode.
2. Make the product and price **again** — test and live are separate worlds
   and a `price_` id from test mode does not exist in live.
3. Add the webhook endpoint again, in live mode, with the same four events,
   and copy the new `whsec_`.
4. On Render, replace all three values with the live ones.
5. The log will say `stripe: ready (LIVE — real cards, 3 day free trial)`.

Before you switch it on, three things that are not code:

- Stripe will want to know who you are and where the money goes before it
  will pay out.
- **Taking money from children has rules that differ by country**, and some of
  your players are children. A subscription bought by a child without a
  parent is, in a lot of places, refundable on demand — and app stores and
  card networks take a dim view of it. Get this checked by somebody who knows
  the rules where you are. I can write the code; I cannot tell you whether
  you are allowed to run it.
- Keep test mode working after you go live. It is the only way to try a change
  without a real card.

---

## 7. If something goes wrong

**"Nobody becomes a member even though the card went through."**
The webhook is not arriving or not being believed. Stripe → Developers →
Webhooks → your endpoint → **Attempts**. A red row shows what the server
answered. `400 no signature on the request` means `STRIPE_WEBHOOK_SECRET` is
missing or is from the other mode; `400 the signature does not match` means it
is the wrong one for this endpoint.

**"The trial is a month, not three days."**
Check `STRIPE_TRIAL_DAYS` is `3` on Render, and that you did **not** also set a
trial on the price in Stripe. If the price carries its own trial, Stripe uses
that one and ignores what the server asked for.

**"It says card payments are not set up yet."**
`/store/plans` is reporting no checkout, which means the server booted without
a usable key or price. The deploy log's `stripe:` line says which.

**"Somebody was charged during the trial."**
They should not have been. Check the subscription in Stripe: if it says
`active` rather than `trialing` from the start, the price has its own trial
settings or the checkout was made before `STRIPE_TRIAL_DAYS` was set. Refund
from the Stripe dashboard — it is one button — and check the Render log for
which it was.

**"The membership never ends."**
It cannot now, but it is worth knowing what used to happen: during a trial
Stripe gives no billing period, only a trial end date, and the server was only
reading the billing period — so a trialing account was stored with no end date
at all, which means a membership that never expires if the cancel webhook ever
went astray. It now uses the trial's own end date while the trial is running.

---

## What is where

| Thing | Where it lives |
|---|---|
| The secret key, price, webhook secret, trial length | Render environment only |
| Asking Stripe for a checkout | `stripe.js` on the server |
| Believing what Stripe says | `stripe.js` `verify()` — signature checked, replays over five minutes old refused |
| Turning the membership on | `accounts.js` `applyStripe()`, called only from the webhook |
| The shop the player sees | `store.js` in the game page — holds no keys and cannot grant anything |
