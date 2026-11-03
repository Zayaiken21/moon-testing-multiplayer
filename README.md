# Voxelia server

The multiplayer relay and the admin dashboard. Deploy this repo to Render.

    server.js       rooms, block sync, voice signalling, visit counting
    accounts.js     accounts, balances, claims and withdrawals, in Supabase
    settings.js     every number that decides money, editable from /admin
    stripe.js       the card checkout, the three day trial, and the webhook
    store-github.js keeps the numbers in a GitHub repo, not on Render's disk
    admin.html      the dashboard at /admin
    schema.sql      run this in Supabase; safe to run again any time
    STRIPE-SETUP.md how to set up the trial and go live
    package.json    start script and Node version
    render.yaml     blueprint, if you create the service with New → Blueprint
    .node-version   pins Node 20

## Deploying

Render → New → Blueprint → point at this repo. It reads `render.yaml`.

If you make a Web Service by hand instead, set:

| Field | Value |
|---|---|
| Environment | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |

Add an environment variable `ADMIN_KEY` with a key of your choosing, then open
`https://your-service.onrender.com/admin` and enter it once.

## Running it locally

    node server.js
    node server.js --port 8080 --admin yourkey

## What it exposes

This service never serves the game. Opening the Render address in a browser
gives you the admin page, not Voxelia — the game is on GitHub Pages. If your
backend repo still has a copy of `index.html` in it, delete
them; nothing here reads them.

| Route | Purpose |
|---|---|
| `GET /` | the admin page |
| `GET /rooms` | open rooms, cached for 8 seconds |
| `GET /room?code=` | one room |
| `POST /visit` | counts an opening, once per device per day |
| `GET /admin` | the dashboard, same as `/` |
| `POST /claim` | pays the first account to tame a creature, once |
| `GET /wallet?account=` | that account's balance |
| `POST /transfer` | moves a pet's ownership, never its payout |
| `GET /admin/data?key=` | the numbers behind it |
| `WS /` | play: rooms, moves, blocks, crew travel, voice signalling |

Every route is limited to 120 requests a minute per address, so a stuck client
cannot run up your free tier.

## Keeping the two repos in step

The only link between them is the one line in the frontend's `index.html`:

    const DEFAULT_SERVER = 'your-service.onrender.com';

Change that when the address changes. Nothing else crosses over.

## The ledger

`ledger.json` holds every account balance and one record per creature claimed.
A creature is identified by the world seed plus its spawn key, so the same
animal cannot be claimed twice by anyone. Creative mode claims are refused, and
each account has a daily ceiling.

Two things to be aware of before real money moves:

- Accounts are currently a random id kept in the player's browser. Clearing site
  data makes a new one. Real payouts need sign-in, which is the next piece.
- Render's free disk is wiped on redeploy. Move `ledger.json` to a database
  before anyone can withdraw.

## What is tracked

| Figure | How it is measured |
|---|---|
| Opens, all time and today | one per device per day, only counted once the server confirms |
| Players, lifetime | distinct accounts that have ever opened it |
| Online right now | a heartbeat every minute while actually playing; quiet for three minutes means gone |
| Playing alone / in rooms | heartbeats versus room membership |
| Came back | accounts with more than one opening |
| Hours played, average session | summed from the gaps between heartbeats |
| Where they came from | the referring site |
| What they played on | parsed from the browser |
| Recent opens | the last forty, with device, source and whether installed |

The ping is deliberately hard to lose: a beacon first, then a plain GET that
answers with a 1x1 gif, then fetch. None of them need a CORS preflight, so a
cold server on the first try is retried rather than silently dropped.

It costs about 60 requests an hour per player, well inside the 120 a minute
limit, and nothing is sent while the game is paused or the tab is hidden.

## Where the numbers live

Render's free tier wipes its disk on every redeploy and cold start, which is why
the counts kept resetting to zero. The record now lives in a GitHub repo. Render
reads it when it boots and commits changes back; the repo is the truth.

Set three environment variables on the service:

| Variable | Example | What it is |
|---|---|---|
| `GITHUB_TOKEN` | `github_pat_...` | a fine-grained token with **Contents: read and write** on the data repo only |
| `GITHUB_REPO` | `zayaiken21/voxelia-server` | this same repo |
| `GITHUB_BRANCH` | `voxelia-data` | a branch Render does not watch |
| `GITHUB_DATA_DIR` | `data` | optional, defaults to `data` |

It writes `data/stats.json` and `data/ledger.json`. Neither needs to exist first
— they are created on the first save.

Writes are batched to at most one commit a minute per file, so a busy day is
roughly 2,880 commits against a 5,000-an-hour API allowance. A local copy is
written immediately as well, so a crash between commits loses nothing, and the
server commits once more on shutdown before it exits.

If two instances ever write at once, the second re-reads the file and retries —
tested, along with a wiped disk recovering its numbers, and a missing token
falling back to local files so development still works.

### Two repositories, not three

The numbers live on a **branch of this same repo**, not in a third one. Render
only watches `main`, so writing to the `voxelia-data` branch never triggers a
redeploy. Create it once, empty:

    git checkout --orphan voxelia-data
    git rm -rf .
    mkdir data && echo '{}' > data/stats.json && echo '{}' > data/ledger.json
    git add data && git commit -m "data branch"
    git push origin voxelia-data
    git checkout main

Then set `GITHUB_REPO` to this repo and `GITHUB_BRANCH` to `voxelia-data`.

## Accounts

`accounts.js` holds them, in Supabase, sharded. Run `supabase-schema.sql` in
each project first.

| Variable | Value |
|---|---|
| `SUPABASE_URLS` | `https://oxmjxuuymplhnbcdltho.supabase.co` — add more, comma separated, to shard |
| `SUPABASE_SERVICE_KEYS` | the **service_role** key for each project, in the same order |

### About the two Supabase keys

The anon key you sent is meant to be public and is safe in the page. It is also
useless for this: the schema turns row level security on and adds no policies,
so the anon key can read nothing and write nothing. Balances are written with
the service key, which lives only here. Never put the service key in the game.

### Routes

| Route | Purpose |
|---|---|
| `POST /account/signup` | email, username, password |
| `POST /account/signin` | returns a session token |
| `POST /account/forgot` | issues a reset token |
| `POST /account/reset` | token plus a new password |
| `GET /account/me?session=` | the signed-in account |
| `POST /account/companions` | stores that account's companions |
| `GET /admin/accounts?key=` | every account, plus reset links waiting |
| `POST /admin/accounts?key=` | `create`, `delete`, `subscribe` |

### Earning

One cent per creature. Five cents a day without a membership, twenty five with
one. Cancelling drops it back to five the moment the subscription lapses. A
creature already claimed by anyone pays nobody again.

### Passwords

scrypt with a per-account salt, compared in constant time. A wrong password and
an email that does not exist give the identical answer, so nobody can use the
form to discover who has an account.

Reset links are not emailed yet. They appear on the admin page under Resets,
valid for an hour, single use, and every existing session is dropped when a
password changes.
