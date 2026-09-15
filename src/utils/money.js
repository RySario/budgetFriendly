'use strict';

/** Round to cents, killing float drift. */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function sum(values) {
  return round2(values.reduce((a, b) => a + Number(b || 0), 0));
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].map(Number).sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + Number(b), 0) / values.length;
}

/** Coefficient of variation — 0 means every value identical. */
function coefficientOfVariation(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  if (m === 0) return 0;
  const variance = mean(values.map((v) => (v - m) ** 2));
  return Math.sqrt(variance) / Math.abs(m);
}

module.exports = { round2, sum, median, mean, coefficientOfVariation };
