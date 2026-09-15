'use strict';
const express = require('express');
const db = require('../db');
const { allGoalProgress, goalProgress } = require('../services/budget');
const { round2 } = require('../utils/money');
const { toISODate } = require('../utils/dates');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    res.json({ goals: await allGoalProgress(req.query.month) });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const {
      name, kind, targetAmount, startingAmount, targetDate,
      categoryId, monthlyContribution, notes,
    } = req.body || {};

    if (!name || targetAmount == null) {
      return res.status(400).json({ error: 'name and targetAmount are required.' });
    }
    const target = round2(Number(targetAmount));
    if (!Number.isFinite(target) || target <= 0) {
      return res.status(400).json({ error: 'targetAmount must be a positive number.' });
    }
    if (kind === 'limit' && !categoryId) {
      return res.status(400).json({ error: 'A spending-limit goal needs a category.' });
    }

    const row = await db.one(
      `INSERT INTO goals
         (name, kind, target_amount, starting_amount, target_date, category_id,
          monthly_contribution, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        String(name).trim(),
        kind || 'save',
        target,
        startingAmount ? round2(Number(startingAmount)) : 0,
        targetDate ? toISODate(targetDate) : null,
        categoryId || null,
        monthlyContribution ? round2(Number(monthlyContribution)) : null,
        notes || null,
      ]
    );
    res.status(201).json({ goal: await goalProgress(row) });
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const map = {
      name: 'name', kind: 'kind', status: 'status', notes: 'notes',
      targetAmount: 'target_amount', startingAmount: 'starting_amount',
      targetDate: 'target_date', categoryId: 'category_id',
      monthlyContribution: 'monthly_contribution',
    };
    const sets = [];
    const params = [req.params.id];

    for (const [key, column] of Object.entries(map)) {
      if (req.body[key] === undefined) continue;
      let value = req.body[key];
      if (['target_amount', 'starting_amount', 'monthly_contribution'].includes(column)) {
        value = value === null || value === '' ? null : round2(Number(value));
      }
      if (column === 'target_date') value = value ? toISODate(value) : null;
      if (column === 'category_id') value = value || null;
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

    sets.push('updated_at = now()');
    const row = await db.one(
      `UPDATE goals SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    if (!row) return res.status(404).json({ error: 'Goal not found.' });
    res.json({ goal: await goalProgress(row) });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await db.query('DELETE FROM goals WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// --- contributions --------------------------------------------------------

router.get('/:id/contributions', async (req, res, next) => {
  try {
    const rows = await db.many(
      'SELECT * FROM goal_contributions WHERE goal_id = $1 ORDER BY occurred_on DESC, id DESC',
      [req.params.id]
    );
    res.json({ contributions: rows });
  } catch (err) { next(err); }
});

router.post('/:id/contributions', async (req, res, next) => {
  try {
    const { amount, occurredOn, note } = req.body || {};
    const value = round2(Number(amount));
    if (!Number.isFinite(value) || value === 0) {
      return res.status(400).json({ error: 'amount must be a non-zero number.' });
    }
    const goal = await db.one('SELECT * FROM goals WHERE id = $1', [req.params.id]);
    if (!goal) return res.status(404).json({ error: 'Goal not found.' });

    await db.one(
      `INSERT INTO goal_contributions (goal_id, amount, occurred_on, note)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [goal.id, value, occurredOn ? toISODate(occurredOn) : toISODate(new Date()), note || null]
    );

    // Flip the goal to achieved as soon as it lands, so the UI can celebrate.
    const progress = await goalProgress(goal);
    if (progress.achieved && goal.status === 'active' && goal.kind !== 'limit') {
      await db.query(`UPDATE goals SET status = 'achieved', updated_at = now() WHERE id = $1`, [goal.id]);
      progress.status = 'achieved';
    }
    res.status(201).json({ goal: progress });
  } catch (err) { next(err); }
});

router.delete('/:id/contributions/:contributionId', async (req, res, next) => {
  try {
    await db.query(
      'DELETE FROM goal_contributions WHERE id = $1 AND goal_id = $2',
      [req.params.contributionId, req.params.id]
    );
    const goal = await db.one('SELECT * FROM goals WHERE id = $1', [req.params.id]);
    res.json({ goal: goal ? await goalProgress(goal) : null });
  } catch (err) { next(err); }
});

module.exports = router;
