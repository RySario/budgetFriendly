'use strict';
const db = require('../../db');
const { estimateMonthlyIncome, LOOKBACK_DAYS } = require('../detect');
const { isActive } = require('../detect/recurrence');
const { KIND_SQL, FROM_SQL } = require('../transactions');
const { allGoalProgress } = require('../budget');
const { recurringInRange, expectedDates } = require('../recurring');
const { round2, sum } = require('../../utils/money');
const { toISODate, addDays, daysBetween, currentMonthKey } = require('../../utils/dates');
const { paychecksPerYear, perPaycheck, buildPlan } = require('./math');
const { paycheckCandidates } = require('./candidates');

// The paycheck plan: how much you can spend between paydays and still pay your
// bills and reach your goals on time. The paycheck is, in order: one you've
// entered, detected income stored by the last upload, or — because stored
// detection only refreshes on upload — a strong, still-arriving series found
// in the transactions right now. Without any of those, the plan says what it
// did find so you can pick.

const SETTINGS_KEY = 'paycheck_plan';
const CADENCE_DAYS = { weekly: 7, biweekly: 14, semimonthly: 15, monthly: 30 };
// A charge from a bill's merchant within this share of the bill's amount is
// the bill, not everyday spending.
const BILL_AMOUNT_TOLERANCE = 0.25;
const TYPICAL_LOOKBACK_DAYS = 90;

async function loadSettings(q = db) {
  const row = await q.one('SELECT value FROM settings WHERE key = $1', [SETTINGS_KEY]);
  return (row && row.value) || {};
}

/** Merge into the stored plan settings; a null value removes that key. */
async function saveSettings(changes, q = db) {
  const next = { ...(await loadSettings(q)), ...changes };
  for (const [k, v] of Object.entries(next)) if (v == null) delete next[k];
  await q.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [SETTINGS_KEY, JSON.stringify(next)]
  );
  return next;
}

function manualPaycheck(manual) {
  return {
    source: 'manual',
    name: manual.name || 'Your paycheck',
    amount: round2(manual.amount),
    cadence: manual.cadence,
    intervalDays: CADENCE_DAYS[manual.cadence],
    anchor: manual.anchorDate,
    perYear: paychecksPerYear(manual.cadence),
    sources: [],
  };
}

/**
 * One paycheck from one or more income series. The largest sets the pay
 * schedule; every other series is spread across it.
 * list: [{ name, amount, cadence, intervalDays, monthlyAmount, lastSeenOn }]
 */
function describePaycheck(list, source) {
  const sorted = [...list].sort((a, b) => b.monthlyAmount - a.monthlyAmount);
  const primary = sorted[0];
  const perYear = paychecksPerYear(primary.cadence, primary.intervalDays);
  return {
    source,
    name: primary.name,
    amount: perPaycheck(sum(sorted.map((s) => s.monthlyAmount)), perYear),
    cadence: primary.cadence,
    intervalDays: primary.intervalDays,
    anchor: primary.lastSeenOn,
    perYear,
    sources: sorted.map((s) => ({ name: s.name, amount: round2(s.amount), cadence: s.cadence })),
  };
}

const fromIncomeSource = (s) => ({
  name: s.name,
  amount: Number(s.amount),
  cadence: s.cadence,
  intervalDays: s.interval_days,
  monthlyAmount: Number(s.monthly_amount),
  lastSeenOn: toISODate(s.last_seen_on),
});

async function liveCandidates(today, q) {
  const rows = await q.many(
    `SELECT t.posted_on, t.amount, t.merchant_key, t.description, t.category_id, t.excluded
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.posted_on >= $1 AND t.amount > 0 AND t.pending = false AND a.archived = false`,
    [addDays(today, -LOOKBACK_DAYS)]
  );
  const transfers = await q.many(`SELECT id FROM categories WHERE kind = 'transfer'`);
  const dismissed = await q.many(`SELECT merchant_key FROM income_sources WHERE status = 'dismissed'`);
  return paycheckCandidates(rows, today, {
    transferIds: new Set(transfers.map((r) => r.id)),
    dismissed: new Set(dismissed.map((r) => r.merchant_key)),
  });
}

/** What the plan looked at when it couldn't settle on a paycheck. */
async function diagnose(candidates, q) {
  const totals = await q.one('SELECT COUNT(*)::int AS n, MAX(posted_on) AS last FROM transactions');
  const dismissed = await q.many(
    `SELECT id, name, amount, cadence FROM income_sources
      WHERE status = 'dismissed' ORDER BY monthly_amount DESC LIMIT 3`
  );
  return {
    transactions: (totals && totals.n) || 0,
    lastTransactionOn: totals && totals.last ? toISODate(totals.last) : null,
    dismissed: dismissed.map((s) => ({ id: s.id, name: s.name, amount: round2(s.amount), cadence: s.cadence })),
    candidates: candidates || [],
  };
}

/** The pay period today falls in: the last payday through the day before the next. */
function payPeriod(paycheck, today) {
  const reach = Math.max(120, paycheck.intervalDays * 2 + 10);
  const dates = expectedDates(paycheck.anchor, paycheck.cadence, paycheck.intervalDays,
    addDays(today, -reach), addDays(today, reach));
  const step = Math.round(365.25 / paycheck.perYear);
  const past = dates.filter((d) => d <= today);
  const start = past.length ? past[past.length - 1] : addDays(today, -step + 1);
  const nextPayday = dates.find((d) => d > today) || addDays(start, step);
  return {
    start,
    end: addDays(nextPayday, -1),
    nextPayday,
    daysLeft: Math.max(1, daysBetween(today, nextPayday)),
  };
}

async function activeBills(today, q) {
  const rows = await q.many(
    `SELECT s.id, s.name, s.merchant_key, s.amount, s.monthly_amount, s.cadence,
            s.interval_days, s.last_charged_on, c.emoji
       FROM subscriptions s LEFT JOIN categories c ON c.id = s.category_id
      WHERE s.status IN ('detected', 'confirmed')`
  );
  return rows
    .filter((s) => isActive({ lastSeenOn: toISODate(s.last_charged_on), intervalDays: s.interval_days }, today))
    .map((s) => ({
      id: s.id,
      name: s.name,
      merchantKey: s.merchant_key,
      emoji: s.emoji,
      amount: round2(s.amount),
      monthlyAmount: round2(s.monthly_amount),
      cadence: s.cadence,
    }));
}

function isBillPayment(t, bills) {
  if (Number(t.amount) >= 0) return false;
  const paid = Math.abs(Number(t.amount));
  return bills.some((b) => b.merchantKey === t.merchant_key
    && Math.abs(paid - b.amount) <= b.amount * BILL_AMOUNT_TOLERANCE);
}

/** Net everyday spending in a range: spending categories, less bill payments. */
async function everydaySpending(start, end, bills, q) {
  if (start > end) return 0;
  const rows = await q.many(
    `SELECT t.amount, t.merchant_key
       ${FROM_SQL}
      WHERE t.excluded = false AND a.archived = false
        AND ${KIND_SQL} = 'spending' AND t.posted_on BETWEEN $1 AND $2`,
    [start, end]
  );
  return round2(-sum(rows.filter((t) => !isBillPayment(t, bills)).map((t) => t.amount)));
}

/** Average everyday spending per paycheck over the recent past, or null without enough history. */
async function typicalSpending(periodStart, periodDays, bills, q) {
  const row = await q.one('SELECT MIN(posted_on) AS first FROM transactions');
  const first = row && row.first ? toISODate(row.first) : null;
  if (!first) return null;
  const end = addDays(periodStart, -1);
  const lookback = addDays(periodStart, -TYPICAL_LOOKBACK_DAYS);
  const start = first > lookback ? first : lookback;
  const days = daysBetween(start, end) + 1;
  if (days < periodDays) return null;
  return round2(((await everydaySpending(start, end, bills, q)) / days) * periodDays);
}

/**
 * The plan for the current pay period.
 * spend: undefined plans with the saved budget; null previews the
 * recommendation; a number previews that amount. Previews change nothing.
 */
async function paycheckPlan({ spend } = {}, q = db) {
  const today = toISODate(new Date());
  const settings = await loadSettings(q);
  const custom = settings.spendingBudget == null ? null : round2(settings.spendingBudget);

  let paycheck = settings.paycheck ? manualPaycheck(settings.paycheck) : null;
  if (!paycheck) {
    const { sources } = await estimateMonthlyIncome(q);
    if (sources.length) paycheck = describePaycheck(sources.map(fromIncomeSource), 'detected');
  }
  let candidates = null;
  if (!paycheck) {
    candidates = await liveCandidates(today, q);
    const found = candidates.filter((c) => c.strong && c.active);
    if (found.length) paycheck = describePaycheck(found, 'found');
  }
  if (!paycheck) return { ready: false, today, custom, diagnosis: await diagnose(candidates, q) };

  const period = payPeriod(paycheck, today);
  const bills = await activeBills(today, q);
  const goals = (await allGoalProgress(currentMonthKey(), q))
    .filter((g) => g.kind !== 'limit' && g.status === 'active')
    .map((g) => ({
      id: g.id,
      name: g.name,
      kind: g.kind,
      current: g.current,
      target: g.target_amount,
      remaining: g.remaining,
      targetDate: g.target_date ? toISODate(g.target_date) : null,
      monthlyContribution: g.monthly_contribution == null ? null : Number(g.monthly_contribution),
      achieved: g.achieved,
    }));

  const plan = buildPlan({
    income: paycheck.amount,
    bills: perPaycheck(sum(bills.map((b) => b.monthlyAmount)), paycheck.perYear),
    goals,
    today,
    perYear: paycheck.perYear,
    spend: spend === undefined ? custom : spend,
  });

  const spent = await everydaySpending(period.start, today, bills, q);
  const left = round2(plan.budget - spent);
  const due = await recurringInRange(period.start, period.end, q);
  const dueBills = due.entries
    .filter((e) => e.type === 'expense')
    .map((e) => ({
      name: e.name, date: e.date, state: e.state, emoji: e.categoryEmoji,
      amount: e.state === 'paid' ? e.paidAmount : e.amount,
    }));

  return {
    ready: true,
    today,
    preview: spend !== undefined,
    custom,
    paycheck,
    period,
    ...plan,
    billItems: bills
      .map((b) => ({ ...b, perPaycheck: perPaycheck(b.monthlyAmount, paycheck.perYear) }))
      .sort((a, b) => b.perPaycheck - a.perPaycheck),
    dueBills,
    dueBillsTotal: round2(sum(dueBills.map((b) => b.amount))),
    typical: await typicalSpending(period.start, plan.periodDays, bills, q),
    spent,
    left,
    perDay: round2(Math.max(0, left) / period.daysLeft),
    goalsDelayed: plan.goals.some((g) => g.required > 0 && (g.projectedDate == null || g.shiftDays > 3)),
  };
}

module.exports = {
  paycheckPlan, saveSettings, loadSettings, payPeriod, isBillPayment, describePaycheck, CADENCE_DAYS,
};
