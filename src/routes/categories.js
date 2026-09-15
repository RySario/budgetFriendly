'use strict';
const express = require('express');
const db = require('../db');
const { categorizeAll } = require('../services/detect/categorize');
const { round2 } = require('../utils/money');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const categories = await db.many(
      `SELECT c.*, COUNT(t.id)::int AS transaction_count
         FROM categories c
         LEFT JOIN transactions t ON t.category_id = c.id
        GROUP BY c.id
        ORDER BY c.sort_order, c.name`
    );
    res.json({ categories });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, kind, color, monthlyBudget, sortOrder } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required.' });
    const row = await db.one(
      `INSERT INTO categories (name, kind, color, monthly_budget, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (name) DO NOTHING
       RETURNING *`,
      [
        String(name).trim(),
        kind || 'spending',
        color || '#6b7280',
        monthlyBudget == null || monthlyBudget === '' ? null : round2(Number(monthlyBudget)),
        sortOrder == null ? 100 : Number(sortOrder),
      ]
    );
    if (!row) return res.status(409).json({ error: 'A category with that name already exists.' });
    res.status(201).json({ category: row });
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { name, kind, color, monthlyBudget, sortOrder } = req.body || {};
    const sets = [];
    const params = [req.params.id];

    if (name !== undefined) { params.push(String(name).trim()); sets.push(`name = $${params.length}`); }
    if (kind !== undefined) { params.push(kind); sets.push(`kind = $${params.length}`); }
    if (color !== undefined) { params.push(color); sets.push(`color = $${params.length}`); }
    if (monthlyBudget !== undefined) {
      params.push(monthlyBudget === null || monthlyBudget === '' ? null : round2(Number(monthlyBudget)));
      sets.push(`monthly_budget = $${params.length}`);
    }
    if (sortOrder !== undefined) { params.push(Number(sortOrder)); sets.push(`sort_order = $${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

    const row = await db.one(
      `UPDATE categories SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    if (!row) return res.status(404).json({ error: 'Category not found.' });
    res.json({ category: row });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const cat = await db.one('SELECT * FROM categories WHERE id = $1', [req.params.id]);
    if (!cat) return res.status(404).json({ error: 'Category not found.' });
    if (cat.is_system) return res.status(400).json({ error: 'Built-in categories cannot be deleted.' });

    // Transactions fall back to Uncategorized rather than losing their category.
    const fallback = await db.one(`SELECT id FROM categories WHERE name = 'Uncategorized'`);
    await db.query(
      'UPDATE transactions SET category_id = $1, category_locked = false WHERE category_id = $2',
      [fallback ? fallback.id : null, cat.id]
    );
    await db.query('DELETE FROM categories WHERE id = $1', [cat.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// --- rules ----------------------------------------------------------------

router.get('/rules/all', async (req, res, next) => {
  try {
    const rules = await db.many(
      `SELECT r.*, c.name AS category_name, c.color AS category_color
         FROM category_rules r JOIN categories c ON c.id = r.category_id
        ORDER BY r.priority DESC, c.name, r.pattern`
    );
    res.json({ rules });
  } catch (err) { next(err); }
});

router.post('/rules', async (req, res, next) => {
  try {
    const { categoryId, pattern, matchType, priority } = req.body || {};
    if (!categoryId || !pattern) {
      return res.status(400).json({ error: 'categoryId and pattern are required.' });
    }
    if (matchType === 'regex') {
      try { new RegExp(pattern); }
      catch (e) { return res.status(400).json({ error: `Invalid regex: ${e.message}` }); }
    }
    const row = await db.one(
      `INSERT INTO category_rules (category_id, match_type, pattern, priority)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (category_id, match_type, pattern) DO UPDATE SET priority = EXCLUDED.priority
       RETURNING *`,
      [categoryId, matchType || 'contains', String(pattern).trim(), priority == null ? 200 : Number(priority)]
    );
    const updated = await categorizeAll({ onlyUncategorised: false });
    res.status(201).json({ rule: row, recategorised: updated });
  } catch (err) { next(err); }
});

router.delete('/rules/:ruleId', async (req, res, next) => {
  try {
    await db.query('DELETE FROM category_rules WHERE id = $1', [req.params.ruleId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
