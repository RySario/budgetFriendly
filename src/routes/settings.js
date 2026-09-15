'use strict';
const express = require('express');
const db = require('../db');
const { config } = require('../config');
const { listAdapters } = require('../services/importers');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const rows = await db.many('SELECT key, value, updated_at FROM settings');
    const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));

    const counts = await db.one(
      `SELECT (SELECT COUNT(*)::int FROM transactions)   AS transactions,
              (SELECT COUNT(*)::int FROM accounts)       AS accounts,
              (SELECT COUNT(*)::int FROM categories)     AS categories,
              (SELECT COUNT(*)::int FROM subscriptions)  AS subscriptions,
              (SELECT COUNT(*)::int FROM goals)          AS goals`
    );

    res.json({
      settings,
      counts,
      adapters: listAdapters(),
      environment: {
        // Enough to diagnose a misconfiguration, never the values themselves.
        encryptionConfigured: Boolean(config.encryptionKey),
        ofxConfigured: Boolean(config.ofx.url && config.ofx.org && config.ofx.fid),
        webAdapterEnabled: config.webAdapterEnabled,
        nodeEnv: config.env,
      },
    });
  } catch (err) { next(err); }
});

router.put('/:key', async (req, res, next) => {
  try {
    const value = req.body && req.body.value !== undefined ? req.body.value : req.body;
    const row = await db.one(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       RETURNING *`,
      [req.params.key, JSON.stringify(value)]
    );
    res.json({ setting: row });
  } catch (err) { next(err); }
});

module.exports = router;
