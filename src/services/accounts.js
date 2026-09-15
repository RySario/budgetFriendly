'use strict';
const db = require('../db');
const { round2, sum } = require('../utils/money');

async function listAccounts(q = db) {
  const rows = await q.many(
    `SELECT a.id, a.name, a.type, a.subtype, a.mask, a.current_balance, a.available_balance,
            a.balance_as_of, a.archived,
            COUNT(t.id)::int AS transaction_count,
            MIN(t.posted_on) AS first_on, MAX(t.posted_on) AS last_on
       FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
      GROUP BY a.id
      ORDER BY a.archived, a.type NULLS LAST, a.name`
  );

  const accounts = rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    subtype: r.subtype,
    mask: r.mask,
    balance: r.current_balance == null ? null : round2(r.current_balance),
    available: r.available_balance == null ? null : round2(r.available_balance),
    balanceAsOf: r.balance_as_of,
    archived: r.archived,
    transactionCount: r.transaction_count,
    firstOn: r.first_on,
    lastOn: r.last_on,
  }));

  const live = accounts.filter((a) => !a.archived && a.balance != null);
  const assets = round2(sum(live.filter((a) => a.balance > 0).map((a) => a.balance)));
  const liabilities = round2(sum(live.filter((a) => a.balance < 0).map((a) => -a.balance)));
  return { accounts, netWorth: round2(assets - liabilities), assets, liabilities };
}

module.exports = { listAccounts };
