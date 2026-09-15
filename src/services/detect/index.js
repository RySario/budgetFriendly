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

async function loadWindow() {
  const since = addDays(toISODate(new Date()), -LOOKBACK_DAYS);
  return db.many(
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

async function refreshSubscriptions(txns) {
  // Transfers and credit-card payments are recurring but are not subscriptions.
  const transferIds = new Set(
    (await db.many(`SELECT id FROM categories WHERE kind = 'transfer'`)).map((r) => r.id)
  );

  const candidates = detectRecurring(txns, 'out', { minOccurrences: 3 })
    .filter((s) => !transferIds.has(s.categoryId));

  const today = toISODate(new Date());
  const seen = new Set();

  for (const s of candidates) {
    seen.add(s.merchantKey);
    await db.query(
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
         category_id      = COALESCE(subscriptions.category_id, EXCLUDED.category_id),
         updated_at       = now()`,
      [
        s.merchantKey, s.name, s.amount, s.cadence, s.intervalDays, s.monthlyAmount,
        s.occurrences, s.confidence, s.firstSeenOn, s.lastSeenOn,
        s.nextExpectedOn, s.categoryId,
      ]
    );
  }

  // A previously detected subscription that no longer shows a recurring pattern
  // and has gone quiet is marked cancelled — unless the user confirmed it, in
  // which case leave their decision alone.
  const stale = await db.many(
    `SELECT id, merchant_key, last_charged_on, interval_days, status
       FROM subscriptions WHERE status = 'detected'`
  );
  for (const row of stale) {
    if (seen.has(row.merchant_key)) continue;
    const gone = !isActive(
      { lastSeenOn: toISODate(row.last_charged_on), intervalDays: row.interval_days },
      today
    );
    if (gone) {
      await db.query(
        `UPDATE subscriptions SET status = 'cancelled', updated_at = now() WHERE id = $1`,
        [row.id]
      );
    }
  }

  return candidates.length;
}

async function refreshIncome(txns) {
  const transferIds = new Set(
    (await db.many(`SELECT id FROM categories WHERE kind = 'transfer'`)).map((r) => r.id)
  );

  // Paychecks keep a steady cadence but not a steady amount — hours, overtime
  // and bonuses move it around — so income tolerates far more amount variation
  // than subscriptions do. Refunds and one-off reimbursements still fall out on
  // cadence regularity and the minimum amount below.
  const candidates = detectRecurring(txns, 'in', {
    minOccurrences: 3,
    maxAmountVariation: 0.6,
    minRegularity: 0.6,
  })
    .filter((s) => !transferIds.has(s.categoryId))
    .filter((s) => s.amount >= 50);

  for (const s of candidates) {
    await db.query(
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
  return candidates.length;
}

/**
 * Monthly income estimate: the manual override if one is set, otherwise the sum
 * of every active, non-dismissed recurring inflow normalised to a month.
 */
async function estimateMonthlyIncome() {
  const override = await db.one(`SELECT value FROM settings WHERE key = 'income_override'`);
  const sources = await db.many(
    `SELECT * FROM income_sources WHERE status <> 'dismissed' ORDER BY monthly_amount DESC`
  );
  const today = toISODate(new Date());
  const active = sources.filter((s) =>
    isActive({ lastSeenOn: toISODate(s.last_seen_on), intervalDays: s.interval_days }, today)
  );

  const detected = round2(sum(active.map((s) => s.monthly_amount)));
  const manual = override && override.value && override.value.amount != null
    ? round2(Number(override.value.amount))
    : null;

  return {
    detected,
    manual,
    effective: manual != null ? manual : detected,
    isOverridden: manual != null,
    sources: active,
    inactiveSources: sources.filter((s) => !active.includes(s)),
  };
}

async function runDetection() {
  const txns = await loadWindow();
  const subs = await refreshSubscriptions(txns);
  const income = await refreshIncome(txns);
  return { transactionsScanned: txns.length, subscriptionsFound: subs, incomeSourcesFound: income };
}

module.exports = { runDetection, estimateMonthlyIncome, LOOKBACK_DAYS };
