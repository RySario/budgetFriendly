'use strict';
const express = require('express');
const { cashFlow, breakdown } = require('../services/budget');

const router = express.Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Monthly income vs. expenses, plus a breakdown by category, group or
 * merchant. The breakdown covers the whole window unless start/end narrow it
 * (the UI does that when a single month is selected).
 */
router.get('/', async (req, res, next) => {
  try {
    const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 36);
    const endMonth = MONTH_RE.test(req.query.endMonth || '') ? req.query.endMonth : undefined;
    const flow = await cashFlow({ months, endMonth });

    const start = DATE_RE.test(req.query.start || '') ? req.query.start : flow.range.start;
    const end = DATE_RE.test(req.query.end || '') ? req.query.end : flow.range.end;
    const by = ['category', 'group', 'merchant'].includes(req.query.by) ? req.query.by : 'category';

    const [spending, income] = await Promise.all([
      breakdown({ start, end, by, kind: 'spending' }),
      breakdown({ start, end, by, kind: 'income' }),
    ]);
    res.json({ ...flow, breakdown: { start, end, by, spending, income } });
  } catch (err) { next(err); }
});

module.exports = router;
