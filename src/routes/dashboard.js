'use strict';
const express = require('express');
const db = require('../db');
const { budgetMonth, spendingPace, allGoalProgress } = require('../services/budget');
const { recurringInRange } = require('../services/recurring');
const { listTransactions } = require('../services/transactions');
const { listAccounts } = require('../services/accounts');
const { currentMonthKey, toISODate, addDays } = require('../utils/dates');

const router = express.Router();

/** Everything the dashboard shows, in one round trip — it matters on a phone. */
router.get('/', async (req, res, next) => {
  try {
    const month = req.query.month || currentMonthKey();
    const today = toISODate(new Date());

    const [budget, pace, upcoming, recent, goals, accounts, review, lastImport] = await Promise.all([
      budgetMonth(month),
      spendingPace(month),
      recurringInRange(today, addDays(today, 14)),
      listTransactions({ limit: 6 }),
      allGoalProgress(month),
      listAccounts(),
      db.one('SELECT COUNT(*)::int AS count FROM transactions WHERE needs_review'),
      db.one(
        `SELECT started_at, finished_at, status, imported, duplicates, message
           FROM sync_runs ORDER BY started_at DESC LIMIT 1`
      ),
    ]);

    res.json({
      month,
      budget,
      pace,
      upcoming: {
        entries: upcoming.entries.filter((e) => e.state !== 'paid'),
        totals: upcoming.totals,
      },
      recent: recent.transactions,
      goals,
      accounts,
      reviewCount: review.count,
      lastImport,
    });
  } catch (err) { next(err); }
});

module.exports = router;
