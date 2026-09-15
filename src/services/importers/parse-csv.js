'use strict';
const { toISODate } = require('../../utils/dates');

// RFC4180-ish CSV reader plus column sniffing for bank exports. Golden 1 (and
// most institutions) let you download CSV from online banking; the header names
// vary, so the columns are matched by meaning rather than by position.

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/^﻿/, ''); // strip BOM

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const HEADER_ALIASES = {
  date: ['date', 'posted date', 'post date', 'posting date', 'transaction date', 'trans date', 'effective date'],
  description: ['description', 'memo', 'payee', 'name', 'transaction description', 'details', 'merchant'],
  amount: ['amount', 'transaction amount', 'amt'],
  debit: ['debit', 'withdrawal', 'withdrawals', 'money out', 'payment', 'charges'],
  credit: ['credit', 'deposit', 'deposits', 'money in'],
  balance: ['balance', 'running balance', 'ending balance'],
  type: ['type', 'transaction type', 'trans type', 'debit/credit'],
  category: ['category'],
};

function normaliseHeader(h) {
  return String(h).trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function mapHeaders(headerRow) {
  const map = {};
  headerRow.forEach((raw, idx) => {
    const h = normaliseHeader(raw);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[field] === undefined && aliases.includes(h)) map[field] = idx;
    }
  });
  return map;
}

function parseAmount(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  if (s.endsWith('-')) { negative = true; s = s.slice(0, -1); }
  s = s.replace(/[$,\s]/g, '');
  if (!s || !/^\d*\.?\d+$/.test(s)) return null;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;

  // US bank exports are M/D/YYYY.
  const us = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (us) {
    let [, m, d, y] = us;
    if (y.length === 2) y = String(2000 + Number(y));
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  return toISODate(new Date(s));
}

/**
 * @returns {{transactions: Array, warnings: Array<string>}}
 */
function parseTransactionCSV(text, { accountExternalId = null } = {}) {
  const rows = parseCSV(text);
  const warnings = [];
  if (rows.length < 2) return { transactions: [], warnings: ['CSV had no data rows.'] };

  // Some exports prepend account metadata lines before the real header.
  let headerIdx = 0;
  let map = mapHeaders(rows[0]);
  while (
    (map.date === undefined || (map.amount === undefined && map.debit === undefined && map.credit === undefined)) &&
    headerIdx < Math.min(10, rows.length - 1)
  ) {
    headerIdx += 1;
    map = mapHeaders(rows[headerIdx]);
  }

  if (map.date === undefined) {
    return {
      transactions: [],
      warnings: ['Could not find a date column. Expected a header like "Date" or "Posted Date".'],
    };
  }
  if (map.amount === undefined && map.debit === undefined && map.credit === undefined) {
    return {
      transactions: [],
      warnings: ['Could not find an amount column. Expected "Amount", or "Debit"/"Credit" columns.'],
    };
  }

  const transactions = [];
  for (let i = headerIdx + 1; i < rows.length; i += 1) {
    const r = rows[i];
    const postedOn = parseDate(r[map.date]);
    if (!postedOn) continue;

    let amount = null;
    if (map.amount !== undefined) {
      amount = parseAmount(r[map.amount]);
      // A "Type" column of DEBIT/WITHDRAWAL means the unsigned amount is an outflow.
      if (amount != null && amount > 0 && map.type !== undefined) {
        const type = String(r[map.type] || '').toLowerCase();
        if (/debit|withdraw|payment|purchase|charge/.test(type)) amount = -amount;
      }
    }
    if (amount == null && (map.debit !== undefined || map.credit !== undefined)) {
      const debit = map.debit !== undefined ? parseAmount(r[map.debit]) : null;
      const credit = map.credit !== undefined ? parseAmount(r[map.credit]) : null;
      if (debit != null && debit !== 0) amount = -Math.abs(debit);
      else if (credit != null && credit !== 0) amount = Math.abs(credit);
    }
    if (amount == null) continue;

    const description = map.description !== undefined
      ? String(r[map.description] || '').trim()
      : 'Transaction';

    transactions.push({
      postedOn,
      amount,
      description: description || 'Transaction',
      merchantRaw: description,
      accountExternalId,
    });
  }

  if (!transactions.length) warnings.push('No rows could be parsed into transactions.');
  return { transactions, warnings };
}

module.exports = { parseCSV, parseTransactionCSV, parseAmount, parseDate };
