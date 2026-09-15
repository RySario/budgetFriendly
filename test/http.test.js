/* Boots the real Express app with the db module stubbed, to verify wiring:
   route registration, auth flow, security headers, static serving. */

const path = require('path');
const bcrypt = require('bcryptjs');

process.env.DATABASE_URL = 'postgres://stub/stub';
process.env.SESSION_SECRET = 's'.repeat(40);
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.NODE_ENV = 'test';

const DB_PATH = require.resolve("../src/db/index.js");

const PASSWORD = 'correct-horse-battery';
const USER = {
  id: 1, email: 'me@example.com',
  password_hash: bcrypt.hashSync(PASSWORD, 8),
};

const seen = [];
function rowsFor(sql) {
  seen.push(sql.replace(/\s+/g, ' ').trim().slice(0, 70));
  if (/FROM users WHERE email/i.test(sql)) return [USER];
  // Bare aggregates always yield exactly one row in Postgres — match them
  // before the per-table branches below.
  if (/SELECT\s+(COALESCE\()?(SUM|COUNT)\b/i.test(sql) && !/GROUP BY/i.test(sql)) {
    return [{ count: 0, n: 0, spent: 0, received: 0, total: 0 }];
  }
  if (/FROM categories/i.test(sql)) {
    return [{ id: 10, name: 'Groceries', kind: 'spending', color: '#22c55e',
              monthly_budget: 600, sort_order: 50, is_system: false, transaction_count: 3 }];
  }
  if (/FROM bank_connections/i.test(sql)) return [];
  if (/FROM accounts/i.test(sql)) return [];
  if (/FROM transactions/i.test(sql)) return [];
  if (/FROM subscriptions/i.test(sql)) return [];
  if (/FROM income_sources/i.test(sql)) return [];
  if (/FROM goals/i.test(sql)) return [];
  if (/FROM sync_runs/i.test(sql)) return [];
  if (/FROM settings/i.test(sql)) return [];
  if (/SELECT \(SELECT COUNT/i.test(sql)) {
    return [{ transactions: 0, accounts: 0, categories: 1, subscriptions: 0, goals: 0 }];
  }
  if (/COUNT\(\*\)/i.test(sql)) return [{ count: 0, n: 0, spent: 0, received: 0 }];
  if (/SELECT 1/.test(sql)) return [{ '?column?': 1 }];
  return [];
}

const stub = {
  pool: { end: async () => {}, on: () => {}, connect: async () => ({}) },
  async query(sql) { const rows = rowsFor(sql); return { rows, rowCount: rows.length }; },
  async one(sql) { return rowsFor(sql)[0] || null; },
  async many(sql) { return rowsFor(sql); },
  async tx(fn) { return fn({ query: stub.query }); },
};

require.cache[DB_PATH] = { id: DB_PATH, filename: DB_PATH, loaded: true, exports: stub };

const { app } = require("../src/server.js");

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
    // Health
    const health = await call('/healthz');
    check('healthz ok', health.res.status === 200 && health.body.ok === true, JSON.stringify(health.body));

    // Security headers on the shell
    const shell = await call('/');
    check('serves index.html', shell.res.status === 200 && /BudgetFriendly/.test(shell.body),
      String(shell.res.status));
    check('CSP header set', /default-src 'self'/.test(shell.res.headers.get('content-security-policy') || ''),
      shell.res.headers.get('content-security-policy'));
    check('nosniff header', shell.res.headers.get('x-content-type-options') === 'nosniff', '');
    check('no x-powered-by', !shell.res.headers.get('x-powered-by'), 'header present');

    // Static assets
    const css = await call('/styles.css');
    check('serves styles.css', css.res.status === 200 && /--accent/.test(css.body), String(css.res.status));
    const mani = await call('/manifest.webmanifest');
    check('serves manifest', mani.res.status === 200, String(mani.res.status));
    const sw = await call('/sw.js');
    check('sw.js not cached', (sw.res.headers.get('cache-control') || '').includes('no-cache'),
      sw.res.headers.get('cache-control'));

    // Client-side route falls through to the shell
    const deep = await call('/goals');
    check('deep link serves shell', deep.res.status === 200 && /BudgetFriendly/.test(deep.body), '');

    // Auth gate
    const gated = await call('/api/categories');
    check('unauthenticated API is 401', gated.res.status === 401, String(gated.res.status));

    const me0 = await call('/api/auth/me');
    check('me without session is 401', me0.res.status === 401, String(me0.res.status));

    // Bad login
    const bad = await call('/api/auth/login', { method: 'POST', json: { email: USER.email, password: 'nope' } });
    check('wrong password rejected', bad.res.status === 401, String(bad.res.status));

    // Good login
    const good = await call('/api/auth/login', { method: 'POST', json: { email: USER.email, password: PASSWORD } });
    check('login succeeds', good.res.status === 200 && good.body.user.email === USER.email,
      JSON.stringify(good.body));
    check('session cookie is httpOnly', /HttpOnly/i.test(good.res.headers.get('set-cookie') || ''),
      good.res.headers.get('set-cookie'));

    const me1 = await call('/api/auth/me');
    check('me with session works', me1.res.status === 200, String(me1.res.status));

    // Authenticated reads across every router
    for (const [label, p] of [
      ['categories', '/api/categories'],
      ['category rules', '/api/categories/rules/all'],
      ['connections', '/api/connections'],
      ['adapters', '/api/connections/adapters'],
      ['sync runs', '/api/connections/runs'],
      ['transactions', '/api/transactions'],
      ['subscriptions', '/api/subscriptions'],
      ['income', '/api/income'],
      ['goals', '/api/goals'],
      ['budget summary', '/api/budget/summary'],
      ['budget trend', '/api/budget/trend'],
      ['dashboard', '/api/budget/dashboard'],
      ['settings', '/api/settings'],
    ]) {
      const r = await call(p);
      check(`GET ${label}`, r.res.status === 200,
        `${r.res.status} ${JSON.stringify(r.body).slice(0, 180)}`);
    }

    // Adapter registry content
    const ad = await call('/api/connections/adapters');
    const ids = (ad.body.adapters || []).map((a) => a.id);
    check('three adapters registered', ids.join(',') === 'file,ofx,web', ids.join(','));
    const fileAdapter = ad.body.adapters.find((a) => a.id === 'file');
    check('file adapter supports upload', fileAdapter.capabilities.upload === true, '');
    const ofxAdapter = ad.body.adapters.find((a) => a.id === 'ofx');
    check('ofx adapter reports unconfigured', ofxAdapter.configured === false && !!ofxAdapter.configHint,
      JSON.stringify(ofxAdapter));

    // Unknown API route
    const missing = await call('/api/nope');
    check('unknown API route 404s as JSON', missing.res.status === 404 && missing.body.error,
      String(missing.res.status));

    // Validation
    const badGoal = await call('/api/goals', { method: 'POST', json: { name: 'x' } });
    check('goal validation rejects missing target', badGoal.res.status === 400, String(badGoal.res.status));

    // Logout
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
