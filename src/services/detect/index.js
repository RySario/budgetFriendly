'use strict';
const db = require('../../db');
const { detectRecurring, isActive } = require('./recurrence');
const { toISODate, addDays } = require('../../utils/dates');
const { round2, sum } = require('../../utils/money');

// Detection runs over a rolling window after every import, then reconciles its
// findings into the subscriptions / income_sources tables. Reconciling rather
// than replacing matters: a row the user has confirmed or dismissed keeps that
// decision across re-runs, and only its numbers get refreshed.

const LOOKBACK_DAYS = 400;

// Paychecks keep a steady cadence but not a steady amount — hours, overtime
// and bonuses move it around — so income tolerates far more amount variation
// than subscriptions do. Refunds and one-off reimbursements still fall out on
// cadence regularity and the minimum amount.
const INCOME_OPTIONS = { minOccurrences: 3, maxAmountVariation: 0.6, minRegularity: 0.6 };
const MIN_INCOME_AMOUNT = 50;

async function loadWindow(q) {
  const since = addDays(toISODate(new Date()), -LOOKBACK_DAYS);
  return q.many(
    `SELECT t.id, t.posted_on, t.amount, t.description, t.merchant_key,
            t.category_id, t.excluded
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.posted_on >= $1
        AND t.pending = false
        AND a.archived = false
      ORDER BY t.posted_on`,
    [since]
  );
}

async function transferCategoryIds(q) {
  const rows = await q.many(`SELECT id FROM categories WHERE kind = 'transfer'`);
  return new Set(rows.map((r) => r.id));
}

async function refreshSubscriptions(q, txns, transferIds) {
  // Transfers and credit-card payments are recurring but are not bills.
  const candidates = detectRecurring(txns, 'out', { minOccurrences: 3 })
    .filter((s) => !transferIds.has(s.categoryId));

  const today = toISODate(new Date());
  const seen = new Set();

  for (const s of candidates) {
    seen.add(s.merchantKey);
    await q.query(
      `INSERT INTO subscriptions
         (merchant_key, name, amount, cadence, interval_days, monthly_amount,
          occurrences, confidence, first_seen_on, last_charged_on,
          next_expected_on, category_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       ON CONFLICT (merchant_key) DO UPDATE SET
         amount           = EXCLUDED.amount,
         cadence          = EXCLUDED.cadence,
         interval_days    = EXCLUDED.interval_days,
         monthly_amount   = EXCLUDED.monthly_amount,
         occurrences      = EXCLUDED.occurrences,
         confidence       = EXCLUDED.confidence,
         first_seen_on    = LEAST(subscriptions.first_seen_on, EXCLUDED.first_seen_on),
         last_charged_on  = EXCLUDED.last_charged_on,
         next_expected_on = EXCLUDED.next_expected_on,
         category_id      = EXCLUDED.category_id,
         status           = CASE WHEN subscriptions.status = 'cancelled'
                                 THEN 'detected' ELSE subscriptions.status END,
         updated_at       = now()`,
      [
        s.merchantKey, s.name, s.amount, s.cadence, s.intervalDays, s.monthlyAmount,
        s.occurrences, s.confidence, s.firstSeenOn, s.lastSeenOn,
        s.nextExpectedOn, s.categoryId,
      ]
    );
  }

  // A detected series that no longer recurs and has gone quiet is marked
  // cancelled — unless the user confirmed it, in which case their call stands.
  const stale = await q.many(
    `SELECT id, merchant_key, last_charged_on, interval_days
       FROM subscriptions WHERE status = 'detected'`
  );
  const cancel = stale
    .filter((row) => !seen.has(row.merchant_key))
    .filter((row) => !isActive(
      { lastSeenOn: toISODate(row.last_charged_on), intervalDays: row.interval_days }, today
    ))
    .map((row) => row.id);
  if (cancel.length) {
    await q.query(
      `UPDATE subscriptions SET status = 'cancelled', updated_at = now() WHERE id = ANY($1::bigint[])`,
      [cancel]
    );
  }

  return candidates.length;
}

async function refreshIncome(q, txns, transferIds) {
  const candidates = detectRecurring(txns, 'in', INCOME_OPTIONS)
    .filter((s) => !transferIds.has(s.categoryId))
    .filter((s) => s.amount >= MIN_INCOME_AMOUNT);

  for (const s of candidates) {
    await q.query(
      `INSERT INTO income_sources
         (merchant_key, name, amount, cadence, interval_days, monthly_amount,
          occurrences, confidence, first_seen_on, last_seen_on, next_expected_on, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (merchant_key) DO UPDATE SET
         amount           = EXCLUDED.amount,
         cadence          = EXCLUDED.cadence,
         interval_days    = EXCLUDED.interval_days,
         monthly_amount   = EXCLUDED.monthly_amount,
         occurrences      = EXCLUDED.occurrences,
         confidence       = EXCLUDED.confidence,
         first_seen_on    = LEAST(income_sources.first_seen_on, EXCLUDED.first_seen_on),
         last_seen_on     = EXCLUDED.last_seen_on,
         next_expected_on = EXCLUDED.next_expected_on,
         updated_at       = now()`,
      [
        s.merchantKey, s.name, s.amount, s.cadence, s.intervalDays, s.monthlyAmount,
        s.occurrences, s.confidence, s.firstSeenOn, s.lastSeenOn, s.nextExpectedOn,
      ]
    );
  }

  // Deposits behind a detected paycheck belong in Paychecks rather than the
  // generic Other Income that unmatched inflows fall into.
  if (candidates.length) {
    const paychecks = await q.one(`SELECT id FROM categories WHERE name = 'Paychecks'`);
    const other = await q.one(`SELECT id FROM categories WHERE name = 'Other Income'`);
    if (paychecks) {
      await q.query(
        `UPDATE transactions SET category_id = $1
          WHERE merchant_key = ANY($2::text[])
            AND amount > 0
            AND category_locked = false
            AND (category_id IS NULL OR category_id = $3::bigint)`,
        [paychecks.id, candidates.map((c) => c.merchantKey), other ? other.id : null]
      );
    }
  }

  return candidates.length;
}

/** Detected monthly income: every active, non-dismissed recurring inflow. */
async function estimateMonthlyIncome(q = db) {
  const sources = await q.many(
    `SELECT * FROM income_sources WHERE status <> 'dismissed' ORDER BY monthly_amount DESC`
  );
  const today = toISODate(new Date());
  const active = sources.filter((s) =>
    isActive({ lastSeenOn: toISODate(s.last_seen_on), intervalDays: s.interval_days }, today)
  );
  return {
    detected: round2(sum(active.map((s) => s.monthly_amount))),
    sources: active,
  };
}

async function runDetection(q = db) {
  const txns = await loadWindow(q);
  const transferIds = await transferCategoryIds(q);
  const subs = await refreshSubscriptions(q, txns, transferIds);
  const income = await refreshIncome(q, txns, transferIds);
  return { transactionsScanned: txns.length, subscriptionsFound: subs, incomeSourcesFound: income };
}

module.exports = { runDetection, estimateMonthlyIncome, LOOKBACK_DAYS, INCOME_OPTIONS };
