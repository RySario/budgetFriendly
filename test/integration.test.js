'use strict';
/* Integration tests against a real Postgres. They exercise the paths that
 * stubs cannot: SQL, migrations (including upgrading an existing database),
 * type parsing, batched writes and transactions.
 *
 *   TEST_DATABASE_URL=postgres://.../budgetfriendly_test npm run test:integration
 *
 * The suite DROPS AND RECREATES the public schema of that database, so it
 * refuses to run unless the database name contains "test". Without
 * TEST_DATABASE_URL it skips.
 */

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.log('SKIPPED integration tests (set TEST_DATABASE_URL to a disposable database)');
  process.exit(0);
}
if (!/test/i.test(new URL(url).pathname)) {
  console.error('Refusing to run: the TEST_DATABASE_URL database name must contain "test" — this suite wipes it.');
  process.exit(1);
}

process.env.DATABASE_URL = url;
process.env.SESSION_SECRET = 's'.repeat(40);
process.env.NODE_ENV = 'test';
process.env.PGSSLMODE = '';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'src', 'db', 'migrations');

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  -> ${detail}`}`);
  if (!cond) failures += 1;
}
const close = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

// --- fixture ----------------------------------------------------------------

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(Date.now() - n * 86400000));
const today = iso(new Date());
const monthKey = today.slice(0, 7);
const shiftMonth = (key, delta) => {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
};

function fixtureTransactions() {
  const list = [];
  let n = 1;
  const add = (date, amount, name) => list.push({ date, amount, name, fitid: `FIT${n++}` });

  // Biweekly paycheck, varying amount, no "PAYROLL" in the name: only detection
  // can recognise it.
  for (let i = 0; i < 10; i += 1) add(daysAgo(3 + i * 14), 2450 + (i % 3) * 180, 'CHECKING DEPOSIT-ACH-1 ACME INC');
  for (let i = 0; i < 5; i += 1) add(daysAgo(5 + i * 30), -22.99, 'WITHDRAWAL AT NETFLIX.COM');
  for (let i = 0; i < 5; i += 1) add(daysAgo(9 + i * 30), -400, 'WITHDRAWAL AT G1 ONLINE TRANSFER');
  // Weekly groceries with irregular amounts: must not become a "subscription".
  for (let i = 0; i < 20; i += 1) add(daysAgo(1 + i * 7), -(40 + ((i * 37) % 90)), 'WITHDRAWAL AT SAFEWAY #1234');
  add(daysAgo(12), -63.1, 'WITHDRAWAL AT TARGET 00021456');
  add(daysAgo(10), 63.1, 'WITHDRAWAL REVERSAL AT TARGET 00021456');
  add(daysAgo(20), -12.5, 'WITHDRAWAL AT MYSTERY SHOP 991');
  return list;
}

function buildOfx(list, { acctId = '9876543210', balance = 4321.09 } = {}) {
  const d = (s) => `${s.replace(/-/g, '')}120000[0:GMT]`;
  return [
    'OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:103', 'SECURITY:NONE', 'ENCODING:USASCII', '',
    '<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS></SONRS></SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STMTRS><CURDEF>USD',
    `<BANKACCTFROM><BANKID>321175261<ACCTID>${acctId}<ACCTTYPE>CHECKING</BANKACCTFROM>`,
    '<BANKTRANLIST>',
    ...list.map((t) =>
      `<STMTTRN><TRNTYPE>${t.amount < 0 ? 'DEBIT' : 'CREDIT'}<DTPOSTED>${d(t.date)}` +
      `<TRNAMT>${t.amount.toFixed(2)}<FITID>${t.fitid}<NAME>${t.name.slice(0, 32)}</STMTTRN>`),
    '</BANKTRANLIST>',
    `<LEDGERBAL><BALAMT>${balance}<DTASOF>${d(today)}</LEDGERBAL>`,
    '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
  ].join('\r\n');
}

// --- helpers ------------------------------------------------------------------

async function rawClient() {
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
}

async function main() {
  // --- 1. Upgrade path: a database on 001-003 holding old-style data --------
  let raw = await rawClient();
  await raw.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await raw.query(`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const f of ['001_init.sql', '002_seed_categories.sql', '003_golden1_transfer_rule.sql']) {
    await raw.query(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    await raw.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
  }
  await raw.query(`INSERT INTO bank_connections (name, adapter) VALUES ('Old uploads', 'file')`);
  await raw.query(`INSERT INTO accounts (connection_id, external_id, name) VALUES (1, 'old', 'Old account')`);
  await raw.query(
    `INSERT INTO transactions (account_id, import_hash, posted_on, amount, description, merchant_key, category_id)
     SELECT 1, 'old-hash', CURRENT_DATE, -5, 'OLD', 'OLD', id FROM categories WHERE name = 'Groceries'`
  );
  await raw.end();

  const db = require('../src/db');
  const { run: migrate } = require('../src/db/migrate');
  await migrate();

  const groups = await db.many('SELECT name, kind FROM category_groups ORDER BY sort_order');
  check('upgrade: category groups seeded', groups.length === 13, groups.length);
  const groceries = await db.one(
    `SELECT c.id, c.emoji, g.name AS group_name FROM categories c JOIN category_groups g ON g.id = c.group_id WHERE c.name = 'Groceries'`
  );
  check('upgrade: categories grouped with emoji', groceries && groceries.group_name === 'Food & Dining' && groceries.emoji === '🛒',
    JSON.stringify(groceries));
  const oldTxn = await db.one(`SELECT category_id FROM transactions WHERE import_hash = 'old-hash'`);
  check('upgrade: old transaction kept, category cleared for re-categorising', oldTxn && oldTxn.category_id === null,
    JSON.stringify(oldTxn));
  const g1Rule = await db.one(
    `SELECT r.priority FROM category_rules r JOIN categories c ON c.id = r.category_id
      WHERE r.pattern = 'G1 ONLINE' AND c.name = 'Transfer'`
  );
  check('upgrade: Golden 1 transfer rule present at priority 300', g1Rule && g1Rule.priority === 300, JSON.stringify(g1Rule));
  const applied = await db.many('SELECT name FROM schema_migrations ORDER BY name');
  check('upgrade: migration 004 recorded', applied.some((r) => r.name === '004_monarch_redesign.js'),
    applied.map((r) => r.name).join(','));

  // --- 2. Reset script keeps the login, wipes and reseeds everything else --
  await db.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)',
    ['me@example.com', bcrypt.hashSync('pw-for-tests-123', 4)]);
  const refused = spawnSync(process.execPath, ['scripts/reset-data.js'], { cwd: ROOT, env: process.env, encoding: 'utf8' });
  check('reset: refuses without --yes', refused.status === 1, refused.status);
  const reset = spawnSync(process.execPath, ['scripts/reset-data.js', '--yes'], { cwd: ROOT, env: process.env, encoding: 'utf8' });
  check('reset: exits cleanly', reset.status === 0, `${reset.status} ${reset.stderr}`);
  const afterReset = await db.one(
    `SELECT (SELECT COUNT(*)::int FROM transactions) AS t, (SELECT COUNT(*)::int FROM accounts) AS a,
            (SELECT COUNT(*)::int FROM users) AS u, (SELECT COUNT(*)::int FROM categories) AS c`
  );
  check('reset: data wiped, login kept, categories reseeded',
    afterReset.t === 0 && afterReset.a === 0 && afterReset.u === 1 && afterReset.c > 40, JSON.stringify(afterReset));

  // --- 3. Transactions roll back as a unit ------------------------------
  await db.tx(async (q) => {
    await q.query(`INSERT INTO settings (key, value) VALUES ('rollback-probe', '1')`);
    throw new Error('boom');
  }).catch(() => {});
  const probe = await db.one(`SELECT 1 AS x FROM settings WHERE key = 'rollback-probe'`);
  check('db.tx rolls back on error', probe === null, JSON.stringify(probe));

  // --- 4. HTTP against the real app ---------------------------------------
  const { app } = require('../src/server');
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (p, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    let body = opts.body;
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
    const res = await fetch(base + p, { method: opts.method || 'GET', headers, body });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
  };
  const upload = (text, name = 'statement.qfx') => {
    const form = new FormData();
    form.append('file', new Blob([text], { type: 'application/x-ofx' }), name);
    return call('/api/import', { method: 'POST', body: form });
  };

  try {
    const login = await call('/api/auth/login', { method: 'POST', json: { email: 'me@example.com', password: 'pw-for-tests-123' } });
    check('login', login.status === 200, login.status);

    const fixture = fixtureTransactions();
    const ofx = buildOfx(fixture);

    const t0 = Date.now();
    const first = await upload(ofx);
    const elapsed = Date.now() - t0;
    check('import: succeeds', first.status === 200, JSON.stringify(first.body));
    const r1 = first.body.result || {};
    check('import: every transaction new', r1.imported === fixture.length && r1.duplicates === 0,
      `${r1.imported} new, ${r1.duplicates} dup of ${fixture.length}`);
    const fixtureDates = fixture.map((t) => t.date).sort();
    check('import: reports date range and account', r1.firstOn === fixtureDates[0] && r1.lastOn === fixtureDates[fixtureDates.length - 1]
      && r1.accounts && r1.accounts.length === 1, JSON.stringify({ firstOn: r1.firstOn, lastOn: r1.lastOn, accounts: r1.accounts }));
    check(`import: fast (${elapsed} ms)`, elapsed < 5000, `${elapsed} ms`);

    const cat = async (namePattern) => db.many(
      `SELECT c.name, COUNT(*)::int AS n FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.description LIKE $1 GROUP BY c.name`, [namePattern]
    );
    const only = (rows, name) => rows.length === 1 && rows[0].name === name;
    check('categorise: Netflix -> Subscriptions & Streaming', only(await cat('%NETFLIX%'), 'Subscriptions & Streaming'), JSON.stringify(await cat('%NETFLIX%')));
    check('categorise: Golden 1 transfer -> Transfer', only(await cat('%G1 ONLINE%'), 'Transfer'), JSON.stringify(await cat('%G1 ONLINE%')));
    check('categorise: Safeway -> Groceries', only(await cat('%SAFEWAY%'), 'Groceries'), JSON.stringify(await cat('%SAFEWAY%')));
    check('categorise: detected paycheck -> Paychecks', only(await cat('%ACME%'), 'Paychecks'), JSON.stringify(await cat('%ACME%')));
    check('categorise: unknown merchant -> Uncategorized', only(await cat('%MYSTERY%'), 'Uncategorized'), JSON.stringify(await cat('%MYSTERY%')));

    const review = await call('/api/transactions?review=true&limit=500');
    check('review: every imported transaction flagged', review.body.totals.count === fixture.length, review.body.totals.count);

    // Re-import: nothing new, and nothing already decided gets undone.
    const second = await upload(ofx);
    check('re-import: all duplicates', second.body.result && second.body.result.imported === 0
      && second.body.result.duplicates === fixture.length, JSON.stringify(second.body));

    // Recurring
    const { recurringInRange } = require('../src/services/recurring');
    const window = await recurringInRange(daysAgo(60), today);
    const names = window.series.map((s) => `${s.type}:${s.name}`);
    check('recurring: paycheck and Netflix found', names.includes('income:Acme Inc') && names.some((n) => /^expense:Netflix/.test(n)),
      names.join(', '));
    check('recurring: groceries and transfers are not bills',
      !names.some((n) => /Safeway|G1 Online/i.test(n)), names.join(', '));
    const paid = window.entries.filter((e) => e.state === 'paid');
    check('recurring: past occurrences matched as paid',
      paid.some((e) => e.type === 'expense') && paid.some((e) => e.type === 'income') && paid.every((e) => e.paidOn),
      JSON.stringify(window.entries.map((e) => [e.name, e.date, e.state])));
    const month = await call(`/api/recurring?month=${monthKey}`);
    check('recurring: month endpoint', month.status === 200 && Array.isArray(month.body.entries), month.status);

    // Budget carries forward
    const put = await call(`/api/budget/${groceries.id}`, { method: 'PUT', json: { month: monthKey, amount: 500 } });
    check('budget: set', put.status === 200 && put.body.summary.expenses.budgeted === 500, JSON.stringify(put.body.summary));
    const findCat = (b, id) => b.groups.flatMap((g) => g.categories).find((c) => c.id === id);
    const next = await call(`/api/budget?month=${shiftMonth(monthKey, 1)}`);
    check('budget: carries into next month', findCat(next.body, groceries.id).budget === 500, JSON.stringify(findCat(next.body, groceries.id)));
    const prev = await call(`/api/budget?month=${shiftMonth(monthKey, -1)}`);
    check('budget: absent before it was set', findCat(prev.body, groceries.id).budget === null, JSON.stringify(findCat(prev.body, groceries.id)));
    const transferCat = await db.one(`SELECT id FROM categories WHERE name = 'Transfer'`);
    const bad = await call(`/api/budget/${transferCat.id}`, { method: 'PUT', json: { month: monthKey, amount: 10 } });
    check('budget: transfers cannot be budgeted', bad.status === 400, bad.status);
    const cur = await call(`/api/budget?month=${monthKey}`);
    check('budget: summary income planned from detection',
      cur.body.summary.income.planned > 4000 && close(cur.body.summary.leftToBudget, cur.body.summary.income.planned - 500),
      JSON.stringify(cur.body.summary));

    // Cash flow: transfers excluded, refunds net out
    const flow = await call('/api/cashflow?months=12');
    const expectIncome = fixture.filter((t) => /ACME/.test(t.name)).reduce((a, t) => a + t.amount, 0);
    const expectExpenses = -fixture.filter((t) => !/ACME|G1 ONLINE/.test(t.name)).reduce((a, t) => a + t.amount, 0);
    check('cashflow: 12 months', flow.body.series.length === 12, flow.body.series.length);
    check('cashflow: income is paychecks only', close(flow.body.totals.income, expectIncome), `${flow.body.totals.income} vs ${expectIncome}`);
    check('cashflow: expenses exclude transfers, net of refunds', close(flow.body.totals.expenses, expectExpenses),
      `${flow.body.totals.expenses} vs ${expectExpenses.toFixed(2)}`);
    const topSpend = flow.body.breakdown.spending.items[0];
    check('cashflow: groceries lead the breakdown', topSpend && topSpend.name === 'Groceries', JSON.stringify(topSpend));
    const byMerchant = await call('/api/cashflow?months=12&by=merchant');
    check('cashflow: merchant breakdown', byMerchant.body.breakdown.spending.items.some((i) => i.name === 'Safeway'),
      JSON.stringify(byMerchant.body.breakdown.spending.items.map((i) => i.name)));

    // Recategorise with a learned rule
    const safeway = await call('/api/transactions?search=safeway&limit=500');
    const target = safeway.body.transactions[0];
    const restaurants = await db.one(`SELECT id FROM categories WHERE name = 'Restaurants & Bars'`);
    const patch = await call(`/api/transactions/${target.id}`, {
      method: 'PATCH', json: { categoryId: restaurants.id, applyToMerchant: true },
    });
    check('override: applied to merchant', patch.status === 200 && patch.body.alsoUpdated === 19
      && patch.body.transaction.categoryName === 'Restaurants & Bars' && patch.body.transaction.needsReview === false,
      JSON.stringify(patch.body));
    const learned = await db.one(`SELECT * FROM category_rules WHERE auto AND pattern = 'SAFEWAY'`);
    check('override: learned rule written', learned && learned.priority === 500, JSON.stringify(learned));
    await upload(ofx);
    check('override: survives a re-import', only(await cat('%SAFEWAY%'), 'Restaurants & Bars'), JSON.stringify(await cat('%SAFEWAY%')));

    const reviewed = await call('/api/transactions/review', { method: 'POST', json: { all: true } });
    check('review: mark all', reviewed.status === 200 && reviewed.body.updated > 0, JSON.stringify(reviewed.body));

    // Categories
    const shoppingGroup = await db.one(`SELECT id FROM category_groups WHERE name = 'Shopping'`);
    const created = await call('/api/categories', { method: 'POST', json: { name: 'Hobbies', emoji: '🧶', groupId: shoppingGroup.id } });
    check('categories: create', created.status === 201 && created.body.category.kind === 'spending', JSON.stringify(created.body));
    const sys = await db.one(`SELECT id FROM categories WHERE name = 'Uncategorized'`);
    const renameSys = await call(`/api/categories/${sys.id}`, { method: 'PATCH', json: { name: 'Nope' } });
    check('categories: built-ins cannot be renamed', renameSys.status === 400, renameSys.status);
    const del = await call(`/api/categories/${created.body.category.id}`, { method: 'DELETE' });
    check('categories: delete custom', del.status === 200, del.status);

    // Accounts, dashboard, goals, settings
    const accounts = await call('/api/accounts');
    check('accounts: balance and net worth', accounts.body.accounts.length === 1 && accounts.body.netWorth === 4321.09,
      JSON.stringify(accounts.body));
    const dash = await call(`/api/dashboard?month=${monthKey}`);
    check('dashboard: loads', dash.status === 200 && dash.body.pace.current.length === Number(today.slice(8, 10))
      && Array.isArray(dash.body.upcoming.entries) && dash.body.recent.length === 6, JSON.stringify(Object.keys(dash.body)));
    const goal = await call('/api/goals', { method: 'POST', json: { name: 'Emergency fund', kind: 'save', targetAmount: 1000 } });
    const contrib = await call(`/api/goals/${goal.body.goal.id}/contributions`, { method: 'POST', json: { amount: 250 } });
    check('goals: contribution moves progress', contrib.status === 201 && contrib.body.goal.percent === 25, JSON.stringify(contrib.body));
    const settings = await call('/api/settings');
    check('settings: counts', settings.status === 200 && settings.body.counts.learned_rules === 1, JSON.stringify(settings.body));

    // A bad file is rejected, recorded, and changes nothing
    const before = await db.one('SELECT COUNT(*)::int AS n FROM transactions');
    const junk = await upload('this is not a statement', 'notes.txt');
    const after = await db.one('SELECT COUNT(*)::int AS n FROM transactions');
    const lastRun = await db.one('SELECT status FROM sync_runs ORDER BY id DESC LIMIT 1');
    check('bad upload: 400 with a reason', junk.status === 400 && junk.body.error, JSON.stringify(junk.body));
    check('bad upload: nothing written, attempt recorded', before.n === after.n && lastRun.status === 'error',
      `${before.n} -> ${after.n}, run ${lastRun.status}`);

    const gone = await call('/api/connections');
    check('old connections API removed', gone.status === 404, gone.status);
  } catch (err) {
    console.error('threw:', err);
    failures += 1;
  } finally {
    server.close();
    await db.pool.end();
  }

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
