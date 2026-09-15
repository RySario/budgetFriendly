'use strict';
const db = require('../db');
const { isActive } = require('./detect/recurrence');
const { round2, sum } = require('../utils/money');
const {
  toISODate, parseISODate, addDays, daysBetween, monthRange, currentMonthKey,
} = require('../utils/dates');

// Recurring bills and income laid out on a calendar. Each detected series is
// projected onto the requested range from its last real occurrence, and every
// projected date is matched against actual transactions to mark it paid,
// due, missed or upcoming.

const MONTH_STEP = { monthly: 1, bimonthly: 2, quarterly: 3, semiannual: 6, annual: 12 };
const MATCH_WINDOW_DAYS = 5;

function addMonthsClamped(iso, n) {
  const d = parseISODate(iso);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const daysInTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTarget));
  return toISODate(target);
}

/** Dates a series is expected on within [start, end]. */
function expectedDates(anchor, cadence, intervalDays, start, end) {
  if (!anchor) return [];
  const out = new Set();
  const months = MONTH_STEP[cadence];

  if (months) {
    // Step by calendar months so a bill on the 31st lands on the last day of a
    // short month instead of drifting a day earlier each time.
    const reach = Math.ceil(Math.max(Math.abs(daysBetween(anchor, start)), Math.abs(daysBetween(anchor, end))) / 28) + 2;
    for (let k = -reach; k <= reach; k += 1) {
      const d = addMonthsClamped(anchor, k * months);
      if (d >= start && d <= end) out.add(d);
    }
  } else {
    const step = cadence === 'semimonthly' ? 15 : Math.max(1, intervalDays || 30);
    for (let k = Math.floor(daysBetween(anchor, start) / step) - 1; ; k += 1) {
      const d = addDays(anchor, k * step);
      if (d > end) break;
      if (d >= start) out.add(d);
    }
  }
  return [...out].sort();
}

async function recurringInRange(start, end, q = db) {
  const today = toISODate(new Date());

  const subs = await q.many(
    `SELECT s.*, c.name AS category_name, c.emoji AS category_emoji
       FROM subscriptions s LEFT JOIN categories c ON c.id = s.category_id
      WHERE s.status IN ('detected', 'confirmed')`
  );
  const incomes = await q.many(`SELECT * FROM income_sources WHERE status <> 'dismissed'`);

  const series = [
    ...subs.map((s) => ({
      type: 'expense', id: s.id, merchantKey: s.merchant_key, name: s.name,
      amount: round2(s.amount), monthlyAmount: round2(s.monthly_amount),
      cadence: s.cadence, intervalDays: s.interval_days, status: s.status,
      firstOn: s.first_seen_on, lastOn: s.last_charged_on,
      categoryName: s.category_name, categoryEmoji: s.category_emoji,
      confidence: Number(s.confidence),
    })),
    ...incomes.map((s) => ({
      type: 'income', id: s.id, merchantKey: s.merchant_key, name: s.name,
      amount: round2(s.amount), monthlyAmount: round2(s.monthly_amount),
      cadence: s.cadence, intervalDays: s.interval_days, status: s.status,
      firstOn: s.first_seen_on, lastOn: s.last_seen_on,
      categoryName: 'Paychecks', categoryEmoji: '💰',
      confidence: Number(s.confidence),
    })),
  ].filter((s) => isActive({ lastSeenOn: s.lastOn, intervalDays: s.intervalDays }, today));

  const keys = [...new Set(series.map((s) => s.merchantKey))];
  const txns = keys.length
    ? await q.many(
      `SELECT id, merchant_key, posted_on, amount FROM transactions
        WHERE merchant_key = ANY($1::text[]) AND posted_on BETWEEN $2 AND $3 AND excluded = false`,
      [keys, addDays(start, -MATCH_WINDOW_DAYS), addDays(end, MATCH_WINDOW_DAYS)]
    )
    : [];

  const used = new Set();
  const entries = [];
  for (const s of series) {
    const candidates = txns.filter((t) =>
      t.merchant_key === s.merchantKey && (s.type === 'income' ? t.amount > 0 : t.amount < 0));

    for (const date of expectedDates(s.lastOn, s.cadence, s.intervalDays, start, end)) {
      if (s.firstOn && date < addDays(s.firstOn, -MATCH_WINDOW_DAYS)) continue;

      let match = null;
      for (const t of candidates) {
        if (used.has(t.id)) continue;
        const gap = Math.abs(daysBetween(date, t.posted_on));
        if (gap <= MATCH_WINDOW_DAYS && (!match || gap < match.gap)) match = { t, gap };
      }
      if (match) used.add(match.t.id);

      let state = 'upcoming';
      if (match) state = 'paid';
      else if (date < addDays(today, -MATCH_WINDOW_DAYS)) state = 'missed';
      else if (date <= today) state = 'due';

      entries.push({
        key: `${s.type}-${s.id}-${date}`,
        date,
        state,
        paidOn: match ? match.t.posted_on : null,
        paidAmount: match ? round2(Math.abs(match.t.amount)) : null,
        ...s,
      });
    }
  }
  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name)));

  const total = (type) => {
    const list = entries.filter((e) => e.type === type);
    const settled = list.filter((e) => e.state === 'paid');
    const open = list.filter((e) => e.state === 'upcoming' || e.state === 'due');
    return {
      expected: round2(sum(list.map((e) => e.amount))),
      settled: round2(sum(settled.map((e) => e.paidAmount))),
      remaining: round2(sum(open.map((e) => e.amount))),
      count: list.length,
    };
  };

  return {
    start,
    end,
    entries,
    series,
    totals: { expense: total('expense'), income: total('income') },
  };
}

async function recurringForMonth(monthKeyArg, q = db) {
  const month = monthKeyArg || currentMonthKey();
  const { start, end } = monthRange(month);
  return { month, ...(await recurringInRange(start, end, q)) };
}

const STATUSES = {
  expense: { table: 'subscriptions', allowed: ['detected', 'confirmed', 'dismissed', 'cancelled'] },
  income: { table: 'income_sources', allowed: ['detected', 'confirmed', 'dismissed'] },
};

async function setRecurringStatus(type, id, status, q = db) {
  const def = STATUSES[type];
  if (!def || !def.allowed.includes(status)) return null;
  return q.one(
    `UPDATE ${def.table} SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, status]
  );
}

module.exports = { recurringInRange, recurringForMonth, setRecurringStatus, expectedDates };
