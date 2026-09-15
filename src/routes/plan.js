'use strict';
const express = require('express');
const { paycheckPlan, saveSettings, CADENCE_DAYS } = require('../services/plan');
const { round2 } = require('../utils/money');
const { toISODate } = require('../utils/dates');

const router = express.Router();

/** The current paycheck plan. ?spend=N previews a spending amount; ?spend=recommended previews the recommendation. */
router.get('/', async (req, res, next) => {
  try {
    const { spend } = req.query;
    let preview;
    if (spend === 'recommended') preview = null;
    else if (spend !== undefined) {
      preview = Number(spend);
      if (!Number.isFinite(preview) || preview < 0) {
        return res.status(400).json({ error: 'spend must be zero or more.' });
      }
    }
    res.json(await paycheckPlan({ spend: preview }));
  } catch (err) { next(err); }
});

/**
 * { spendingBudget: number | null }  null goes back to the recommendation.
 * { paycheck: { amount, cadence, nextPayday } | null }  null goes back to detected income.
 */
router.patch('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const changes = {};

    if (body.spendingBudget !== undefined) {
      if (body.spendingBudget === null || body.spendingBudget === '') {
        changes.spendingBudget = null;
      } else {
        const value = Number(body.spendingBudget);
        if (!Number.isFinite(value) || value < 0) {
          return res.status(400).json({ error: 'Spending budget must be zero or more.' });
        }
        changes.spendingBudget = round2(value);
      }
    }

    if (body.paycheck !== undefined) {
      if (body.paycheck === null) {
        changes.paycheck = null;
      } else {
        const { amount, cadence, nextPayday, name } = body.paycheck;
        const value = Number(amount);
        if (!Number.isFinite(value) || value <= 0) {
          return res.status(400).json({ error: 'Paycheck amount must be more than zero.' });
        }
        if (!CADENCE_DAYS[cadence]) {
          return res.status(400).json({ error: 'Choose how often you are paid.' });
        }
        const anchorDate = /^\d{4}-\d{2}-\d{2}$/.test(String(nextPayday || '')) ? toISODate(nextPayday) : null;
        if (!anchorDate) return res.status(400).json({ error: 'Enter a payday date.' });
        const label = typeof name === 'string' ? name.trim().slice(0, 60) : '';
        changes.paycheck = { amount: round2(value), cadence, anchorDate, ...(label ? { name: label } : {}) };
      }
    }

    if (!Object.keys(changes).length) return res.status(400).json({ error: 'Nothing to update.' });
    await saveSettings(changes);
    res.json(await paycheckPlan());
  } catch (err) { next(err); }
});

module.exports = router;
