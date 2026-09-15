'use strict';
const db = require('../../db');
const { normaliseMerchant } = require('../../utils/merchant');

// Rule-based categorisation. Rules are matched against the normalised merchant
// key and the raw description, highest priority first. A transaction the user
// has manually re-categorised is marked category_locked and is never touched
// again by this pass.
//
// Every function takes `q` (see db.scope) so an import can run the whole
// pipeline inside one transaction. Writes are batched into single statements:
// hundreds of one-row UPDATEs each waiting on a disk flush is what made imports
// slow enough to time out.

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

async function loadRules(q = db) {
  return q.many(
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
 * Categorise every transaction without a manual override.
 * @param {object} opts.onlyUncategorised  skip rows that already have a category
 * @returns {number} rows updated
 */
async function categorizeAll({ onlyUncategorised = false } = {}, q = db) {
  const rules = await loadRules(q);
  const fallback = await q.one(`SELECT id FROM categories WHERE name = 'Uncategorized'`);
  const otherIncome = await q.one(`SELECT id FROM categories WHERE name = 'Other Income'`);

  const rows = await q.many(
    `SELECT t.id, t.merchant_key, t.description, t.amount, t.category_id
       FROM transactions t
      WHERE t.category_locked = false
        ${onlyUncategorised ? 'AND t.category_id IS NULL' : ''}`
  );

  const ids = [];
  const categories = [];
  for (const t of rows) {
    let categoryId = pickCategory(rules, t.merchant_key, t.description);
    // Unmatched inflows are income far more often than anything else; detection
    // later promotes the recurring ones to Paychecks.
    if (!categoryId && Number(t.amount) > 0 && otherIncome) categoryId = otherIncome.id;
    if (!categoryId && fallback) categoryId = fallback.id;

    if (categoryId && categoryId !== t.category_id) {
      ids.push(t.id);
      categories.push(categoryId);
    }
  }

  if (ids.length) {
    await q.query(
      `UPDATE transactions t SET category_id = v.category_id
         FROM unnest($1::bigint[], $2::bigint[]) AS v(id, category_id)
        WHERE t.id = v.id`,
      [ids, categories]
    );
  }
  return ids.length;
}

/**
 * Apply a manual category. Locks the row and marks it reviewed. With
 * applyToMerchant, also writes a rule for the merchant and moves every other
 * unlocked transaction from it, so the choice sticks for future imports.
 * @returns {{ transaction: object, alsoUpdated: number } | null}
 */
async function overrideCategory(transactionId, categoryId, { applyToMerchant = false } = {}, q = db) {
  const txn = await q.one('SELECT * FROM transactions WHERE id = $1', [transactionId]);
  if (!txn) return null;

  await q.query(
    `UPDATE transactions
        SET category_id = $1, category_locked = true, needs_review = false
      WHERE id = $2`,
    [categoryId, transactionId]
  );

  let alsoUpdated = 0;
  if (applyToMerchant && txn.merchant_key && txn.merchant_key !== 'UNKNOWN') {
    // One learned rule per merchant: replace any earlier choice for it.
    await q.query(
      `DELETE FROM category_rules WHERE auto = true AND match_type = 'equals' AND pattern = $1`,
      [txn.merchant_key]
    );
    // Learned rules outrank the seeded ones (100) and built-in overrides (300).
    await q.query(
      `INSERT INTO category_rules (category_id, match_type, pattern, priority, auto)
       VALUES ($1, 'equals', $2, 500, true)
       ON CONFLICT (category_id, match_type, pattern) DO UPDATE SET priority = 500, auto = true`,
      [categoryId, txn.merchant_key]
    );
    const res = await q.query(
      `UPDATE transactions SET category_id = $1
        WHERE merchant_key = $2 AND category_locked = false AND id <> $3`,
      [categoryId, txn.merchant_key, transactionId]
    );
    alsoUpdated = res.rowCount;
  }

  return { transaction: await q.one('SELECT * FROM transactions WHERE id = $1', [transactionId]), alsoUpdated };
}

/**
 * Recompute merchant keys from the stored raw names. Keys are derived data, so
 * when normalisation improves, existing rows have to follow — otherwise old and
 * new transactions from the same merchant stop grouping together.
 * @returns {number} rows whose key changed
 */
async function renormaliseMerchants(q = db) {
  const rows = await q.many('SELECT id, merchant_raw, description, merchant_key FROM transactions');
  const ids = [];
  const keys = [];
  for (const t of rows) {
    const key = normaliseMerchant(t.merchant_raw || t.description);
    if (key !== t.merchant_key) {
      ids.push(t.id);
      keys.push(key);
    }
  }
  if (ids.length) {
    await q.query(
      `UPDATE transactions t SET merchant_key = v.merchant_key
         FROM unnest($1::bigint[], $2::text[]) AS v(id, merchant_key)
        WHERE t.id = v.id`,
      [ids, keys]
    );
  }
  return ids.length;
}

module.exports = {
  categorizeAll, overrideCategory, pickCategory, loadRules, renormaliseMerchants,
};
