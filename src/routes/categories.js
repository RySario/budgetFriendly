'use strict';
const express = require('express');
const db = require('../db');
const { categoryTree } = require('../services/budget');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    res.json({ groups: await categoryTree() });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, emoji, groupId } = req.body || {};
    const trimmed = String(name || '').trim();
    if (!trimmed) return res.status(400).json({ error: 'Give the category a name.' });

    const group = await db.one('SELECT id, kind FROM category_groups WHERE id = $1', [Number(groupId)]);
    if (!group) return res.status(400).json({ error: 'Choose a group for the category.' });

    const row = await db.one(
      `INSERT INTO categories (name, emoji, group_id, kind, sort_order)
       VALUES ($1, $2, $3, $4,
               COALESCE((SELECT MAX(sort_order) + 1 FROM categories WHERE group_id = $3), 1000))
       ON CONFLICT (name) DO NOTHING
       RETURNING *`,
      [trimmed, String(emoji || '').trim() || null, group.id, group.kind]
    );
    if (!row) return res.status(409).json({ error: 'A category with that name already exists.' });
    res.status(201).json({ category: row, groups: await categoryTree() });
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cat = await db.one('SELECT * FROM categories WHERE id = $1', [id]);
    if (!cat) return res.status(404).json({ error: 'Category not found.' });

    const { name, emoji, groupId } = req.body || {};
    const sets = [];
    const params = [id];

    if (emoji !== undefined) {
      params.push(String(emoji || '').trim() || null);
      sets.push(`emoji = $${params.length}`);
    }
    if (name !== undefined && String(name).trim() !== cat.name) {
      if (cat.is_system) return res.status(400).json({ error: 'Built-in categories cannot be renamed.' });
      const trimmed = String(name).trim();
      if (!trimmed) return res.status(400).json({ error: 'Give the category a name.' });
      params.push(trimmed);
      sets.push(`name = $${params.length}`);
    }
    if (groupId !== undefined && Number(groupId) !== cat.group_id) {
      if (cat.is_system) return res.status(400).json({ error: 'Built-in categories cannot be moved.' });
      const group = await db.one('SELECT id, kind FROM category_groups WHERE id = $1', [Number(groupId)]);
      if (!group) return res.status(400).json({ error: 'That group does not exist.' });
      params.push(group.id);
      sets.push(`group_id = $${params.length}`);
      params.push(group.kind);
      sets.push(`kind = $${params.length}`);
    }
    if (!sets.length) return res.json({ groups: await categoryTree() });

    try {
      await db.query(`UPDATE categories SET ${sets.join(', ')} WHERE id = $1`, params);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'A category with that name already exists.' });
      throw err;
    }
    res.json({ groups: await categoryTree() });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cat = await db.one('SELECT * FROM categories WHERE id = $1', [id]);
    if (!cat) return res.status(404).json({ error: 'Category not found.' });
    if (cat.is_system) return res.status(400).json({ error: 'Built-in categories cannot be deleted.' });

    // Its transactions fall back to the catch-all for their kind, unlocked so
    // rules can place them again on the next import.
    const fallbackName = cat.kind === 'income' ? 'Other Income' : 'Uncategorized';
    await db.tx(async (q) => {
      const fallback = await q.one('SELECT id FROM categories WHERE name = $1', [fallbackName]);
      await q.query(
        'UPDATE transactions SET category_id = $1, category_locked = false WHERE category_id = $2',
        [fallback ? fallback.id : null, id]
      );
      await q.query('DELETE FROM categories WHERE id = $1', [id]);
    });
    res.json({ groups: await categoryTree() });
  } catch (err) { next(err); }
});

// --- rules ----------------------------------------------------------------

router.get('/rules/all', async (req, res, next) => {
  try {
    const rules = await db.many(
      `SELECT r.id, r.pattern, r.match_type, r.priority, r.auto,
              c.id AS category_id, c.name AS category_name, c.emoji AS category_emoji
         FROM category_rules r JOIN categories c ON c.id = r.category_id
        ORDER BY r.auto DESC, r.priority DESC, r.pattern`
    );
    res.json({ rules });
  } catch (err) { next(err); }
});

router.delete('/rules/:ruleId', async (req, res, next) => {
  try {
    await db.query('DELETE FROM category_rules WHERE id = $1', [Number(req.params.ruleId)]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
