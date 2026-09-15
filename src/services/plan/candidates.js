'use strict';
const { detectRecurring, isActive } = require('../detect/recurrence');
const { INCOME_OPTIONS } = require('../detect');
const { expectedDates } = require('../recurring');
const { addDays } = require('../../utils/dates');

// Deposits that repeat on a pay-like schedule. Import-time detection decides on
// its own; this list is for a person to choose from, so it is looser — a
// paycheck that swings with overtime still shows up. Each entry says whether it
// would also pass the strict rules (strong) and whether it is still arriving
// (active), so the plan can use a strong, active one without asking.

const PAY_CADENCES = new Set(['weekly', 'biweekly', 'semimonthly', 'monthly']);
const MIN_PAYCHECK = 100;
const LOOSE_OPTIONS = { minOccurrences: 3, maxAmountVariation: 1, minRegularity: 0.5 };
const MAX_CANDIDATES = 5;

function nextPayday(series, today) {
  return expectedDates(series.lastSeenOn, series.cadence, series.intervalDays,
    addDays(today, 1), addDays(today, 70))[0] || null;
}

/**
 * @param txns  rows with {posted_on, amount, merchant_key, description, category_id, excluded}
 * @param opts.transferIds  category ids that are transfers, never a paycheck
 * @param opts.dismissed    merchant keys the user said are not recurring income
 */
function paycheckCandidates(txns, today, { transferIds = new Set(), dismissed = new Set() } = {}) {
  const usable = txns.filter((t) => !transferIds.has(t.category_id) && !dismissed.has(t.merchant_key));
  const strict = new Set(detectRecurring(usable, 'in', INCOME_OPTIONS).map((s) => s.merchantKey));

  return detectRecurring(usable, 'in', LOOSE_OPTIONS)
    .filter((s) => PAY_CADENCES.has(s.cadence) && s.amount >= MIN_PAYCHECK)
    .map((s) => ({
      merchantKey: s.merchantKey,
      name: s.name,
      description: s.exampleDescription,
      amount: s.amount,
      cadence: s.cadence,
      intervalDays: s.intervalDays,
      monthlyAmount: s.monthlyAmount,
      occurrences: s.occurrences,
      firstSeenOn: s.firstSeenOn,
      lastSeenOn: s.lastSeenOn,
      strong: strict.has(s.merchantKey),
      active: isActive({ lastSeenOn: s.lastSeenOn, intervalDays: s.intervalDays }, today),
      nextPayday: nextPayday(s, today),
    }))
    .sort((a, b) => (b.active - a.active) || (b.strong - a.strong) || (b.monthlyAmount - a.monthlyAmount))
    .slice(0, MAX_CANDIDATES);
}

module.exports = { paycheckCandidates };
