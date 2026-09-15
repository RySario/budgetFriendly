'use strict';
const express = require('express');
const db = require('../db');
const { listAccounts } = require('../services/accounts');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    res.json(await listAccounts());
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { name, archived } = req.body || {};
    const sets = [];
    const params = [Number(req.params.id)];
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) return res.status(400).json({ error: 'Account name cannot be empty.' });
      params.push(trimmed);
      sets.push(`name = $${params.length}`);
    }
    if (archived !== undefined) {
      params.push(Boolean(archived));
      sets.push(`archived = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

    const row = await db.one(
      `UPDATE accounts SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id`,
      params
    );
    if (!row) return res.status(404).json({ error: 'Account not found.' });
    res.json(await listAccounts());
  } catch (err) { next(err); }
});

module.exports = router;
