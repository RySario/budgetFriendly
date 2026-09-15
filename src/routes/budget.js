'use strict';
const express = require('express');
const db = require('../db');
const { budgetMonth, setBudget } = require('../services/budget');

const router = express.Router();
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

router.get('/', async (req, res, next) => {
  try {
    const month = req.query.month;
    if (month && !MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM.' });
    res.json(await budgetMonth(month));
  } catch (err) { next(err); }
});

/** Set a category's budget from { month } onward. amount: null clears that month. */
router.put('/:categoryId', async (req, res, next) => {
  try {
    const { month, amount } = req.body || {};
    if (!MONTH_RE.test(String(month || ''))) return res.status(400).json({ error: 'month must be YYYY-MM.' });

    const cat = await db.one('SELECT id, kind FROM categories WHERE id = $1', [Number(req.params.categoryId)]);
    if (!cat) return res.status(404).json({ error: 'Category not found.' });
    if (cat.kind === 'transfer') return res.status(400).json({ error: 'Transfers are not budgeted.' });

    const cleared = amount === null || amount === '';
    const value = Number(amount);
    if (!cleared && (!Number.isFinite(value) || value < 0)) {
      return res.status(400).json({ error: 'Budget must be zero or more.' });
    }

    await setBudget(cat.id, month, cleared ? null : value);
    res.json(await budgetMonth(month));
  } catch (err) { next(err); }
});

module.exports = router;
