'use strict';
const express = require('express');
const db = require('../db');
const { listTransactions, getTransaction } = require('../services/transactions');
const { overrideCategory } = require('../services/detect/categorize');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    res.json(await listTransactions(req.query));
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const transaction = await getTransaction(Number(req.params.id));
    if (!transaction) return res.status(404).json({ error: 'Transaction not found.' });
    res.json({ transaction });
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await getTransaction(id))) return res.status(404).json({ error: 'Transaction not found.' });

    const { categoryId, applyToMerchant, notes, excluded, needsReview } = req.body || {};
    let alsoUpdated = 0;

    if (categoryId !== undefined) {
      if (!categoryId) return res.status(400).json({ error: 'Choose a category.' });
      const out = await overrideCategory(id, Number(categoryId), { applyToMerchant: Boolean(applyToMerchant) });
      alsoUpdated = out.alsoUpdated;
    }
    if (notes !== undefined) {
      await db.query('UPDATE transactions SET notes = $2 WHERE id = $1', [id, String(notes).trim() || null]);
    }
    if (excluded !== undefined) {
      await db.query('UPDATE transactions SET excluded = $2 WHERE id = $1', [id, Boolean(excluded)]);
    }
    if (needsReview !== undefined) {
      await db.query('UPDATE transactions SET needs_review = $2 WHERE id = $1', [id, Boolean(needsReview)]);
    }

    res.json({ transaction: await getTransaction(id), alsoUpdated });
  } catch (err) { next(err); }
});

/** Mark transactions reviewed: { ids: [...] } or { all: true }. */
router.post('/review', async (req, res, next) => {
  try {
    const { ids, all } = req.body || {};
    let result;
    if (all === true) {
      result = await db.query('UPDATE transactions SET needs_review = false WHERE needs_review');
    } else if (Array.isArray(ids) && ids.length) {
      result = await db.query(
        'UPDATE transactions SET needs_review = false WHERE id = ANY($1::bigint[])',
        [ids.map(Number).filter(Number.isFinite)]
      );
    } else {
      return res.status(400).json({ error: 'Pass ids or all: true.' });
    }
    res.json({ updated: result.rowCount });
  } catch (err) { next(err); }
});

module.exports = router;
