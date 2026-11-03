# Setting up accounts, the wallet and getting people paid

Everything here happens in the **backend** repo (the one on Render). Nothing
in this file goes anywhere near the game page.

---

## 1. The one rule

The **anon key** is public. It is in the game page, anybody can read it out of
the source, and it must never be able to change a balance.

`schema.sql` turns row level security on for every table and creates **no
policies at all**, so the anon key can read nothing and write nothing. The
**service_role** key ignores row level security, which is exactly why it only
ever lives in Render's environment.

| Key | Where it lives | What it can do |
|---|---|---|
| anon | the game page, publicly | nothing at all in the database |
| service_role | Render environment only | everything |

If the service_role key ever appears in `index.html`, treat it as leaked:
rotate it in Supabase → Settings → API → "Reset service role key", and put the
new one in Render.

---

## 2. Run the SQL

For **each** Supabase project you are using (one is fine to start with):

1. Supabase → your project → **SQL Editor** → New query.
2. Paste the whole of `schema.sql`.
3. Run.

It is safe to run again later — everything is `if not exists`.

Check it worked: Table Editor should show `accounts`, `claims`, `payouts`,
`ledger`, `worlds` and `rarity_rates`, each with a padlock (RLS on).

---

## 3. Set the environment on Render

Render → your service → **Environment** → Add environment variable.

| Name | Value |
|---|---|
| `SUPABASE_URLS` | `https://oxmjxuuymplhnbcdltho.supabase.co` |
| `SUPABASE_SERVICE_KEYS` | the service_role key for that project |
| `ADMIN_KEY` | any long random string you invent — it guards the admin page |
| `RATE_LIMIT` | optional; requests allowed per address per minute (200) |

**When pasting the key**, a line break sometimes comes along with it. The
server now strips every scrap of whitespace before use, so a key that arrived
wrapped across two lines works anyway — but it is worth checking that the
Render field holds one unbroken line.

Both lists are comma separated and line up by position, so when you add a
second project later:

```
SUPABASE_URLS=https://first.supabase.co,https://second.supabase.co
SUPABASE_SERVICE_KEYS=service-key-for-first,service-key-for-second
```

Adding a shard only affects accounts created after you add it — every account
row remembers which shard it lives in, so nothing already there moves.

### Checking it took

Open `https://<your-render-address>/health`. It answers in a moment and says
where accounts are being kept:

- `"accounts":"supabase"` — the keys are being read; accounts save properly.
- `"accounts":"memory"` — one of the two variables is not reaching the server.
  Accounts will appear to work and then vanish on the next deploy.

The deploy log says the same thing more precisely, one line per project:

```
accounts: shard 0 ready: https://....supabase.co (service_role)
accounts: shard 0: that is the ANON key, which can do nothing here.
accounts: shard 0 (…) has no service key
```

---

## 3b. Keeping the server awake

A free Render service sleeps after fifteen quiet minutes. Two things keep
yours up, and together they cover the whole day:

- **While anybody is playing**, every open copy of the game says hello to
  `/health` once a minute. Nothing to set up; it is already in the page.
- **When nobody is**, a GitHub Action does the same. Put
  `.github/workflows/keep-awake.yml` in your **GitHub Pages** repository and
  it starts on its own. Each run says hello every twenty seconds for four
  minutes, and GitHub starts a run every five, so the runs overlap and a
  skipped one still cannot leave a fifteen-minute gap.

Scheduled workflows on a public repository are free. GitHub will not run one
more often than every five minutes, and often runs late — which is why each
run keeps going for four minutes rather than saying hello once.

If the server is genuinely down rather than asleep, that workflow turns red,
so the Actions tab doubles as a monitor.

---

## 4. What an animal is worth — and everything else about money

**All of this is set on the admin page now**, under "What the game pays". It
takes effect on the very next animal anybody tames: no deploy, no restart, and
no editing the same number in three files and hoping they agree. Everything is
in cents.

Open `https://<your-render-address>/admin?key=<your ADMIN_KEY>` and scroll to
it. What you can set:

| Setting | What it is | Ships as |
|---|---|---|
| Common / Uncommon / Rare / Exotic / Legendary | what one animal pays the first person to tame it | 0 / 2 / 6 / 12 / 30 |
| Daily limit, no membership | most one account may earn in a day | 30 |
| Daily limit, member | the same, with a membership | 150 |
| Withdrawals — smallest | the minimum withdrawal, per tier | 500 free, 300 member |
| Withdrawals — most in one | the most in a single request | 2000 / 5000 |
| Withdrawals — most a day | per account, per day | 2000 / 5000 |
| Withdrawals — most a month | per account, per calendar month | 5000 / 20000 |
| Membership | what it is called, what it costs, how many days | Voxelia Member, 299, 30 |
| Stop all earning | an immediate halt, for when something is wrong | off |
| Stop all withdrawals | the same, for money going out | off |
| Top up to the limit | see below | on |

Roughly how much of the world is what: common about 78 in 100, uncommon 15,
rare 5, exotic 1.5, legendary about 1 in 200. Common being zero is deliberate
— most of what lives in the world is common, so an ordinary animal is company
rather than wages, and the money is something to go looking for.

### Two rules the server keeps for you

**Numbers that cannot work are corrected as you save, and it tells you.** A
daily limit below the most valuable animal refuses that animal every single
time: set the limit to 30 with a 30-cent legendary and a player could only
ever claim one as the very first thing they did all day. Save that and the
limit is raised to meet the legendary, with a line saying so. The same goes
for a withdrawal minimum above the most allowed in one request, which would be
a withdrawal nobody could ever make.

**"Top up to the limit" is on, and should stay on.** With four cents of room
left and a thirty cent legendary, a player is paid the four rather than turned
away with nothing. It means everybody reaches their daily limit exactly, once
a day, instead of stopping short of it holding an animal too valuable to fit.
Turn it off and the old behaviour returns: an animal that does not fit in what
is left pays nothing at all.

### The rule that is not a setting

**Only the first account anywhere** to tame a particular animal is paid for it.
The `claims` table has the animal itself as its primary key, so a second person
taming "the same" animal is told somebody beat them to it.

### Where the numbers live

In `settings.json`, kept the same way the ledger is. `settings.js` holds the
figures the game ships with and the two rules above. The constants still in
`server.js` and `accounts.js` are only what is used in the moment before
settings have finished loading on boot.

---

## 4b. Memberships

A membership raises the daily earning limit and lowers the withdrawal minimum.
Both figures are settings, so what you are selling is whatever the admin page
currently says it is.

**Being straight about payment: nothing is connected to a card processor.**
Rather than put a checkout in the game that does not work, a membership is
turned on with a code:

1. Admin page → **Membership codes** → how many, how many days, press Make them.
2. Take payment however you already do.
3. Hand over a code.
4. The player opens Wallet → Membership in the game and types it in.

A code works once. Typed without its dashes, or in lower case, it still works.
A second code adds its days onto the end of what is left rather than throwing
the remainder away.

You can also turn a membership on directly from the accounts section of the
admin page, which is the quickest way to give one to a friend or to put right
a payment that went wrong.

---

## 5. Paying somebody

A player asks from Wallet → Request a withdrawal. Asking is all the game does
— no money moves by itself and nothing is automatic.

**What happens when they ask**

The game asks the server what this player is allowed right now, rather than
deciding anything itself, so the limits you set on the admin page are the ones
they are offered. Then:

- the amount comes off their balance **immediately**, so the same money cannot
  be requested twice while you are deciding;
- it counts towards their per-day and per-month ceilings, and those are stored
  on the account, so they survive a restart;
- a row appears under **Withdrawals waiting** on the admin page.

If the database cannot be reached at that moment, nothing is taken and they
are told so.

**What you do**

1. Open the admin page at `https://<your-render-address>/admin?key=<your ADMIN_KEY>`
   and look at **Withdrawals waiting**. The figure at the top is what you owe.
2. Pay the person, by hand, however you have agreed — PayPal, a gift card,
   whatever suits.
3. Press **Mark sent** and paste in the reference from wherever you sent it.

**Turning one down** puts the money straight back on their balance and frees
up their daily and monthly room again, so a mistake costs nobody anything.

**Connecting a real provider.** Nothing here talks to a payment company yet,
and the Withdraw button says so honestly rather than pretending. When you are
ready, PayPal Payouts is the usual first choice for small amounts. Before you
switch it on:

- You will need a business account and to be able to show where the money
  comes from.
- Paying people, including children, has rules that differ by country. Because
  some of your players are children, get this checked by somebody who knows
  the rules where you are before any money moves. I can help you write the
  code; I cannot tell you whether you are allowed to.
- Keep the by-hand step at first even after it is connected. A bug in an
  automatic payout is a bug that sends real money to the wrong person.

---

## 6. Checking it works

With the server running:

```bash
# make an account
curl -s -X POST $SERVER/account/signup \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","username":"You","password":"a-long-one"}'

# tame something rare (this is what the game sends)
curl -s -X POST $SERVER/claim \
  -H 'content-type: application/json' \
  -d '{"account":"acc_...","creature":"seed:17:r1234","rarity":"rare","mode":"survival"}'
# -> {"ok":true,"cents":6,...}

# the same animal again
# -> {"ok":false,"why":"You have already been paid for this one."}

# a common one
# -> {"ok":false,"why":"A common animal. Lovely, but it pays nothing.","cents":0}

# what the server currently pays, which is what the game shows
curl -s $SERVER/settings
# -> {"rates":{...},"caps":{"free":30,"member":150},"withdraw":{...},...}
```

The withdrawal minimum is no longer an environment variable — it is on the
admin page, separately for members and everybody else.

And in the SQL editor, the money you owe altogether:

```sql
select * from public.money_owed;
```

---

## 7. If something goes wrong

**"It says they were paid but the money never arrives."** This was a real bug
and it is fixed, but if you ever see it again the cause is worth knowing. The
server used to mark the animal claimed and answer the game "paid" *before*
asking the account, and then answer "paid" anyway when the account said no —
so the player was congratulated, their balance never moved, and the animal was
burned for good. Now nothing is written down until somebody has actually been
paid, and a refusal reaches the player as a refusal with the reason in it. If
a claim cannot be paid, the animal stays claimable.

The other half of the same fault: a legendary is worth 30 and the free daily
limit was 30, so any earning at all earlier in the day made every legendary
impossible. The limit now tops a player up to it instead of refusing them.

**"Balances are not saving."** The service key is missing or wrong. Render →
Environment → check `SUPABASE_SERVICE_KEYS`. The server logs
`could not save acc_... to shard 0` when this is the problem. A claim that
cannot be saved is now reported as not paid rather than pretended, so this
shows up as players being told their wallet could not be reached.

**"The store or the withdrawal screen says it cannot reach the server."** If
this is on a phone with the game installed, it is the old service worker still
in place. It had a list of the server's paths to keep away from, and anything
not on that list — including the store, withdrawals and the live rates — was
answered from its cache or, on a miss, with the game's own page. It now keeps
away from anything that is not one of this site's own files. The fix arrives
with the next update; a player stuck on the old one can close every tab of the
game and open it again.

**"Anybody can edit balances."** Run `schema.sql` again and check every table
shows RLS on in the Table Editor. If you added a policy by hand at some point,
drop it — there should be none.

**"Somebody was paid twice for one animal."** Look the animal up:
`select * from public.claims where creature_key = '...';` There can only be
one row. If money moved twice, the second one came from somewhere other than
`/claim` — check `ledger` for that account.

**"A payout went out but the balance did not drop."** It cannot, if the payout
went through `request_payout` — the two are one statement. A payout row with
no matching negative `ledger` line was made by hand.
