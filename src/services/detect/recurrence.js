'use strict';
const { daysBetween, addDays, parseISODate } = require('../../utils/dates');
const { median, coefficientOfVariation, round2 } = require('../../utils/money');
const { prettyMerchant } = require('../../utils/merchant');

// Shared recurrence engine. Income detection and subscription detection are the
// same problem pointed at opposite signs: group transactions by merchant key,
// look at the gaps between them, and decide whether the gaps and the amounts are
// regular enough to call it a recurring series.

const CADENCES = [
  { name: 'weekly',     min: 5,   max: 9,   perMonth: 365.25 / 7 / 12 },
  { name: 'biweekly',   min: 11,  max: 18,  perMonth: 365.25 / 14 / 12 },
  { name: 'monthly',    min: 25,  max: 38,  perMonth: 1 },
  { name: 'bimonthly',  min: 50,  max: 70,  perMonth: 0.5 },
  { name: 'quarterly',  min: 80,  max: 100, perMonth: 1 / 3 },
  { name: 'semiannual', min: 165, max: 200, perMonth: 1 / 6 },
  { name: 'annual',     min: 350, max: 385, perMonth: 1 / 12 },
];

const SEMIMONTHLY = { name: 'semimonthly', perMonth: 2 };

function classifyInterval(days) {
  return CADENCES.find((c) => days >= c.min && days <= c.max) || null;
}

function perMonthFor(cadence) {
  if (cadence === SEMIMONTHLY.name) return SEMIMONTHLY.perMonth;
  const c = CADENCES.find((x) => x.name === cadence);
  return c ? c.perMonth : 1;
}

/**
 * Paydays on the 1st and 15th produce alternating ~14/~16 day gaps that read as
 * "biweekly" but actually land twice a month. Detect the two-cluster
 * day-of-month signature and correct the cadence.
 */
function looksSemimonthly(dates) {
  if (dates.length < 4) return false;
  const doms = dates.map((d) => parseISODate(d).getUTCDate());
  const clusters = [];
  for (const dom of doms) {
    const hit = clusters.find((c) => Math.abs(c.centre - dom) <= 3);
    if (hit) {
      hit.items.push(dom);
      hit.centre = hit.items.reduce((a, b) => a + b, 0) / hit.items.length;
    } else {
      clusters.push({ centre: dom, items: [dom] });
    }
  }
  if (clusters.length !== 2) return false;
  // Both clusters must carry real weight, and sit clearly apart in the month.
  const [a, b] = clusters.sort((x, y) => y.items.length - x.items.length);
  return b.items.length >= dates.length * 0.3 && Math.abs(a.centre - b.centre) >= 10;
}

/**
 * @param {Array} txns  transactions with {posted_on, amount, merchant_key, description}
 * @param {'in'|'out'} direction
 * @param {object} opts
 * @returns {Array} candidate recurring series
 */
function detectRecurring(txns, direction, opts = {}) {
  const {
    minOccurrences = 3,
    maxAmountVariation = 0.25,   // CoV ceiling for "same charge each time"
    minRegularity = 0.6,         // fraction of gaps that match the median gap
  } = opts;

  const wanted = direction === 'in' ? (t) => Number(t.amount) > 0 : (t) => Number(t.amount) < 0;

  const groups = new Map();
  for (const t of txns) {
    if (!wanted(t)) continue;
    if (t.excluded) continue;
    const k = t.merchant_key || 'UNKNOWN';
    if (k === 'UNKNOWN') continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }

  const results = [];

  for (const [merchantKey, items] of groups) {
    items.sort((a, b) => (a.posted_on < b.posted_on ? -1 : 1));

    // Collapse same-day duplicates (a merchant charging twice in a day is one
    // event for cadence purposes).
    const byDay = [];
    for (const t of items) {
      const last = byDay[byDay.length - 1];
      if (last && last.posted_on === t.posted_on) {
        last.amount = round2(Number(last.amount) + Number(t.amount));
      } else {
        byDay.push({ ...t, posted_on: String(t.posted_on).slice(0, 10) });
      }
    }
    if (byDay.length < Math.max(2, minOccurrences - 1)) continue;

    const dates = byDay.map((t) => t.posted_on);
    const amounts = byDay.map((t) => Math.abs(Number(t.amount)));

    const gaps = [];
    for (let i = 1; i < dates.length; i += 1) gaps.push(daysBetween(dates[i - 1], dates[i]));
    const usable = gaps.filter((g) => g > 0);
    if (!usable.length) continue;

    const medianGap = median(usable);
    let cadenceDef = classifyInterval(medianGap);
    if (!cadenceDef) continue;

    let cadence = cadenceDef.name;
    let intervalDays = Math.round(medianGap);

    if (cadence === 'biweekly' && looksSemimonthly(dates)) {
      cadence = SEMIMONTHLY.name;
      intervalDays = 15;
    }

    // Regularity: share of gaps within 25% (or 4 days, whichever is looser) of
    // the median. Billing dates wobble around weekends and month lengths.
    const tolerance = Math.max(4, medianGap * 0.25);
    const onBeat = usable.filter((g) => Math.abs(g - medianGap) <= tolerance).length;
    const regularity = onBeat / usable.length;
    if (regularity < minRegularity) continue;

    const amountCov = coefficientOfVariation(amounts);
    if (amountCov > maxAmountVariation) continue;

    if (byDay.length < minOccurrences) {
      // Two data points only clear the bar when the amount is identical and the
      // cadence is a common billing one.
      const identical = amountCov === 0;
      const commonCadence = ['monthly', 'biweekly', 'semimonthly', 'weekly'].includes(cadence);
      if (!(identical && commonCadence && byDay.length >= 2)) continue;
    }

    // Recent series are more trustworthy than ones that stopped a year ago.
    const typicalAmount = round2(median(amounts));
    const perMonth = perMonthFor(cadence);
    const lastOn = dates[dates.length - 1];

    const confidence = Math.min(
      0.99,
      0.35 * Math.min(1, byDay.length / 6) +
      0.35 * regularity +
      0.30 * (1 - Math.min(1, amountCov / maxAmountVariation))
    );

    results.push({
      merchantKey,
      name: prettyMerchant(merchantKey),
      exampleDescription: byDay[byDay.length - 1].description,
      amount: typicalAmount,
      cadence,
      intervalDays,
      monthlyAmount: round2(typicalAmount * perMonth),
      occurrences: byDay.length,
      confidence: round2(confidence),
      regularity: round2(regularity),
      amountVariation: round2(amountCov),
      firstSeenOn: dates[0],
      lastSeenOn: lastOn,
      nextExpectedOn: addDays(lastOn, intervalDays),
      categoryId: byDay[byDay.length - 1].category_id || null,
    });
  }

  results.sort((a, b) => b.monthlyAmount - a.monthlyAmount);
  return results;
}

/** How stale a series is, in days, relative to its own cadence. */
function isActive(series, today) {
  const overdue = daysBetween(series.lastSeenOn, today);
  return overdue <= series.intervalDays * 2 + 10;
}

module.exports = { detectRecurring, classifyInterval, perMonthFor, isActive, CADENCES };
