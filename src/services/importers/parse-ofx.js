'use strict';

// OFX / QFX parser.
//
// OFX 1.x is SGML: tags are frequently unclosed, so a normal XML parser is no
// use. OFX 2.x is real XML. Both are handled here by a single forgiving scanner
// that builds a tree from the tag stream — leaf values are the text that
// follows an opening tag, and a tag that opens while a leaf is "open" implicitly
// closes it.
//
// This is the same file format Quicken/Money use, and it is what an OFX Direct
// Connect server returns over HTTP, so the parser serves both the file adapter
// and the direct-connect adapter.

const AGGREGATES = new Set([
  'OFX', 'SIGNONMSGSRSV1', 'SONRS', 'STATUS', 'FI',
  'BANKMSGSRSV1', 'STMTTRNRS', 'STMTRS', 'BANKACCTFROM', 'BANKTRANLIST',
  'STMTTRN', 'LEDGERBAL', 'AVAILBAL',
  'CREDITCARDMSGSRSV1', 'CCSTMTTRNRS', 'CCSTMTRS', 'CCACCTFROM',
  'INVSTMTMSGSRSV1', 'ACCTINFORS', 'SIGNUPMSGSRSV1', 'ACCTINFOTRNRS',
  'ACCTINFO', 'BANKACCTINFO', 'CCACCTINFO', 'ORIGCURRENCY', 'CURRENCY',
]);

function stripHeaders(raw) {
  // OFX 1.x has a plain-text header block before the <OFX> root.
  const idx = raw.search(/<OFX>/i);
  return idx >= 0 ? raw.slice(idx) : raw;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/**
 * Parse OFX/QFX text into a plain-object tree. Repeated children become arrays.
 */
function parseOFX(raw) {
  const body = stripHeaders(String(raw));
  const root = {};
  const stack = [{ name: '__root__', node: root }];
  let pendingLeaf = null;

  const tagRe = /<(\/?)([A-Za-z0-9_.]+)>([^<]*)/g;
  let m;

  while ((m = tagRe.exec(body)) !== null) {
    const closing = m[1] === '/';
    const name = m[2].toUpperCase();
    const text = decodeEntities(m[3] || '').trim();

    if (closing) {
      if (pendingLeaf === name) { pendingLeaf = null; continue; }
      // Pop to the matching aggregate.
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].name === name) { stack.length = i; break; }
      }
      pendingLeaf = null;
      continue;
    }

    const parent = stack[stack.length - 1].node;
    const isAggregate = AGGREGATES.has(name) || (text === '' && !pendingLeaf);

    if (isAggregate && text === '') {
      const child = {};
      attach(parent, name, child);
      stack.push({ name, node: child });
      pendingLeaf = null;
    } else {
      attach(parent, name, text);
      pendingLeaf = name;
    }
  }

  return root.OFX ? (Array.isArray(root.OFX) ? root.OFX[0] : root.OFX) : root;
}

function attach(parent, name, value) {
  if (parent[name] === undefined) { parent[name] = value; return; }
  if (Array.isArray(parent[name])) { parent[name].push(value); return; }
  parent[name] = [parent[name], value];
}

function arr(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** OFX dates are YYYYMMDD[HHMMSS][.XXX][TZ] -> 'YYYY-MM-DD'. */
function ofxDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** OFX TRNTYPE values that always mean money leaving the account. */
const DEBIT_TYPES = new Set([
  'DEBIT', 'PAYMENT', 'CHECK', 'FEE', 'SRVCHG', 'ATM', 'POS',
  'XFER', 'REPEATPMT', 'DIRECTDEBIT', 'CASH',
]);

/**
 * Walk a parsed OFX tree into normalised accounts + transactions.
 * Handles bank and credit-card statements, and multiple statements per file.
 */
function extractStatements(tree) {
  const accounts = [];
  const transactions = [];

  const bankResponses = [
    ...arr(tree?.BANKMSGSRSV1?.STMTTRNRS).flatMap((r) => arr(r.STMTRS)),
    ...arr(tree?.BANKMSGSRSV1?.STMTRS),
  ];
  const ccResponses = [
    ...arr(tree?.CREDITCARDMSGSRSV1?.CCSTMTTRNRS).flatMap((r) => arr(r.CCSTMTRS)),
    ...arr(tree?.CREDITCARDMSGSRSV1?.CCSTMTRS),
  ];

  const statements = [
    ...bankResponses.map((s) => ({ stmt: s, kind: 'depository' })),
    ...ccResponses.map((s) => ({ stmt: s, kind: 'credit' })),
  ];

  for (const { stmt, kind } of statements) {
    if (!stmt) continue;
    const acctFrom = stmt.BANKACCTFROM || stmt.CCACCTFROM || {};
    const acctId = String(acctFrom.ACCTID || acctFrom.ACCTKEY || 'default');
    const acctType = String(acctFrom.ACCTTYPE || '').toUpperCase();

    const ledger = num(stmt.LEDGERBAL?.BALAMT);
    const avail = num(stmt.AVAILBAL?.BALAMT);

    accounts.push({
      externalId: acctId,
      name: kind === 'credit'
        ? `Credit Card ****${acctId.slice(-4)}`
        : `${acctType ? acctType[0] + acctType.slice(1).toLowerCase() : 'Account'} ****${acctId.slice(-4)}`,
      type: kind,
      subtype: acctType ? acctType.toLowerCase() : null,
      mask: acctId.slice(-4),
      currency: String(stmt.CURDEF || 'USD'),
      currentBalance: ledger,
      availableBalance: avail,
    });

    for (const t of arr(stmt.BANKTRANLIST?.STMTTRN)) {
      const amount = num(t.TRNAMT);
      if (amount === null) continue;

      const trnType = String(t.TRNTYPE || '').toUpperCase();
      // OFX already signs TRNAMT. Only correct an unsigned positive amount when
      // the type unambiguously says it was a debit.
      let signed = amount;
      if (signed > 0 && DEBIT_TYPES.has(trnType)) signed = -signed;

      const name = String(t.NAME || t.PAYEE?.NAME || '').trim();
      const memo = String(t.MEMO || '').trim();
      const description = [name, memo].filter(Boolean).join(' ').trim() || trnType || 'Transaction';

      transactions.push({
        externalId: t.FITID ? String(t.FITID) : null,
        postedOn: ofxDate(t.DTPOSTED) || ofxDate(t.DTUSER),
        amount: signed,
        description,
        merchantRaw: name || description,
        accountExternalId: acctId,
      });
    }
  }

  return { accounts, transactions };
}

/** Read an OFX/QFX file into the normalised payload shape. */
function parseOFXFile(text) {
  const tree = parseOFX(text);

  const code = tree?.SIGNONMSGSRSV1?.SONRS?.STATUS?.CODE;
  const severity = tree?.SIGNONMSGSRSV1?.SONRS?.STATUS?.SEVERITY;
  if (code && code !== '0' && String(severity).toUpperCase() === 'ERROR') {
    const msg = tree?.SIGNONMSGSRSV1?.SONRS?.STATUS?.MESSAGE || `OFX error code ${code}`;
    throw new Error(`Institution rejected the request: ${msg}`);
  }

  const out = extractStatements(tree);
  if (!out.transactions.length && !out.accounts.length) {
    throw new Error('No statements found in the OFX/QFX file.');
  }
  return out;
}

module.exports = { parseOFX, parseOFXFile, extractStatements, ofxDate, arr };
