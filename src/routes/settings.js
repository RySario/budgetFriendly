'use strict';
const express = require('express');
const db = require('../db');

const router = express.Router();
const PREFERENCES_KEY = 'preferences';

async function loadPreferences() {
  const row = await db.one('SELECT value FROM settings WHERE key = $1', [PREFERENCES_KEY]);
  return (row && row.value) || {};
}

router.get('/', async (req, res, next) => {
  try {
    const [counts, preferences] = await Promise.all([
      db.one(
        `SELECT (SELECT COUNT(*)::int FROM transactions)                   AS transactions,
                (SELECT COUNT(*)::int FROM transactions WHERE needs_review) AS needs_review,
                (SELECT COUNT(*)::int FROM accounts)                       AS accounts,
                (SELECT COUNT(*)::int FROM categories)                     AS categories,
                (SELECT COUNT(*)::int FROM category_rules)                 AS rules,
                (SELECT COUNT(*)::int FROM category_rules WHERE auto)      AS learned_rules,
                (SELECT COUNT(*)::int FROM goals)                          AS goals`
      ),
      loadPreferences(),
    ]);
    res.json({ user: { email: req.user.email }, counts, preferences });
  } catch (err) { next(err); }
});

/** { tourCompleted: boolean } — whether the first-run tour has been seen, on any device. */
router.patch('/preferences', async (req, res, next) => {
  try {
    const { tourCompleted } = req.body || {};
    if (typeof tourCompleted !== 'boolean') return res.status(400).json({ error: 'Nothing to update.' });

    const preferences = await loadPreferences();
    if (tourCompleted) preferences.tourCompletedAt = new Date().toISOString();
    else delete preferences.tourCompletedAt;
    await db.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [PREFERENCES_KEY, JSON.stringify(preferences)]
    );
    res.json({ preferences });
  } catch (err) { next(err); }
});

module.exports = router;
