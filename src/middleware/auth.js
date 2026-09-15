'use strict';
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { config } = require('../config');

const COOKIE = 'bf_session';

// Single-user app: there is no signup route at all. The one account is created
// from ADMIN_EMAIL/ADMIN_PASSWORD on first boot (see ensureAdminUser) or by
// `npm run create-user`. Sessions are stateless JWTs in an httpOnly cookie.

function issueToken(user) {
  return jwt.sign(
    { sub: String(user.id), email: user.email },
    config.sessionSecret,
    { expiresIn: `${config.sessionTtlDays}d` }
  );
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: config.sessionTtlDays * 86400000,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

function readToken(req) {
  if (req.cookies && req.cookies[COOKIE]) return req.cookies[COOKIE];
  const header = req.get('authorization');
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

/** Populates req.user when a valid session is present; never rejects. */
function attachUser(req, res, next) {
  const token = readToken(req);
  if (!token) return next();
  try {
    req.user = jwt.verify(token, config.sessionSecret);
  } catch {
    clearSessionCookie(res);
  }
  next();
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  res.status(401).json({ error: 'Not signed in.' });
}

// Login throttling. In-process and per-IP, which is the right shape for a
// single-user app behind a homelab reverse proxy.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function loginRateLimit(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const rec = attempts.get(key) || { count: 0, first: now };
  if (now - rec.first > WINDOW_MS) { rec.count = 0; rec.first = now; }
  rec.count += 1;
  attempts.set(key, rec);

  if (rec.count > MAX_ATTEMPTS) {
    const waitMin = Math.ceil((WINDOW_MS - (now - rec.first)) / 60000);
    return res.status(429).json({ error: `Too many attempts. Try again in ${waitMin} minute(s).` });
  }
  next();
}

function resetRateLimit(req) {
  attempts.delete(req.ip || 'unknown');
}

async function verifyCredentials(email, password) {
  const user = await db.one('SELECT * FROM users WHERE email = $1', [
    String(email || '').trim().toLowerCase(),
  ]);
  // Always run a hash comparison so a missing user and a wrong password take
  // comparable time.
  const hash = user ? user.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
  const ok = await bcrypt.compare(String(password || ''), hash);
  return ok && user ? user : null;
}

/** Create the single user on first boot if the database has none. */
async function ensureAdminUser() {
  const existing = await db.one('SELECT id, email FROM users ORDER BY id LIMIT 1');
  if (existing) return existing;

  if (!config.adminEmail || !config.adminPassword) {
    console.warn(
      '[auth] No user exists and ADMIN_EMAIL/ADMIN_PASSWORD are not both set. ' +
      'Create one with: npm run create-user'
    );
    return null;
  }
  if (config.adminPassword.length < 8) {
    console.warn('[auth] ADMIN_PASSWORD is shorter than 8 characters; refusing to create the user.');
    return null;
  }

  const hash = await bcrypt.hash(config.adminPassword, 12);
  const user = await db.one(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
    [config.adminEmail, hash]
  );
  console.log(`[auth] Created the single user account: ${user.email}`);
  return user;
}

module.exports = {
  COOKIE, issueToken, setSessionCookie, clearSessionCookie,
  attachUser, requireAuth, loginRateLimit, resetRateLimit,
  verifyCredentials, ensureAdminUser,
};
