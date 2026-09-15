'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const {
  issueToken, setSessionCookie, clearSessionCookie, requireAuth,
  loginRateLimit, resetRateLimit, verifyCredentials,
} = require('../middleware/auth');

const router = express.Router();

router.post('/login', loginRateLimit, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const user = await verifyCredentials(email, password);
    if (!user) return res.status(401).json({ error: 'Incorrect email or password.' });

    resetRateLimit(req);
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    setSessionCookie(res, issueToken(user));
    res.json({ user: { id: user.id, email: user.email } });
  } catch (err) { next(err); }
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  res.json({ user: { id: req.user.sub, email: req.user.email } });
});

router.post('/password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }
    const user = await verifyCredentials(req.user.email, currentPassword);
    if (!user) return res.status(401).json({ error: 'Current password is incorrect.' });

    const hash = await bcrypt.hash(String(newPassword), 12);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id]);
    setSessionCookie(res, issueToken(user));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
