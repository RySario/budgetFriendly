'use strict';
const db = require('../../db');

// Rule-based categorisation. Rules are matched against the normalised merchant
// key and the raw description, highest priority first. A transaction the user
// has manually re-categorised is marked category_locked and is never touched
// again by this pass.

function ruleMatches(rule, merchantKey, description) {
  const pattern = rule.pattern.toUpperCase();
  const hay = `${merchantKey} ${description || ''}`.toUpperCase();
  switch (rule.match_type) {
    case 'equals':
      return merchantKey.toUpperCase() === pattern;
    case 'regex':
      try {
        return new RegExp(rule.pattern, 'i').test(hay);
      } catch {
        return false; // a bad user-supplied regex must not break the import
      }
    case 'contains':
    default:
      return hay.includes(pattern);
  }
}

async function loadRules() {
  return db.many(
    `SELECT r.id, r.category_id, r.match_type, r.pattern, r.priority
       FROM category_rules r
      ORDER BY r.priority DESC, length(r.pattern) DESC, r.id`
  );
}

function pickCategory(rules, merchantKey, description) {
  for (const rule of rules) {
    if (ruleMatches(rule, merchantKey, description)) return rule.category_id;
  }
  return null;
}

/**
 * Categorise transactions that have no manual override.
 * @param {object} opts.onlyUncategorised  skip rows that already have a category
 * @returns {number} rows updated
 */
async function categorizeAll({ onlyUncategorised = false } = {}) {
  const rules = await loadRules();
  const fallback = await db.one(`SELECT id FROM categories WHERE name = 'Uncategorized'`);
  const income = await db.one(`SELECT id FROM categories WHERE name = 'Income'`);

  const where = onlyUncategorised
    ? 'AND (t.category_id IS NULL)'
    : '';

  const rows = await db.many(
    `SELECT t.id, t.merchant_key, t.description, t.amount, t.category_id
       FROM transactions t
      WHERE t.category_locked = false ${where}`
  );

  let updated = 0;
  for (const t of rows) {
    let categoryId = pickCategory(rules, t.merchant_key, t.description);

    // Unmatched inflows are income far more often than they are anything else.
    if (!categoryId && Number(t.amount) > 0 && income) categoryId = income.id;
    if (!categoryId && fallback) categoryId = fallback.id;

    if (categoryId && categoryId !== t.category_id) {
      await db.query('UPDATE transactions SET category_id = $1 WHERE id = $2', [categoryId, t.id]);
      updated += 1;
    }
  }
  return updated;
}

/**
 * Apply a manual override. Locks the row, and optionally writes a learned rule
 * so future transactions from the same merchant land in the same place.
 */
async function overrideCategory(transactionId, categoryId, { learn = true } = {}) {
  const txn = await db.one('SELECT * FROM transactions WHERE id = $1', [transactionId]);
  if (!txn) return null;

  await db.query(
    'UPDATE transactions SET category_id = $1, category_locked = true WHERE id = $2',
    [categoryId, transactionId]
  );

  if (learn && categoryId && txn.merchant_key && txn.merchant_key !== 'UNKNOWN') {
    // Learned rules outrank the seeded ones so the user's choice wins.
    await db.query(
      `INSERT INTO category_rules (category_id, match_type, pattern, priority, auto)
       VALUES ($1, 'equals', $2, 500, true)
       ON CONFLICT DO NOTHING`,
      [categoryId, txn.merchant_key]
    );
    // Re-point other unlocked transactions from the same merchant.
    await db.query(
      `UPDATE transactions SET category_id = $1
        WHERE merchant_key = $2 AND category_locked = false`,
      [categoryId, txn.merchant_key]
    );
  }

  return db.one('SELECT * FROM transactions WHERE id = $1', [transactionId]);
}

module.exports = { categorizeAll, overrideCategory, pickCategory, loadRules };
