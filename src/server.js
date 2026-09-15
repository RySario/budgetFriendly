'use strict';
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { config, validate } = require('./config');
const db = require('./db');
const { attachUser, ensureAdminUser } = require('./middleware/auth');
const apiRoutes = require('./routes');

const app = express();

// Behind Dokku's nginx (and possibly a tunnel), so req.ip and secure cookies
// need the proxy chain trusted. See TRUST_PROXY in .env.example.
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  // The frontend is self-contained: no external scripts, styles or fonts.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; " +
    "frame-ancestors 'none'"
  );
  if (config.isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(attachUser);

app.get('/healthz', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.use('/api', apiRoutes);

// Static frontend. Code revalidates on every load — a cheap 304 when nothing
// changed — so a deploy is never half-applied from a stale cache. Icons rarely
// change and may be cached for a day.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(
  express.static(PUBLIC_DIR, {
    setHeaders(res, filePath) {
      const icon = config.isProd && filePath.endsWith('.png');
      res.setHeader('Cache-Control', icon ? 'public, max-age=86400' : 'no-cache');
    },
  })
);

// Client-side routing: anything that is not an API call gets the shell.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({
    error: status >= 500 && config.isProd ? 'Something went wrong.' : err.message,
  });
});

async function start() {
  const problems = validate();
  if (problems.length) {
    console.error('Configuration problems:\n  - ' + problems.join('\n  - '));
    console.error('\nSee .env.example for what each variable does.');
    process.exit(1);
  }

  // Migrations run on boot so a deploy applies schema changes automatically and
  // a bare `node src/server.js` works. The runner is idempotent — already
  // applied migrations are skipped — and a failure here aborts the boot rather
  // than serving against a schema that does not match the code.
  await require('./db/migrate').run();
  await ensureAdminUser();

  const server = app.listen(config.port, () => {
    console.log(`BudgetFriendly listening on :${config.port} (${config.env})`);
  });

  const shutdown = (signal) => () => {
    console.log(`[${signal}] shutting down`);
    server.close(() => db.pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}

module.exports = { app, start };
