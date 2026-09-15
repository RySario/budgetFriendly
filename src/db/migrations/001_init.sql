-- Core schema. Money is numeric(14,2). Transaction amount sign convention:
--   positive = money into the account (income, refunds, transfers in)
--   negative = money out of the account (spending, payments, transfers out)
-- Every importer normalises to that before insert.

CREATE TABLE IF NOT EXISTS users (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- Single-user app: one global key/value bag for preferences and overrides.
CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_connections (
  id              bigserial PRIMARY KEY,
  name            text NOT NULL,
  adapter         text NOT NULL,                 -- 'file' | 'ofx' | 'web'
  institution_id  text,
  credentials_enc text,                          -- AES-256-GCM blob, nullable
  status          text NOT NULL DEFAULT 'active',-- active | error | disabled
  last_sync_at    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  id                bigserial PRIMARY KEY,
  connection_id     bigint REFERENCES bank_connections(id) ON DELETE SET NULL,
  external_id       text NOT NULL,               -- adapter-scoped account id
  name              text NOT NULL,
  official_name     text,
  type              text,                        -- depository | credit | loan | ...
  subtype           text,                        -- checking | savings | ...
  mask              text,
  currency          text NOT NULL DEFAULT 'USD',
  current_balance   numeric(14,2),
  available_balance numeric(14,2),
  balance_as_of     timestamptz,
  archived          boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_id)
);

CREATE TABLE IF NOT EXISTS categories (
  id             bigserial PRIMARY KEY,
  name           text NOT NULL UNIQUE,
  kind           text NOT NULL DEFAULT 'spending', -- spending | income | transfer
  color          text NOT NULL DEFAULT '#6b7280',
  monthly_budget numeric(14,2),
  is_system      boolean NOT NULL DEFAULT false,
  sort_order     integer NOT NULL DEFAULT 100,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Merchant -> category rules, highest priority wins.
CREATE TABLE IF NOT EXISTS category_rules (
  id          bigserial PRIMARY KEY,
  category_id bigint NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  match_type  text NOT NULL DEFAULT 'contains',  -- contains | equals | regex
  pattern     text NOT NULL,
  priority    integer NOT NULL DEFAULT 100,
  auto        boolean NOT NULL DEFAULT false,    -- true = learned from an override
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS category_rules_priority_idx ON category_rules (priority DESC, id);
CREATE UNIQUE INDEX IF NOT EXISTS category_rules_unique_idx
  ON category_rules (category_id, match_type, pattern);

CREATE TABLE IF NOT EXISTS transactions (
  id              bigserial PRIMARY KEY,
  account_id      bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  external_id     text,
  import_hash     text NOT NULL UNIQUE,          -- dedupe across re-imports
  posted_on       date NOT NULL,
  amount          numeric(14,2) NOT NULL,
  description     text NOT NULL,
  merchant_raw    text,
  merchant_key    text NOT NULL,                 -- normalised merchant
  pending         boolean NOT NULL DEFAULT false,
  category_id     bigint REFERENCES categories(id) ON DELETE SET NULL,
  category_locked boolean NOT NULL DEFAULT false,-- true = manual override, never re-categorise
  excluded        boolean NOT NULL DEFAULT false,-- keep out of budget math
  notes           text,
  source          text NOT NULL DEFAULT 'file',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transactions_posted_idx   ON transactions (posted_on DESC);
CREATE INDEX IF NOT EXISTS transactions_merchant_idx ON transactions (merchant_key);
CREATE INDEX IF NOT EXISTS transactions_category_idx ON transactions (category_id);
CREATE INDEX IF NOT EXISTS transactions_account_idx  ON transactions (account_id);

-- Detected recurring OUTflows.
CREATE TABLE IF NOT EXISTS subscriptions (
  id             bigserial PRIMARY KEY,
  merchant_key   text NOT NULL UNIQUE,
  name           text NOT NULL,
  amount         numeric(14,2) NOT NULL,
  cadence        text NOT NULL,                  -- weekly | biweekly | monthly | ...
  interval_days  integer NOT NULL,
  monthly_amount numeric(14,2) NOT NULL,
  status         text NOT NULL DEFAULT 'detected', -- detected | confirmed | dismissed
  occurrences    integer NOT NULL DEFAULT 0,
  confidence     numeric(4,3) NOT NULL DEFAULT 0,
  first_seen_on  date,
  last_charged_on date,
  next_expected_on date,
  category_id    bigint REFERENCES categories(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Detected recurring INflows.
CREATE TABLE IF NOT EXISTS income_sources (
  id             bigserial PRIMARY KEY,
  merchant_key   text NOT NULL UNIQUE,
  name           text NOT NULL,
  amount         numeric(14,2) NOT NULL,
  cadence        text NOT NULL,
  interval_days  integer NOT NULL,
  monthly_amount numeric(14,2) NOT NULL,
  status         text NOT NULL DEFAULT 'detected', -- detected | confirmed | dismissed
  occurrences    integer NOT NULL DEFAULT 0,
  confidence     numeric(4,3) NOT NULL DEFAULT 0,
  first_seen_on  date,
  last_seen_on   date,
  next_expected_on date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS goals (
  id                  bigserial PRIMARY KEY,
  name                text NOT NULL,
  kind                text NOT NULL DEFAULT 'save', -- save | payoff | limit
  target_amount       numeric(14,2) NOT NULL,
  starting_amount     numeric(14,2) NOT NULL DEFAULT 0,
  target_date         date,
  category_id         bigint REFERENCES categories(id) ON DELETE SET NULL,
  monthly_contribution numeric(14,2),
  status              text NOT NULL DEFAULT 'active', -- active | achieved | archived
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS goal_contributions (
  id          bigserial PRIMARY KEY,
  goal_id     bigint NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  amount      numeric(14,2) NOT NULL,
  occurred_on date NOT NULL DEFAULT CURRENT_DATE,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS goal_contributions_goal_idx ON goal_contributions (goal_id, occurred_on DESC);

CREATE TABLE IF NOT EXISTS sync_runs (
  id            bigserial PRIMARY KEY,
  connection_id bigint REFERENCES bank_connections(id) ON DELETE CASCADE,
  adapter       text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL DEFAULT 'running', -- running | ok | error
  imported      integer NOT NULL DEFAULT 0,
  duplicates    integer NOT NULL DEFAULT 0,
  message       text
);
