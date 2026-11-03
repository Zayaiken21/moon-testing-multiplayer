-- =====================================================================
-- Voxelia — the whole database, in one file.
--
-- Run this once in the Supabase SQL editor of EVERY project you use as a
-- shard. It is safe to run again: everything is "if not exists", so a second
-- run changes nothing.
--
-- The rule this file exists to enforce:
--
--   The anon key is public. It is in the page, anybody can read it, and it
--   must never be able to touch a balance. Row level security is on for every
--   table here and there are NO policies, which means the anon key can read
--   nothing and write nothing. Only the service_role key gets through, and
--   that key lives in one place: the Render environment, as
--   SUPABASE_SERVICE_KEYS. It never goes in the game page.
--
-- Cents, never dollars. Money is whole cents in a bigint, so nothing is ever
-- lost to a rounding error.
-- =====================================================================

-- ---------------------------------------------------------------- accounts
create table if not exists public.accounts (
  id                 text primary key,              -- acc_ + 16 hex characters
  email              text not null,
  username           text not null,
  password           text not null,                 -- scrypt: salt:hash, never plain
  balance            bigint not null default 0,     -- cents earned and not withdrawn
  caught             integer not null default 0,    -- animals tamed, ever
  today              integer not null default 0,    -- cents earned today
  today_key          text not null default '',      -- the day "today" refers to, YYYY-MM-DD
  subscribed         boolean not null default false,
  subscription_until timestamptz,
  companions         jsonb not null default '[]'::jsonb,
  role               text not null default 'player',-- player | tester | admin
  created_at         timestamptz not null default now(),
  last_seen          timestamptz,
  updated_at         timestamptz,                   -- when the server last wrote this row
  shard              integer not null default 0     -- which project this row lives in
);

-- If you ran an earlier version of this file, these add what was missing.
-- Both are safe to run on a table that already has them.
alter table public.accounts add column if not exists updated_at timestamptz;
alter table public.accounts add column if not exists shard integer not null default 0;
alter table public.accounts add column if not exists last_seen timestamptz;
alter table public.accounts add column if not exists companions jsonb not null default '[]'::jsonb;
alter table public.accounts add column if not exists role text not null default 'player';
alter table public.accounts add column if not exists subscription_until timestamptz;
alter table public.accounts add column if not exists today_key text not null default '';

-- If an older, smaller accounts table is already here (from the first
-- version of this file), these bring it up to date. Each one does nothing at
-- all if the column is already there, so running this file again is always
-- safe and always leaves the table in the shape the server expects.
alter table public.accounts add column if not exists balance            bigint      not null default 0;
alter table public.accounts add column if not exists caught             integer     not null default 0;
alter table public.accounts add column if not exists today              integer     not null default 0;
alter table public.accounts add column if not exists today_key          text        not null default '';
alter table public.accounts add column if not exists subscribed         boolean     not null default false;
alter table public.accounts add column if not exists subscription_until timestamptz;
alter table public.accounts add column if not exists companions         jsonb       not null default '[]'::jsonb;
alter table public.accounts add column if not exists role               text        not null default 'player';
alter table public.accounts add column if not exists created_at         timestamptz not null default now();
alter table public.accounts add column if not exists last_seen          timestamptz;
alter table public.accounts add column if not exists shard              integer     not null default 0;

-- What has already been withdrawn. These are what make the per-day and
-- per-month withdrawal ceilings survive a restart: without them the server
-- forgets every request the moment it redeploys, and the ceilings mean
-- nothing.
alter table public.accounts add column if not exists payout_today       integer     not null default 0;
alter table public.accounts add column if not exists payout_day_key     text        not null default '';
alter table public.accounts add column if not exists payout_month       integer     not null default 0;
alter table public.accounts add column if not exists payout_month_key   text        not null default '';

-- Every creature this person has ever tamed, on any device, in any world.
-- The index belongs to the account, not to a save file: it is a thing you
-- fill in over months, and starting it again with each new world made it
-- pointless.
alter table public.accounts add column if not exists creatures          jsonb       not null default '[]'::jsonb;

-- Who this person is to Stripe. Without these a membership cancelled from
-- the Stripe dashboard could never be matched back to the player it belongs
-- to, so it would stay switched on in the game for ever.
alter table public.accounts add column if not exists stripe_customer     text;
alter table public.accounts add column if not exists stripe_subscription text;
alter table public.accounts add column if not exists trial_used          boolean not null default false;

create index if not exists accounts_stripe_customer_idx
  on public.accounts (stripe_customer);

-- one account per email, and per name, however it was typed
create unique index if not exists accounts_email_key
  on public.accounts (lower(email));
create unique index if not exists accounts_username_key
  on public.accounts (lower(username));
create index if not exists accounts_balance_idx
  on public.accounts (balance desc);

-- ------------------------------------------------------------- creatures
-- One row per animal anybody has ever tamed, anywhere. It is what stops the
-- same animal being sold twice: the primary key IS the animal.
create table if not exists public.claims (
  creature_key text primary key,                    -- seed:spawnKey:species
  account_id   text not null,
  rarity       text not null default 'common',
  cents        integer not null default 0,
  claimed_at   timestamptz not null default now()
);

create index if not exists claims_account_idx
  on public.claims (account_id, claimed_at desc);

-- ---------------------------------------------------------------- payouts
-- A request to be paid, and what happened to it. Nothing here is ever
-- deleted: this is the money trail.
create table if not exists public.payouts (
  id          bigserial primary key,
  account_id  text not null,
  cents       integer not null check (cents > 0),
  method      text not null,                        -- paypal | giftcard | other
  destination text,                                 -- the email or handle paid to
  status      text not null default 'requested',    -- requested | approved | sent | refused
  note        text,
  requested_at timestamptz not null default now(),
  settled_at   timestamptz,
  provider_ref text                                 -- whatever the payment provider calls it
);

-- Columns the withdrawal system added later. Each does nothing if it is
-- already there, so this file stays safe to run again.
alter table public.payouts add column if not exists ref      text;
alter table public.payouts add column if not exists username text;
alter table public.payouts add column if not exists email    text;
alter table public.payouts add column if not exists sent_at  timestamptz;
alter table public.payouts add column if not exists why      text;

create index if not exists payouts_account_idx
  on public.payouts (account_id, requested_at desc);
create index if not exists payouts_ref_idx on public.payouts (ref);
create index if not exists payouts_open_idx
  on public.payouts (status) where status in ('requested', 'approved');

-- ------------------------------------------------------------ the ledger
-- Every movement of money, in or out, so a balance can always be explained.
create table if not exists public.ledger (
  id         bigserial primary key,
  account_id text not null,
  cents      integer not null,                      -- positive in, negative out
  reason     text not null,                         -- tame | payout | adjustment | bonus
  ref        text,                                  -- creature_key, or payout id
  at         timestamptz not null default now()
);

create index if not exists ledger_account_idx
  on public.ledger (account_id, at desc);

-- ----------------------------------------------------------- worlds saved
create table if not exists public.worlds (
  id         text primary key,
  account_id text not null,
  name       text not null,
  seed       text not null,
  mode       text not null default 'survival',
  data       jsonb not null,
  saved_at   timestamptz not null default now()
);

create index if not exists worlds_account_idx
  on public.worlds (account_id, saved_at desc);

-- ================================================================
-- Locking it down.
--
-- Security is ON and there are no policies at all, so the public anon key
-- can do nothing whatsoever with any of this. The service_role key bypasses
-- row level security, which is exactly why it only ever lives on the server.
-- ================================================================
alter table public.accounts enable row level security;
alter table public.claims   enable row level security;
alter table public.payouts  enable row level security;
alter table public.ledger   enable row level security;
alter table public.worlds   enable row level security;

alter table public.accounts force row level security;
alter table public.claims   force row level security;
alter table public.payouts  force row level security;
alter table public.ledger   force row level security;
alter table public.worlds   force row level security;

revoke all on public.accounts from anon, authenticated;
revoke all on public.claims   from anon, authenticated;
revoke all on public.payouts  from anon, authenticated;
revoke all on public.ledger   from anon, authenticated;
revoke all on public.worlds   from anon, authenticated;

-- ================================================================
-- Paying somebody, safely.
--
-- A balance is decided by the database, not by whatever the server happened
-- to believe a moment ago. This does the lot in one statement: it refuses if
-- the balance is short, and it writes the payout row and the ledger line
-- together, so the two can never disagree.
-- ================================================================
create or replace function public.request_payout(
  p_account text,
  p_cents   integer,
  p_method  text,
  p_dest    text
) returns public.payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  have bigint;
  row  public.payouts;
begin
  if p_cents is null or p_cents <= 0 then
    raise exception 'a payout must be for more than nothing';
  end if;

  select balance into have from public.accounts where id = p_account for update;
  if not found then
    raise exception 'no such account';
  end if;
  if have < p_cents then
    raise exception 'balance is % cents, which is less than the % asked for', have, p_cents;
  end if;

  update public.accounts set balance = balance - p_cents where id = p_account;

  insert into public.payouts (account_id, cents, method, destination)
  values (p_account, p_cents, p_method, p_dest)
  returning * into row;

  insert into public.ledger (account_id, cents, reason, ref)
  values (p_account, -p_cents, 'payout', row.id::text);

  return row;
end;
$$;

revoke all on function public.request_payout(text, integer, text, text) from public, anon, authenticated;

-- ================================================================
-- Paying for an animal, once and once only.
--
-- The primary key on claims is what makes this safe: two people taming the
-- same animal at the same moment both try to insert the same row, one wins,
-- and the loser is told so rather than being paid twice.
-- ================================================================
create or replace function public.claim_creature(
  p_account  text,
  p_creature text,
  p_rarity   text,
  p_cents    integer,
  p_cap      integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a     public.accounts;
  today text := to_char(now() at time zone 'utc', 'YYYY-MM-DD');
begin
  if p_cents is null or p_cents <= 0 then
    return jsonb_build_object('ok', false, 'why', 'A common animal. Lovely, but it pays nothing.', 'cents', 0);
  end if;

  select * into a from public.accounts where id = p_account for update;
  if not found then
    return jsonb_build_object('ok', false, 'why', 'No such account.');
  end if;

  if a.today_key is distinct from today then
    update public.accounts set today = 0, today_key = today where id = p_account;
    a.today := 0;
  end if;

  if a.today + p_cents > p_cap then
    return jsonb_build_object('ok', false, 'why', 'Daily limit reached. It resets tomorrow.',
                              'balance', a.balance, 'today', a.today, 'cap', p_cap);
  end if;

  begin
    insert into public.claims (creature_key, account_id, rarity, cents)
    values (p_creature, p_account, p_rarity, p_cents);
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'why', 'Someone else caught this one first.',
                              'balance', a.balance);
  end;

  update public.accounts
     set balance = balance + p_cents,
         today   = today + p_cents,
         caught  = caught + 1
   where id = p_account
  returning * into a;

  insert into public.ledger (account_id, cents, reason, ref)
  values (p_account, p_cents, 'tame', p_creature);

  return jsonb_build_object('ok', true, 'cents', p_cents, 'balance', a.balance,
                            'today', a.today, 'caught', a.caught, 'cap', p_cap);
end;
$$;

revoke all on function public.claim_creature(text, text, text, integer, integer) from public, anon, authenticated;

-- ================================================================
-- What each kind of animal is worth. The server holds the same table; this
-- one is here so a report written straight against the database agrees with
-- the game. Common is zero on purpose.
-- ================================================================
create table if not exists public.rarity_rates (
  rarity text primary key,
  cents  integer not null
);

insert into public.rarity_rates (rarity, cents) values
  ('common',    0),
  ('uncommon',  2),
  ('rare',      6),
  ('exotic',   12),
  ('legendary',30)
on conflict (rarity) do update set cents = excluded.cents;

alter table public.rarity_rates enable row level security;
revoke all on public.rarity_rates from anon, authenticated;

-- ================================================================
-- Two views for the admin page. Neither can be read with the anon key.
-- ================================================================
create or replace view public.account_summary as
  select id, username, email, balance, caught, subscribed, role, created_at, last_seen
    from public.accounts;

create or replace view public.money_owed as
  select sum(balance) as cents_owed, count(*) as accounts
    from public.accounts
   where balance > 0;

revoke all on public.account_summary from anon, authenticated;
revoke all on public.money_owed      from anon, authenticated;

-- ================================================================
-- Who is playing, kept where a restart cannot lose it.
--
-- Render's disk does not survive a redeploy or a spin-down, so counts kept
-- in a file there quietly went back to zero and the admin page looked as
-- though nobody had ever visited. One row per visit, here, instead.
-- ================================================================
create table if not exists public.visits (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  day     date not null default (now() at time zone 'utc')::date,
  device_id text,                                   -- the browser, not a person
  account_id text,                                  -- set once they sign in
  kind    text not null default 'open',             -- open | play | alive
  mode    text,                                     -- survival | creative
  ref     text,                                     -- where they came from
  device  text,                                     -- iPhone, Android, Windows…
  country text,
  installed boolean not null default false          -- added to a home screen
);

create index if not exists visits_day_idx    on public.visits (day desc);
create index if not exists visits_device_idx on public.visits (device_id, day);
create index if not exists visits_at_idx     on public.visits (at desc);

alter table public.visits enable row level security;
revoke all on public.visits from anon, authenticated;

-- A day at a time: visits, how many different browsers, how many signed in.
create or replace view public.visit_days as
  select day,
         count(*)                                   as visits,
         count(distinct device_id)                  as devices,
         count(distinct account_id)                 as accounts,
         count(*) filter (where kind = 'play')      as worlds_entered,
         count(*) filter (where installed)          as from_home_screen
    from public.visits
   group by day
   order by day desc;

-- Where people come from, over the last month.
create or replace view public.visit_sources as
  select coalesce(nullif(ref, ''), 'direct') as ref,
         count(*) as visits,
         count(distinct device_id) as devices
    from public.visits
   where day > (now() at time zone 'utc')::date - 30
   group by 1
   order by visits desc;

-- What they play on.
create or replace view public.visit_devices as
  select coalesce(nullif(device, ''), 'other') as device,
         count(distinct device_id) as devices,
         count(*) as visits
    from public.visits
   where day > (now() at time zone 'utc')::date - 30
   group by 1
   order by devices desc;

revoke all on public.visit_days    from anon, authenticated;
revoke all on public.visit_sources from anon, authenticated;
revoke all on public.visit_devices from anon, authenticated;
