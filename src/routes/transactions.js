'use strict';
const express = require('express');
const db = require('../db');
const {
  overrideCategory, categorizeAll, renormaliseMerchants,
} = require('../services/detect/categorize');
const { runDetection } = require('../services/detect');
const { normaliseMerchant } = require('../utils/merchant');
const { importHash } = require('../utils/crypto');
const { round2 } = require('../utils/money');
const { toISODate } = require('../utils/dates');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const {
      month, from, to, categoryId, accountId, search,
      direction, limit = 100, offset = 0, uncategorised,
    } = req.query;

    const where = ['a.archived = false'];
    const params = [];

    if (month) {
      params.push(`${month}-01`);
      where.push(`date_trunc('month', t.posted_on) = date_trunc('month', $${params.length}::date)`);
    }
    if (from) { params.push(from); where.push(`t.posted_on >= $${params.length}`); }
    if (to) { params.push(to); where.push(`t.posted_on <= $${params.length}`); }
    if (categoryId) { params.push(categoryId); where.push(`t.category_id = $${params.length}`); }
    if (accountId) { params.push(accountId); where.push(`t.account_id = $${params.length}`); }
    if (direction === 'in') where.push('t.amount > 0');
    if (direction === 'out') where.push('t.amount < 0');
    if (uncategorised === 'true') {
      where.push(`(t.category_id IS NULL OR c.name = 'Uncategorized')`);
    }
    if (search) {
      params.push(`%${String(search).toUpperCase()}%`);
      where.push(`(upper(t.description) LIKE $${params.length} OR t.merchant_key LIKE $${params.length})`);
    }

    params.push(Math.min(Number(limit) || 100, 500));
    const limitParam = params.length;
    params.push(Number(offset) || 0);
    const offsetParam = params.length;

    const rows = await db.many(
      `SELECT t.*, c.name AS category_name, c.color AS category_color, c.kind AS category_kind,
              a.name AS account_name, a.mask AS account_mask
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE ${where.join(' AND ')}
        ORDER BY t.posted_on DESC, t.id DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}`,
      params
    );

    const totals = await db.one(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 0) AS spent,
              COALESCE(SUM(CASE WHEN t.amount > 0 THEN  t.amount ELSE 0 END), 0) AS received
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE ${where.join(' AND ')}`,
      params.slice(0, params.length - 2)
    );

    res.json({
      transactions: rows,
      totals: {
        count: totals.count,
        spent: round2(Number(totals.spent)),
        received: round2(Number(totals.received)),
      },
    });
  } catch (err) { next(err); }
});

/** Manual entry, for cash or anything the bank does not show. */
router.post('/', async (req, res, next) => {
  try {
    const { accountId, postedOn, amount, description, categoryId } = req.body || {};
    const date = toISODate(postedOn);
    const amt = round2(Number(amount));
    if (!accountId || !date || !Number.isFinite(amt) || !description) {
      return res.status(400).json({ error: 'accountId, postedOn, amount and description are required.' });
    }
    const merchantKey = normaliseMerchant(description);
    const row = await db.one(
      `INSERT INTO transactions
         (account_id, import_hash, posted_on, amount, description, merchant_raw,
          merchant_key, category_id, category_locked, source)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,'manual') RETURNING *`,
      [
        accountId,
        importHash(['manual', String(accountId), date, amt.toFixed(2), description, String(Date.now())]),
        date, amt, description, merchantKey,
        categoryId || null, Boolean(categoryId),
      ]
    );
    res.status(201).json({ transaction: row });
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { categoryId, excluded, notes, learn } = req.body || {};
    let row = null;

    if (categoryId !== undefined) {
      row = await overrideCategory(req.params.id, categoryId, { learn: learn !== false });
      if (!row) return res.status(404).json({ error: 'Transaction not found.' });
    }
    if (excluded !== undefined) {
      row = await db.one(
        'UPDATE transactions SET excluded = $2 WHERE id = $1 RETURNING *',
        [req.params.id, Boolean(excluded)]
      );
    }
    if (notes !== undefined) {
      row = await db.one(
        'UPDATE transactions SET notes = $2 WHERE id = $1 RETURNING *',
        [req.params.id, notes || null]
      );
    }
    if (!row) return res.status(400).json({ error: 'Nothing to update.' });
    res.json({ transaction: row });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await db.query('DELETE FROM transactions WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** Re-run categorisation and recurrence detection across everything. */
router.post('/reanalyze', async (req, res, next) => {
  try {
    const onlyUncategorised = req.body && req.body.all === true ? false : true;
    const renormalised = await renormaliseMerchants();
    const categorised = await categorizeAll({ onlyUncategorised });
    const detection = await runDetection();
    res.json({ renormalised, categorised, detection });
  } catch (err) { next(err); }
});

module.exports = router;
