# BudgetFriendly

A single-user personal budgeting app. Node + Express + Postgres on the back,
a no-build responsive PWA on the front. Deploys to Dokku as-is.

It pulls your transactions in, works out what your income is, spots your
recurring charges, sorts spending into categories, and tells you whether the
month and your goals are on track.

**No Plaid.** Transactions come in through pluggable *import adapters* — see
[Getting your transactions in](#getting-your-transactions-in).

---

## Contents

- [Quick start](#quick-start)
- [Testing locally with sample data](#testing-locally-with-sample-data)
- [Getting your transactions in](#getting-your-transactions-in)
  - [Option A — statement upload](#option-a--statement-upload-works-immediately)
  - [Option B — OFX Direct Connect](#option-b--ofx-direct-connect-log-in-and-sync)
  - [Option C — web automation](#option-c--web-automation-not-implemented)
- [Deploying to Dokku](#deploying-to-dokku)
- [How the features work](#how-the-features-work)
- [Environment variables](#environment-variables)
- [API](#api)
- [Project layout](#project-layout)
- [Tests](#tests)
- [Adding another institution](#adding-another-institution)

---

## Quick start

You need Node 20+ and a Postgres database.

```bash
git clone <this repo> && cd budgetFriendly
npm install

cp .env.example .env
# Fill in at minimum: DATABASE_URL, SESSION_SECRET, ENCRYPTION_KEY,
#                     ADMIN_EMAIL, ADMIN_PASSWORD
openssl rand -hex 32     # use for SESSION_SECRET
openssl rand -hex 32     # use for ENCRYPTION_KEY (must be 64 hex chars)

npm run migrate          # creates the schema + seeds starter categories
npm start
```

Open <http://localhost:3000> and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

The single user account is created automatically on first boot. There is no
signup route — deliberately, since this is a one-person app. To create or reset
the account later:

```bash
npm run create-user -- you@example.com 'a-long-password'
```

### Installing it on your iPhone

Open the app in Safari → Share → **Add to Home Screen**. It runs full-screen
with no browser chrome, keeps its own icon, and the service worker caches the
shell so it opens instantly and survives a dead connection. API responses are
never cached — a stale balance is worse than an honest error.

You need HTTPS for the service worker to register (`localhost` is exempt).
Dokku's Let's Encrypt plugin handles this; see below.

---

## Testing locally with sample data

A full local run, start to finish, with no bank involved.

### 1. Get a Postgres

On Windows, the shortest path:

```powershell
winget install PostgreSQL.PostgreSQL.17
```

The installer asks for a **superuser password** — remember it, it goes in
`.env`. Afterwards add the tools to your PATH for the current shell:

```powershell
$env:Path += ';C:\Program Files\PostgreSQL\17\bin'
```

Then create the database:

```bash
createdb -U postgres budgetfriendly
# or: psql -U postgres -c "CREATE DATABASE budgetfriendly;"
```

No appetite for installing a database? A free hosted Postgres (Neon, Supabase)
works identically — paste their connection string into `DATABASE_URL` and set
`PGSSLMODE=require`.

### 2. Fill in `.env`

Copy `.env.example` to `.env` and set five values:

| Variable | What to put |
|---|---|
| `DATABASE_URL` | `postgres://postgres:YOUR_PASSWORD@localhost:5432/budgetfriendly` |
| `SESSION_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ENCRYPTION_KEY` | same command again — a *different* 64-hex value |
| `ADMIN_EMAIL` | whatever you want to log in as |
| `ADMIN_PASSWORD` | your login password, 8+ characters |

Everything else has a working default. The `OFX_*` variables can stay empty —
the app runs fine without them, and statement upload needs none of them.

### 3. Run it

```bash
npm install
npm run migrate      # creates the schema, seeds categories and merchant rules
npm start
```

Open <http://localhost:3000> and sign in.

### 4. Load the sample statement

```bash
npm run make-sample
```

This writes `samples/sample-statement.qfx` and `.csv` covering the last five
months. The data is built to exercise the detectors — biweekly payroll, seven
monthly bills (several with deliberately wobbly billing dates), a utility whose
amount changes every month, monthly transfers to savings, and a few hundred
irregular grocery/dining/shopping charges that should *not* be mistaken for
subscriptions.

In the app: **Settings → Add a connection →** *Statement upload* → name it
anything → **Upload** → pick `samples/sample-statement.qfx`.

You should land on a dashboard with roughly $5,300/month detected income, nine
or so detected subscriptions awaiting your confirmation, spending split across
categories, and five months of trend history. Upload the same file twice to
watch de-duplication work — the second import reports 0 new.

Try the CSV too. It carries no transaction IDs, so it de-duplicates on a
content fingerprint instead; create it as a *separate* connection if you want
both in at once, otherwise the two files collide by design.

### 5. Run the test suites

```bash
npm test
```

Needs no database and no network.

---

## Getting your transactions in

Every bank source implements the same small adapter contract, so the detection,
categorisation and budgeting code never knows or cares where a transaction came
from. Three adapters ship:

| Adapter | Sync on demand | Stores credentials | Status |
|---|---|---|---|
| `file` — statement upload | no | no | **works today** |
| `ofx` — Direct Connect | yes | yes (encrypted) | works if your institution runs an OFX server |
| `web` — browser automation | yes | yes (encrypted) | extension point, not implemented |

### Option A — statement upload (works immediately)

The reliable path, and the one to start with.

1. Sign in to Golden 1 online banking.
2. Open an account and find **Export** / **Download transactions**.
3. Choose **Quicken (QFX)** if offered, otherwise **CSV**.
4. In BudgetFriendly: **Settings → Add a connection →** *Statement upload* →
   **Upload**.

Prefer QFX over CSV. QFX carries the bank's own transaction IDs (`FITID`), so
re-importing overlapping date ranges de-duplicates perfectly. CSV files are
de-duplicated on a content fingerprint (account + date + amount + description),
which is very good but not airtight — two genuinely identical charges on the
same day collapse into one.

The CSV reader sniffs columns by meaning rather than position, so it copes with
the usual variations:

- a `Date` / `Posted Date` / `Transaction Date` column, in `M/D/YYYY`,
  `YYYY-MM-DD` or similar
- either a single signed `Amount` column, or separate `Debit` / `Credit`
  columns
- an optional `Type` column (`DEBIT`/`CREDIT`) used to sign unsigned amounts
- metadata preamble rows above the real header

### Option B — OFX Direct Connect (log in and sync)

This is the "just log in and have my finances there" path, without screen
scraping. OFX Direct Connect is the protocol Quicken and Microsoft Money used,
and many credit unions still run a server for it. You store your credentials
once, and **Sync now** posts a signed OFX request straight to the institution's
endpoint and reads the statement back. It is a real API — nothing breaks when
the bank restyles its website.

**You must supply four institution-specific values.** This repo does not ship
them, because publishing a guessed endpoint for someone's bank is how you end
up posting your credentials somewhere unintended. Get them from one of:

- <https://www.ofxhome.com/> — a community directory; search for your
  institution and read off `URL`, `ORG`, `FID`
- your institution's own Quicken / Direct Connect setup documentation
- calling them and asking for their Direct Connect settings

`OFX_BANK_ID` is your account's routing number, which is printed on your
cheques and shown in online banking.

```bash
OFX_URL=https://...        # the OFX server endpoint
OFX_FI_ORG=...             # the FI "ORG" string
OFX_FI_ID=...              # the FI "FID" number
OFX_BANK_ID=...            # your routing number
```

Then: **Settings → Add a connection →** *Direct Connect (OFX)* → enter your
online-banking username and password → **Sync**.

Things to know before you rely on this:

- **Many institutions gate Direct Connect.** It often has to be enabled on your
  account first, and some issue a **separate Direct Connect PIN** rather than
  accepting your web password. If sign-on fails with OFX code `15500`, that is
  the usual cause.
- **Some institutions have retired OFX entirely.** If yours has, Option A is
  your path. That is not a bug in this app.
- Credentials are encrypted with AES-256-GCM under `ENCRYPTION_KEY` before they
  touch the database. The key lives in the environment, never in Postgres. Lose
  or rotate it and you simply re-enter the credentials.
- Sync pulls `OFX_SYNC_DAYS` (default 90) of history each time and de-duplicates
  on `FITID`, so syncing often is cheap and safe.

**Testing before you point it at a real bank.** There is no public OFX sandbox,
so validate the pipeline with a file instead — it exercises the same parser,
the same persistence, the same detection:

```bash
npm test                 # includes a full OFX 1.x SGML fixture end-to-end
```

Or download one real QFX from online banking and upload it through Option A.
If the transactions land correctly, everything downstream of the adapter is
proven; only the HTTP conversation with the institution is left to verify.

### Option C — web automation (not implemented)

Golden 1 publishes no web API, so the only way to "log in" beyond OFX is to
drive their website in a headless browser. `src/services/importers/web.js` is
the extension point, with the adapter contract and a Playwright sketch in the
comments. It ships disabled.

Read the file before you build it out. The short version of why it is last on
this list:

- it breaks whenever they change their markup, unannounced
- MFA fires on every new "device", so an automated login sits at a challenge
  screen unless you handle the code out-of-band
- bot detection can lock the account rather than just fail the login
- your banking password has to sit on disk in a form the app can replay

If you do implement it, the shortcut worth taking is to scrape only as far as
the **export button**, download the QFX, and hand the bytes to
`parse-ofx.js` — never scrape the transaction table itself.

---

## Deploying to Dokku

```bash
# on the Dokku host
dokku apps:create budgetfriendly
dokku postgres:create budgetfriendly-db
dokku postgres:link budgetfriendly-db budgetfriendly   # sets DATABASE_URL

dokku config:set budgetfriendly \
  NODE_ENV=production \
  SESSION_SECRET="$(openssl rand -hex 32)" \
  ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  ADMIN_EMAIL=you@example.com \
  ADMIN_PASSWORD='a-long-password'

# HTTPS — required for the service worker / home-screen install
dokku domains:set budgetfriendly budget.example.com
dokku letsencrypt:enable budgetfriendly
```

```bash
# from your machine
git remote add dokku dokku@your-host:budgetfriendly
git push dokku master
```

The `Procfile` runs migrations before booting, so a deploy applies schema
changes automatically. Node's buildpack is detected from `package.json`; there
is no build step, because there is no frontend toolchain.

Once it is up, unset `ADMIN_PASSWORD` if you like — the hash is in the database
and the app only reads that variable when no user exists yet.

`/healthz` returns `{"ok":true}` when the database is reachable, for your
monitoring.

---

## How the features work

### Income detection

Inflows are grouped by a normalised merchant key, and each group's gaps between
deposits are measured. A group becomes an income source when the gaps are
regular, the amounts are stable, and there are enough of them. The cadence is
classified (weekly / biweekly / semimonthly / monthly / quarterly / …) and
normalised to a monthly figure — a $2,450 biweekly paycheque is
`2450 × 365.25 / 14 / 12 = $5,308.75` a month, not `$4,900`.

Paydays on the 1st and 15th produce alternating 14/16-day gaps that naively read
as "biweekly". The detector checks whether the dates cluster on two days of the
month and reclassifies them as semimonthly, which is 2×/month rather than
2.17×.

Refunds and reimbursements are excluded by requiring a steadier cadence and a
minimum amount; transfers between your own accounts are excluded by category.

The dashboard estimate is editable — **Budget → Adjust income**. A manual
override wins over detection until you clear it.

### Subscription detection

The same engine pointed at outflows. A recurring charge needs at least three
occurrences (or two identical ones on a common billing cadence), gaps that hold
to a median within tolerance, and an amount that does not vary more than 25%.
Billing dates that wobble around weekends and month lengths still match.

Each detection gets a confidence score from its occurrence count, cadence
regularity and amount stability. You confirm or dismiss each one; your decision
survives every later re-scan, and only the numbers refresh. A detected
subscription that stops appearing is marked **cancelled** automatically —
unless you confirmed it, in which case your call stands.

Transfers and credit-card payments are recurring but are not subscriptions, and
are filtered out by category.

### Categories

Categories are yours to define, with an optional monthly budget each. Fifteen
starter categories and roughly ninety merchant rules are seeded, weighted toward
Sacramento-area merchants (SMUD, Raley's, Golden 1) since that is Golden 1's
footprint.

Rules match on the normalised merchant key and the raw description, by
`contains`, `equals` or `regex`, highest priority first. Re-categorising a
transaction by hand does three things: it locks that row so automation never
touches it again, it writes a high-priority learned rule for that merchant, and
it re-points every other unlocked transaction from the same merchant.

Merchant normalisation is what makes this hold together. `SQ *BLUE BOTTLE 0192
SACRAMENTO CA 09/14` and `POS DEBIT 4412 BLUE BOTTLE #12` both reduce to
`BLUE BOTTLE` — processor prefixes, transaction-type noise, card and store
numbers, dates, phone numbers and location tails are all stripped.

### Goals

Three kinds:

- **save** — a target amount by a target date; progress accrues from
  contributions you log
- **payoff** — same mechanics, framed as paying something down
- **limit** — a spending ceiling on a category, measured against that
  category's actual monthly spend

Each goal reports how much is left, what it needs per month to land on time, and
whether it is on pace — comparing where you are against where even progress
from creation to target date would have put you.

### Monthly budget

The month view shows income (detected or overridden) against spending by
category, what is left to allocate, and what is left to spend. Each category
with a budget gets a pace check: spend-so-far against how far through the month
you actually are, so a 20th-of-the-month reading is not compared to a full
month's budget. Total spend is projected from the same pace.

---

## Environment variables

Every variable is listed with commentary in [`.env.example`](.env.example).
The ones you cannot skip:

| Variable | Why |
|---|---|
| `DATABASE_URL` | Postgres connection. Dokku injects this on link. |
| `SESSION_SECRET` | Signs the session cookie. 32+ random bytes. |
| `ENCRYPTION_KEY` | AES-256-GCM key for stored bank credentials. Exactly 64 hex chars. Only needed for adapters that store credentials. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Creates the single user on first boot. |

The app refuses to start with a missing or too-short `SESSION_SECRET`, or a
malformed `ENCRYPTION_KEY`, rather than starting insecurely.

---

## API

Everything under `/api` except `/api/auth/login` requires the session cookie.

```
POST   /api/auth/login              { email, password }
POST   /api/auth/logout
GET    /api/auth/me
POST   /api/auth/password           { currentPassword, newPassword }

GET    /api/budget/dashboard?month=YYYY-MM     everything the home screen needs
GET    /api/budget/summary?month=YYYY-MM
GET    /api/budget/trend?months=6

GET    /api/transactions?month=&search=&categoryId=&direction=&uncategorised=
POST   /api/transactions            manual entry (cash, etc.)
PATCH  /api/transactions/:id        { categoryId | excluded | notes }
POST   /api/transactions/reanalyze  re-categorise + re-detect everything

GET    /api/categories
POST   /api/categories
PATCH  /api/categories/:id          { name, color, kind, monthlyBudget }
DELETE /api/categories/:id
GET    /api/categories/rules/all
POST   /api/categories/rules        { categoryId, pattern, matchType }
DELETE /api/categories/rules/:id

GET    /api/subscriptions
GET    /api/subscriptions/:id/transactions
PATCH  /api/subscriptions/:id       { status: detected|confirmed|dismissed|cancelled }
POST   /api/subscriptions/detect

GET    /api/income
PUT    /api/income/override         { amount }   — null clears it
PATCH  /api/income/sources/:id
GET    /api/income/sources/:id/transactions

GET    /api/goals?month=YYYY-MM
POST   /api/goals
PATCH  /api/goals/:id
DELETE /api/goals/:id
GET    /api/goals/:id/contributions
POST   /api/goals/:id/contributions { amount, occurredOn, note }

GET    /api/connections
GET    /api/connections/adapters
GET    /api/connections/runs
POST   /api/connections             { name, adapter, username?, password? }
POST   /api/connections/:id/sync
POST   /api/connections/:id/upload  multipart, field name "file"
POST   /api/connections/:id/discover
PUT    /api/connections/:id/credentials
DELETE /api/connections/:id

GET    /api/settings
PUT    /api/settings/:key
```

---

## Project layout

```
src/
  server.js                    express app, security headers, static + SPA fallback
  config.js                    env parsing and validation
  db/
    index.js                   pool, query helpers, numeric parsing
    migrate.js                 forward-only migration runner
    migrations/*.sql
  middleware/auth.js           JWT cookie sessions, login throttling, first-boot user
  routes/                      one router per resource
  services/
    importers/
      index.js                 ADAPTER REGISTRY + persistence + dedupe
      file.js                  CSV / QFX / OFX upload
      ofx.js                   OFX Direct Connect client
      web.js                   browser-automation extension point (stub)
      parse-csv.js             RFC4180 reader + bank-column sniffing
      parse-ofx.js             OFX 1.x SGML + 2.x XML parser
    detect/
      recurrence.js            THE detection engine (income and subscriptions)
      index.js                 reconciles findings into the database
      categorize.js            rule matching, manual override, rule learning
    budget.js                  monthly summary, trend, goal progress
  utils/                       merchant normalisation, money, dates, crypto
public/                        the entire frontend: 4 files + icons
test/                          logic and HTTP suites
scripts/
  create-user.js
  make-icons.js                dependency-free PNG generator for the PWA icons
```

The frontend is deliberately plain: `index.html`, `app.js`, `styles.css`,
`sw.js`. No build step, no bundler, no external requests at runtime — the
Content-Security-Policy blocks them, and there is nothing to block.

---

## Tests

```bash
npm test
```

Two suites, no test framework, no database required:

- `test/logic.test.js` — CSV parsing across three bank export shapes, OFX 1.x
  SGML parsing including an error response, and the recurrence engine against
  synthetic series (monthly subs with jittered billing dates, biweekly payroll,
  semimonthly payroll, and irregular spending that must *not* be flagged).
- `test/http.test.js` — boots the real Express app against a stubbed database
  and checks route registration, the auth gate, login and session cookies,
  security headers, static and SPA serving, and the adapter registry.

---

## Adding another institution

Nothing in the app is Golden 1-specific — the institution only shows up in
config. To add a second bank:

- **Another OFX institution:** create a second connection with its own
  credentials. Per-connection OFX settings override the environment defaults
  (see `settingsFor()` in `src/services/importers/ofx.js`), so two institutions
  with different endpoints coexist.
- **A bank with no OFX:** use the file adapter; each connection keeps its own
  account, and uploads merge into it.
- **Something else entirely:** write an adapter. Implement `fetch(connection,
  options)` returning `{ accounts, transactions }` in the normalised shape
  documented at the top of `src/services/importers/index.js`, then `register()`
  it. Dedupe, categorisation, detection and every view come along for free.
