# BudgetFriendly

A single-user personal finance app, laid out like Monarch Money, fed by the
statements you download from your bank. Node + Express + Postgres, a no-build
responsive PWA, deployed on Dokku.

- **Dashboard** — spending this month against last month, budget progress,
  upcoming bills and paychecks, recent transactions, accounts, goals
- **Paycheck** — how much is left to spend before payday, a recommended
  spending budget per paycheck, and what a budget of your own does to your goals
- **Transactions** — grouped by day, searchable and filterable; open one to
  change its category, teach a merchant rule, add a note, or hide it
- **Cash Flow** — income against expenses by month, savings rate, and a
  breakdown by category, group or merchant that drills into transactions
- **Budget** — a monthly amount per category, grouped, with spent and remaining
- **Recurring** — detected bills and paychecks as a list or calendar, each
  marked paid, due, upcoming or not found
- **Accounts** and **Goals**

No bank logins, no aggregator. You download a statement and upload it.

---

## Contents

- [Getting your transactions in](#getting-your-transactions-in)
- [Running it locally](#running-it-locally)
- [Deploying to Dokku](#deploying-to-dokku)
- [Starting over](#starting-over)
- [How it works](#how-it-works)
- [Tests](#tests)
- [Environment variables](#environment-variables)
- [API](#api)
- [Project layout](#project-layout)

---

## Getting your transactions in

1. Sign in to Golden 1 online banking.
2. Open an account and click the download (cloud) icon.
3. Choose **OFX** (or **Quicken**) and a date range. The first time, take as
   much history as it allows — recurring detection needs at least three months.
4. In BudgetFriendly, click **Upload statement** (or drag the file onto the
   window on desktop).

Upload overlapping date ranges freely. Every OFX transaction carries the bank's
own ID, so anything already imported is skipped. New transactions arrive marked
**Needs review**.

CSV works too, but prefer OFX: CSV has no transaction IDs, so duplicates are
detected by date, amount and description instead.

**Why not automatic sync?** Golden 1 retired OFX Direct Connect in favour of
Quicken's aggregator-only Express Web Connect, which third-party apps cannot
use. The adapter code for Direct Connect is still in
`src/services/importers/ofx.js` for institutions that support it, but the app
only exposes uploads.

---

## Running it locally

You need Node 24 and Postgres with a **UTF8** database (category names use emoji).

```bash
npm install
cp .env.example .env        # set DATABASE_URL, SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
npm run migrate
npm start                   # http://localhost:3000
```

Your login is created from `ADMIN_EMAIL` / `ADMIN_PASSWORD` the first time the
app starts. There is no signup. To create or reset it later:
`npm run create-user -- you@example.com 'a-long-password'`.

`npm run make-sample` writes `samples/sample-statement.qfx`: five months of
synthetic transactions with a biweekly paycheck, monthly bills and irregular
spending, for trying the app without real data.

---

## Deploying to Dokku

```bash
# on the Dokku host
dokku apps:create budgetfriendly
sudo dokku plugin:install https://github.com/dokku/dokku-postgres.git postgres
dokku postgres:create budgetfriendly_db
dokku postgres:link budgetfriendly_db budgetfriendly       # sets DATABASE_URL

dokku config:set --no-restart budgetfriendly \
  NODE_ENV=production TRUST_PROXY=2 \
  SESSION_SECRET="$(openssl rand -hex 32)" ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  ADMIN_EMAIL='you@example.com' ADMIN_PASSWORD='a-long-password'
```

```bash
# from your machine
git remote add dokku dokku@your-host:budgetfriendly
git push dokku main
```

Migrations run when the app boots, so a deploy applies schema changes by
itself. `app.json` adds a `/healthz` health check, so a deploy that can't reach
the database never replaces a working one.

### HTTPS with Tailscale

The session cookie is HTTPS-only in production, and the iPhone home-screen
install needs HTTPS too. On a homelab, Tailscale provides it without exposing
anything to the internet:

```bash
curl -fsSL https://tailscale.com/install.sh | sh && tailscale up
# admin console → DNS: enable MagicDNS and HTTPS Certificates
dokku domains:set budgetfriendly <machine>.<tailnet>.ts.net
tailscale serve --bg http://127.0.0.1:80
```

`TRUST_PROXY=2` accounts for the two proxies in that chain (Tailscale, then
Dokku's nginx). On iPhone: connect Tailscale, open the URL in Safari, then
Share → Add to Home Screen.

---

## Starting over

To erase all financial data and keep your login:

```bash
dokku run budgetfriendly npm run reset-data -- --yes
```

This removes transactions, accounts, upload history, recurring items, budgets,
goals, categories and rules, then restores the default categories and rules.
It cannot be undone; upload your statements again afterwards.

---

## How it works

### Import

An upload is parsed (OFX 1.x SGML, OFX 2.x XML, or CSV), then everything else
happens in **one database transaction**: insert new transactions in a single
statement, normalise merchant names, categorise, and detect recurring series.
An import lands completely or not at all. Every attempt is logged under
Accounts → Upload history.

### Merchant names

Bank descriptions are noisy — Golden 1 writes `WITHDRAWAL AT SQ *BLUE BOTTLE`
and `CHECKING DEPOSIT-ACH-1064831 EMPLOYER`, cut at 32 characters. Wrappers,
payment-processor prefixes, card and store numbers, phone numbers, dates and
location tails are stripped to a stable merchant key. When normalisation
improves, existing transactions are updated on the next import.

### Categories and rules

Categories live in groups (Income, Housing, Bills & Utilities, Food & Dining…).
Each group is income, spending, or transfer; transfers count toward nothing.
About 200 built-in rules match common merchants. Change a transaction's
category and keep **Always categorize** ticked, and the app writes a rule for
that merchant, moves its other transactions, and applies the rule to future
uploads. Manually categorised transactions are never re-categorised
automatically.

### Paychecks and bills

Transactions are grouped by merchant, and the gaps between them are measured. A
series becomes recurring when it has at least three occurrences, a regular
cadence (weekly through yearly, including twice-monthly paydays) and a steady
amount. Paychecks may vary much more than bills, because hours and overtime
move them. Detected paychecks are categorised as Paychecks, and confirmed or
dismissed items keep that decision across later imports. On the Recurring
calendar each expected date is matched to real transactions within five days.

### Budgets

Budgets are per category per month, and **carry forward**: $450 for groceries
set in September applies to every month after until you change it. Planned
income is the sum of any income budgets you set, otherwise your detected
paychecks. Amounts are net within a category, so a refund in Shopping reduces
Shopping rather than counting as income.

### Paycheck plan

The plan answers "how much can I spend before payday?" It works per paycheck,
using your detected pay schedule (the largest income source sets the paydays;
other income is spread across them) or a paycheck you enter yourself.

```
recommended spending = paycheck − bills − goals
```

- **Bills** are your active recurring bills, averaged: a $1,300 monthly rent on
  a biweekly paycheck sets aside $600 every payday, so the recommendation is the
  same whether or not rent lands in this pay period.
- **Goals** are savings and payoff goals with a target date: what's left,
  divided by the paychecks until that date. Goals without a date are left out.

**Left to spend** is the budget minus everyday spending since the last payday:
spending categories, net of refunds, not counting bill payments. A charge from a
bill's merchant within 25% of the bill's amount counts as that bill.

You can set your own spending amount instead. Whatever is left after bills and
spending goes to goals in proportion to what each needs, and each goal's
finishing date is recalculated at that rate — spending $100 more a paycheck
than recommended shows exactly which goals move and by how long. The page
previews an amount as you type and only saves when you confirm. If your goals
need more than is left after bills, the recommendation is $0 and the plan shows
the shortfall. Settings are stored under the `paycheck_plan` key.

---

## Tests

```bash
npm test                  # parsers, merchant names, detection, recurring dates, HTTP wiring
npm run test:integration  # against real Postgres — see below
```

The integration suite needs a disposable UTF8 database whose name contains
`test`; it drops and recreates that database's schema:

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/budgetfriendly_test npm run test:integration
```

It covers upgrading an existing database through every migration, the reset
script, rollback, upload and re-upload, categorisation and learned rules,
paycheck and bill detection, recurring matching, budget carry-forward, cash-flow
totals, and rejecting a bad file.

---

## Environment variables

Every variable is described in [`.env.example`](.env.example).

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (Dokku sets it on link). Must be a UTF8 database. |
| `SESSION_SECRET` | Signs the session cookie. 32+ random bytes. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Create your login on first boot. |
| `TRUST_PROXY` | Reverse proxies in front of the app: `1` for Dokku alone, `2` behind Tailscale. |
| `ENCRYPTION_KEY` | Only for the Direct Connect adapter's stored credentials; not used by uploads. |

---

## API

Everything under `/api` except `/api/auth/login` requires the session cookie.

```
POST   /api/auth/login | /api/auth/logout | /api/auth/password     GET /api/auth/me

GET    /api/dashboard?month=YYYY-MM
POST   /api/import                      multipart, field "file"
GET    /api/import/history

GET    /api/accounts                    PATCH /api/accounts/:id { name, archived }
GET    /api/transactions?month|start|end|search|type|categoryId|groupId|merchantKey|accountId|review|limit|offset
GET    /api/transactions/:id            PATCH { categoryId, applyToMerchant, notes, excluded, needsReview }
POST   /api/transactions/review         { ids } | { all: true }

GET    /api/categories                  POST { name, emoji, groupId }   PATCH/DELETE /:id
GET    /api/categories/rules/all        DELETE /api/categories/rules/:id
GET    /api/budget?month=YYYY-MM        PUT /api/budget/:categoryId { month, amount }
GET    /api/plan?spend=N|recommended    preview without saving
PATCH  /api/plan                        { spendingBudget: N|null, paycheck: { amount, cadence, nextPayday }|null }
GET    /api/cashflow?months=12&by=category|group|merchant&start&end
GET    /api/recurring?month=YYYY-MM     PATCH /api/recurring/:expense|income/:id { status }
GET    /api/goals                       POST, PATCH/DELETE /:id, POST /:id/contributions
GET    /api/settings
```

---

## Project layout

```
src/
  server.js, config.js
  db/            pool + transaction helpers, migrations (SQL and JS), category seed
  middleware/    session auth, login throttling
  routes/        one router per screen / resource
  services/
    importers/   adapter registry, file + OFX parsers, persistence
    detect/      recurrence engine, categorisation, reconciliation
    budget.js    budget, cash flow, breakdowns, spending pace, goals
    plan/        paycheck plan: pay periods, recommended spending, goal impact (math.js is pure)
    recurring.js calendar projection and paid/due matching
    transactions.js, accounts.js
public/
  index.html, styles.css, sw.js, manifest.webmanifest
  js/            main.js (shell), api, format, ui, charts, views/*
scripts/         create-user, reset-data, make-sample-statement, make-icons
test/            logic, http, integration
```

The frontend has no build step and makes no external requests; the
Content-Security-Policy allows only the app's own origin.
