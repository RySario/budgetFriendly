'use strict';
const express = require('express');
const db = require('../db');
const { estimateMonthlyIncome, runDetection } = require('../services/detect');
const { round2 } = require('../utils/money');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    res.json({ income: await estimateMonthlyIncome() });
  } catch (err) { next(err); }
});

/** Set or clear the manual monthly-income override. */
router.put('/override', async (req, res, next) => {
  try {
    const { amount } = req.body || {};

    if (amount === null || amount === '' || amount === undefined) {
      await db.query(`DELETE FROM settings WHERE key = 'income_override'`);
      return res.json({ income: await estimateMonthlyIncome() });
    }

    const value = round2(Number(amount));
    if (!Number.isFinite(value) || value < 0) {
      return res.status(400).json({ error: 'amount must be a non-negative number.' });
    }

    await db.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('income_override', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ amount: value })]
    );
    res.json({ income: await estimateMonthlyIncome() });
  } catch (err) { next(err); }
});

router.get('/sources/:id/transactions', async (req, res, next) => {
  try {
    const src = await db.one('SELECT * FROM income_sources WHERE id = $1', [req.params.id]);
    if (!src) return res.status(404).json({ error: 'Income source not found.' });
    const rows = await db.many(
      `SELECT id, posted_on, amount, description FROM transactions
        WHERE merchant_key = $1 AND amount > 0
        ORDER BY posted_on DESC LIMIT 24`,
      [src.merchant_key]
    );
    res.json({ transactions: rows });
  } catch (err) { next(err); }
});

router.patch('/sources/:id', async (req, res, next) => {
  try {
    const { status, name, amount, cadence } = req.body || {};
    const sets = [];
    const params = [req.params.id];

    if (status !== undefined) { params.push(status); sets.push(`status = $${params.length}`); }
    if (name !== undefined) { params.push(String(name).trim()); sets.push(`name = $${params.length}`); }
    if (cadence !== undefined) { params.push(cadence); sets.push(`cadence = $${params.length}`); }
    if (amount !== undefined) {
      params.push(round2(Number(amount))); sets.push(`amount = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

    sets.push('updated_at = now()');
    const row = await db.one(
      `UPDATE income_sources SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    if (!row) return res.status(404).json({ error: 'Income source not found.' });

    // Editing the per-payment amount has to flow through to the monthly figure.
    if (amount !== undefined) {
      const { perMonthFor } = require('../services/detect/recurrence');
      await db.query(
        'UPDATE income_sources SET monthly_amount = $2 WHERE id = $1',
        [row.id, round2(Number(row.amount) * perMonthFor(row.cadence))]
      );
    }
    res.json({ source: await db.one('SELECT * FROM income_sources WHERE id = $1', [row.id]) });
  } catch (err) { next(err); }
});

router.post('/detect', async (req, res, next) => {
  try {
    await runDetection();
    res.json({ income: await estimateMonthlyIncome() });
  } catch (err) { next(err); }
});

module.exports = router;
