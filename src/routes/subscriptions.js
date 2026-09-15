'use strict';
const express = require('express');
const db = require('../db');
const { runDetection } = require('../services/detect');
const { round2, sum } = require('../utils/money');

const router = express.Router();

const VALID_STATUS = new Set(['detected', 'confirmed', 'dismissed', 'cancelled']);

router.get('/', async (req, res, next) => {
  try {
    const rows = await db.many(
      `SELECT s.*, c.name AS category_name, c.color AS category_color
         FROM subscriptions s LEFT JOIN categories c ON c.id = s.category_id
        ORDER BY
          CASE s.status WHEN 'confirmed' THEN 0 WHEN 'detected' THEN 1
                        WHEN 'cancelled' THEN 2 ELSE 3 END,
          s.monthly_amount DESC`
    );

    const counted = rows.filter((r) => r.status === 'confirmed' || r.status === 'detected');
    res.json({
      subscriptions: rows,
      totals: {
        monthly: round2(sum(counted.map((r) => r.monthly_amount))),
        annual: round2(sum(counted.map((r) => r.monthly_amount)) * 12),
        confirmedMonthly: round2(sum(
          rows.filter((r) => r.status === 'confirmed').map((r) => r.monthly_amount)
        )),
        count: counted.length,
      },
    });
  } catch (err) { next(err); }
});

/** Recent charges behind a detected subscription, so you can sanity-check it. */
router.get('/:id/transactions', async (req, res, next) => {
  try {
    const sub = await db.one('SELECT * FROM subscriptions WHERE id = $1', [req.params.id]);
    if (!sub) return res.status(404).json({ error: 'Subscription not found.' });
    const rows = await db.many(
      `SELECT t.id, t.posted_on, t.amount, t.description
         FROM transactions t
        WHERE t.merchant_key = $1 AND t.amount < 0
        ORDER BY t.posted_on DESC LIMIT 24`,
      [sub.merchant_key]
    );
    res.json({ transactions: rows });
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { status, name, amount, cadence, categoryId } = req.body || {};
    const sets = [];
    const params = [req.params.id];

    if (status !== undefined) {
      if (!VALID_STATUS.has(status)) return res.status(400).json({ error: 'Invalid status.' });
      params.push(status); sets.push(`status = $${params.length}`);
    }
    if (name !== undefined) { params.push(String(name).trim()); sets.push(`name = $${params.length}`); }
    if (amount !== undefined) { params.push(round2(Number(amount))); sets.push(`amount = $${params.length}`); }
    if (cadence !== undefined) { params.push(cadence); sets.push(`cadence = $${params.length}`); }
    if (categoryId !== undefined) {
      params.push(categoryId || null); sets.push(`category_id = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

    sets.push('updated_at = now()');
    const row = await db.one(
      `UPDATE subscriptions SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    if (!row) return res.status(404).json({ error: 'Subscription not found.' });
    res.json({ subscription: row });
  } catch (err) { next(err); }
});

router.post('/detect', async (req, res, next) => {
  try {
    res.json({ detection: await runDetection() });
  } catch (err) { next(err); }
});

module.exports = router;
