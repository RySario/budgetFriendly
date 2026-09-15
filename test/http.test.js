/* Boots the real Express app with the db module stubbed, to verify wiring:
   route registration, auth flow, security headers, static serving. SQL
   behaviour is covered by integration.test.js against a real Postgres. */

const bcrypt = require('bcryptjs');

process.env.DATABASE_URL = 'postgres://stub/stub';
process.env.SESSION_SECRET = 's'.repeat(40);
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.NODE_ENV = 'test';

const DB_PATH = require.resolve('../src/db/index.js');

const PASSWORD = 'correct-horse-battery';
const USER = {
  id: 1, email: 'me@example.com',
  password_hash: bcrypt.hashSync(PASSWORD, 8),
};

function rowsFor(sql) {
  if (/FROM users WHERE email/i.test(sql)) return [USER];
  // Bare aggregates always yield exactly one row in Postgres — match them
  // before the per-table branches below.
  if (/^\s*SELECT\s+(COALESCE\()?(SUM|COUNT)\b/i.test(sql) && !/GROUP BY/i.test(sql)) {
    return [{ count: 0, n: 0, spent: 0, received: 0, total: 0, income: 0, expenses: 0 }];
  }
  if (/SELECT \(SELECT COUNT/i.test(sql)) {
    return [{ transactions: 0, needs_review: 0, accounts: 0, categories: 1, rules: 0, learned_rules: 0, goals: 0 }];
  }
  if (/FROM category_groups/i.test(sql)) return [{ id: 1, name: 'Food & Dining', kind: 'spending', sort_order: 10 }];
  if (/FROM categories/i.test(sql)) {
    return [{ id: 10, name: 'Groceries', emoji: '🛒', kind: 'spending', group_id: 1, is_system: false,
      sort_order: 1, transaction_count: 0, budget: null, budget_from: null }];
  }
  if (/SELECT 1/.test(sql)) return [{ '?column?': 1 }];
  return [];
}

const stub = {
  pool: { end: async () => {}, on: () => {}, connect: async () => ({}) },
  async query(sql) { const rows = rowsFor(sql); return { rows, rowCount: rows.length }; },
  async one(sql) { return rowsFor(sql)[0] || null; },
  async many(sql) { return rowsFor(sql); },
  async tx(fn) { return fn(stub); },
  scope: () => stub,
};

require.cache[DB_PATH] = { id: DB_PATH, filename: DB_PATH, loaded: true, exports: stub };

const { app } = require('../src/server.js');

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  -> ${detail}`}`);
  if (!cond) failures += 1;
}

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  const call = async (p, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    if (opts.json) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
    const res = await fetch(base + p, { ...opts, headers, redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json() : await res.text();
    return { res, body };
  };

  try {
    const health = await call('/healthz');
    check('healthz ok', health.res.status === 200 && health.body.ok === true, JSON.stringify(health.body));

    const shell = await call('/');
    check('serves index.html', shell.res.status === 200 && /BudgetFriendly/.test(shell.body), String(shell.res.status));
    check('shell loads the module entry point', /src="\/js\/main\.js"/.test(shell.body), 'no main.js script tag');
    check('CSP header set', /default-src 'self'/.test(shell.res.headers.get('content-security-policy') || ''),
      shell.res.headers.get('content-security-policy'));
    check('nosniff header', shell.res.headers.get('x-content-type-options') === 'nosniff', '');
    check('no x-powered-by', !shell.res.headers.get('x-powered-by'), 'header present');

    for (const asset of ['/styles.css', '/js/main.js', '/js/charts.js', '/js/views/dashboard.js',
      '/js/views/transactions.js', '/js/views/cashflow.js', '/js/views/budget.js', '/js/views/recurring.js',
      '/js/views/accounts.js', '/js/views/goals.js', '/js/views/settings.js', '/manifest.webmanifest']) {
      const r = await call(asset);
      check(`serves ${asset}`, r.res.status === 200, String(r.res.status));
    }
    const sw = await call('/sw.js');
    check('sw.js not cached', (sw.res.headers.get('cache-control') || '').includes('no-cache'),
      sw.res.headers.get('cache-control'));

    const deep = await call('/goals');
    check('deep link serves shell', deep.res.status === 200 && /BudgetFriendly/.test(deep.body), '');

    const gated = await call('/api/dashboard');
    check('unauthenticated API is 401', gated.res.status === 401, String(gated.res.status));

    const bad = await call('/api/auth/login', { method: 'POST', json: { email: USER.email, password: 'nope' } });
    check('wrong password rejected', bad.res.status === 401, String(bad.res.status));

    const good = await call('/api/auth/login', { method: 'POST', json: { email: USER.email, password: PASSWORD } });
    check('login succeeds', good.res.status === 200 && good.body.user.email === USER.email, JSON.stringify(good.body));
    check('session cookie is httpOnly', /HttpOnly/i.test(good.res.headers.get('set-cookie') || ''),
      good.res.headers.get('set-cookie'));

    for (const p of [
      '/api/auth/me', '/api/dashboard', '/api/import/history', '/api/accounts', '/api/transactions',
      '/api/categories', '/api/categories/rules/all', '/api/budget', '/api/cashflow', '/api/recurring',
      '/api/goals', '/api/settings',
    ]) {
      const r = await call(p);
      check(`GET ${p}`, r.res.status === 200, `${r.res.status} ${JSON.stringify(r.body).slice(0, 180)}`);
    }

    const badMonth = await call('/api/budget?month=2026-13');
    check('budget rejects a bad month', badMonth.res.status === 400, String(badMonth.res.status));
    const noFile = await call('/api/import', { method: 'POST' });
    check('import without a file is a 400 with a reason', noFile.res.status === 400 && noFile.body.error,
      `${noFile.res.status} ${JSON.stringify(noFile.body)}`);
    const badGoal = await call('/api/goals', { method: 'POST', json: { name: 'x' } });
    check('goal validation rejects missing target', badGoal.res.status === 400, String(badGoal.res.status));

    for (const removed of ['/api/connections', '/api/subscriptions', '/api/income']) {
      const r = await call(removed);
      check(`${removed} is gone`, r.res.status === 404, String(r.res.status));
    }

    const out = await call('/api/auth/logout', { method: 'POST' });
    check('logout ok', out.res.status === 200, String(out.res.status));
  } catch (err) {
    console.error('threw:', err);
    failures += 1;
  }

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
  server.close();
  process.exit(failures ? 1 : 0);
});
