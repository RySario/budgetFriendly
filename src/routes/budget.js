'use strict';
const express = require('express');
const db = require('../db');
const { monthlySummary, monthlyTrend, allGoalProgress } = require('../services/budget');
const { round2, sum } = require('../utils/money');
const { currentMonthKey } = require('../utils/dates');

const router = express.Router();

router.get('/summary', async (req, res, next) => {
  try {
    res.json({ summary: await monthlySummary(req.query.month) });
  } catch (err) { next(err); }
});

router.get('/trend', async (req, res, next) => {
  try {
    const months = Math.min(Math.max(Number(req.query.months) || 6, 2), 24);
    res.json({ trend: await monthlyTrend(months) });
  } catch (err) { next(err); }
});

/** Everything the dashboard needs, in one round trip — it matters on mobile. */
router.get('/dashboard', async (req, res, next) => {
  try {
    const month = req.query.month || currentMonthKey();
    const [summary, trend, goals] = await Promise.all([
      monthlySummary(month),
      monthlyTrend(6),
      allGoalProgress(month),
    ]);

    const subs = await db.many(
      `SELECT id, name, amount, cadence, monthly_amount, status, next_expected_on, confidence
         FROM subscriptions
        WHERE status IN ('detected', 'confirmed')
        ORDER BY monthly_amount DESC`
    );
    const pendingReview = subs.filter((s) => s.status === 'detected').length;

    const accounts = await db.many(
      `SELECT id, name, type, mask, current_balance, available_balance, balance_as_of
         FROM accounts WHERE archived = false ORDER BY name`
    );

    const recent = await db.many(
      `SELECT t.id, t.posted_on, t.amount, t.description, c.name AS category_name,
              c.color AS category_color
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE a.archived = false
        ORDER BY t.posted_on DESC, t.id DESC LIMIT 8`
    );

    const lastSync = await db.one(
      `SELECT r.started_at, r.status, r.imported, r.message, c.name AS connection_name
         FROM sync_runs r LEFT JOIN bank_connections c ON c.id = r.connection_id
        ORDER BY r.started_at DESC LIMIT 1`
    );

    const uncategorised = await db.one(
      `SELECT COUNT(*)::int AS count
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.category_id IS NULL OR c.name = 'Uncategorized'`
    );

    res.json({
      month,
      summary,
      trend,
      goals,
      accounts,
      recentTransactions: recent,
      lastSync,
      uncategorisedCount: uncategorised.count,
      subscriptions: {
        items: subs.slice(0, 8),
        pendingReview,
        monthlyTotal: round2(sum(subs.map((s) => s.monthly_amount))),
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
