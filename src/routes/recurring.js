'use strict';
const express = require('express');
const { recurringForMonth, setRecurringStatus } = require('../services/recurring');

const router = express.Router();
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

router.get('/', async (req, res, next) => {
  try {
    const month = req.query.month;
    if (month && !MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM.' });
    res.json(await recurringForMonth(month));
  } catch (err) { next(err); }
});

/** Confirm, dismiss or cancel a recurring series. type: expense | income. */
router.patch('/:type/:id', async (req, res, next) => {
  try {
    const row = await setRecurringStatus(req.params.type, Number(req.params.id), (req.body || {}).status);
    if (!row) return res.status(400).json({ error: 'Unknown recurring item or status.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
