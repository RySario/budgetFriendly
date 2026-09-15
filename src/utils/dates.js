'use strict';

const MS_PER_DAY = 86400000;

/** 'YYYY-MM-DD' from a Date or a date-ish string, in UTC to avoid TZ drift. */
function toISODate(d) {
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function parseISODate(s) {
  const iso = toISODate(s);
  return iso ? new Date(`${iso}T00:00:00Z`) : null;
}

function daysBetween(a, b) {
  const da = parseISODate(a);
  const dbb = parseISODate(b);
  if (!da || !dbb) return 0;
  return Math.round((dbb - da) / MS_PER_DAY);
}

function addDays(dateish, n) {
  const d = parseISODate(dateish);
  if (!d) return null;
  return toISODate(new Date(d.getTime() + n * MS_PER_DAY));
}

/** '2026-09' for the month a date falls in. */
function monthKey(dateish) {
  const iso = toISODate(dateish);
  return iso ? iso.slice(0, 7) : null;
}

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

/** Inclusive first/last day of a 'YYYY-MM' month. */
function monthRange(key) {
  const [y, m] = key.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return { start: toISODate(start), end: toISODate(end) };
}

function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** Fractional months between two dates, floored at 0. */
function monthsBetween(from, to) {
  const a = parseISODate(from);
  const b = parseISODate(to);
  if (!a || !b) return 0;
  return Math.max(0, (b - a) / MS_PER_DAY / 30.4375);
}

/** How far through the current month we are, 0..1. */
function monthProgress(key) {
  const { start, end } = monthRange(key);
  const today = toISODate(new Date());
  if (today < start) return 0;
  if (today > end) return 1;
  const total = daysBetween(start, end) + 1;
  return (daysBetween(start, today) + 1) / total;
}

module.exports = {
  MS_PER_DAY, toISODate, parseISODate, daysBetween, addDays,
  monthKey, currentMonthKey, monthRange, shiftMonth, monthsBetween, monthProgress,
};
