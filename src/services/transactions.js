'use strict';
const db = require('../db');
const { prettyMerchant } = require('../utils/merchant');
const { monthRange } = require('../utils/dates');
const { round2 } = require('../utils/money');

// How a transaction counts: its category's kind, or — for the rare row with no
// category — its sign. Transfers count toward nothing.
const KIND_SQL = `COALESCE(c.kind, CASE WHEN t.amount > 0 THEN 'income' ELSE 'spending' END)`;

const FROM_SQL = `
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN category_groups g ON g.id = c.group_id`;

const SELECT_SQL = `
  SELECT t.id, t.posted_on, t.amount, t.description, t.merchant_key, t.notes,
         t.category_id, t.category_locked, t.needs_review, t.excluded, t.pending,
         t.account_id, a.name AS account_name, a.mask AS account_mask,
         c.name AS category_name, c.emoji AS category_emoji, g.name AS group_name,
         ${KIND_SQL} AS kind
  ${FROM_SQL}`;

function shape(r) {
  return {
    id: r.id,
    date: r.posted_on,
    amount: round2(r.amount),
    merchant: prettyMerchant(r.merchant_key),
    merchantKey: r.merchant_key,
    description: r.description,
    notes: r.notes,
    categoryId: r.category_id,
    categoryName: r.category_name,
    categoryEmoji: r.category_emoji,
    groupName: r.group_name,
    kind: r.kind,
    accountId: r.account_id,
    accountName: r.account_name,
    accountMask: r.account_mask,
    needsReview: r.needs_review,
    categoryLocked: r.category_locked,
    excluded: r.excluded,
    pending: r.pending,
  };
}

/**
 * Filters: month ('YYYY-MM'), start, end, search, categoryId, groupId,
 * accountId, merchantKey, review ('true'), type ('income' | 'spending' |
 * 'transfer'), limit, offset.
 */
async function listTransactions(filters = {}, q = db) {
  const where = ['a.archived = false'];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };

  if (filters.month) {
    const { start, end } = monthRange(String(filters.month));
    add('t.posted_on >= ?', start);
    add('t.posted_on <= ?', end);
  }
  if (filters.start) add('t.posted_on >= ?', String(filters.start));
  if (filters.end) add('t.posted_on <= ?', String(filters.end));
  if (filters.categoryId) add('t.category_id = ?', Number(filters.categoryId));
  if (filters.groupId) add('c.group_id = ?', Number(filters.groupId));
  if (filters.accountId) add('t.account_id = ?', Number(filters.accountId));
  if (filters.merchantKey) add('t.merchant_key = ?', String(filters.merchantKey));
  if (filters.review === 'true' || filters.review === true) where.push('t.needs_review = true');
  if (['income', 'spending', 'transfer'].includes(filters.type)) add(`${KIND_SQL} = ?`, filters.type);
  if (filters.search) {
    params.push(`%${String(filters.search).trim().toUpperCase()}%`);
    const p = `$${params.length}`;
    where.push(`(upper(t.description) LIKE ${p} OR t.merchant_key LIKE ${p}
                 OR upper(coalesce(t.notes, '')) LIKE ${p} OR upper(coalesce(c.name, '')) LIKE ${p})`);
  }

  const whereSql = where.join(' AND ');
  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
  const offset = Math.max(Number(filters.offset) || 0, 0);

  const rows = await q.many(
    `${SELECT_SQL} WHERE ${whereSql}
      ORDER BY t.posted_on DESC, t.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  const totals = await q.one(
    `SELECT COUNT(*)::int AS count,
            COALESCE(SUM(t.amount) FILTER (WHERE ${KIND_SQL} = 'income'), 0) AS income,
            COALESCE(-SUM(t.amount) FILTER (WHERE ${KIND_SQL} = 'spending'), 0) AS expenses
       ${FROM_SQL} WHERE ${whereSql} AND t.excluded = false`,
    params
  );

  return {
    transactions: rows.map(shape),
    totals: {
      count: totals.count,
      income: round2(totals.income),
      expenses: round2(totals.expenses),
    },
    limit,
    offset,
    hasMore: offset + rows.length < totals.count,
  };
}

async function getTransaction(id, q = db) {
  const row = await q.one(`${SELECT_SQL} WHERE t.id = $1`, [id]);
  return row ? shape(row) : null;
}

module.exports = { listTransactions, getTransaction, shape, KIND_SQL, FROM_SQL };
