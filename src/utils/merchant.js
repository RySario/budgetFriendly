'use strict';

// Bank descriptions are noisy: "SQ *BLUE BOTTLE 0192 SACRAMENTO CA 09/14",
// "AMZN Mktp US*2F41K3XY3", "POS DEBIT 4412 TRADER JOES #178".
// normaliseMerchant() reduces them to a stable key so the same merchant groups
// together across months — that key is what recurrence detection and the
// category rules match on.

// Processor prefixes that wrap the real merchant name.
const PROCESSOR_PREFIXES = [
  'SQ *', 'SQC*', 'TST*', 'TST* ', 'PY *', 'PYPL *', 'PAYPAL *', 'PP*',
  'SP *', 'SP*', 'EB *', 'WL *', 'IC* ', 'IN *', 'CKE*', 'GOOGLE *',
  'MSFT *', 'MICROSOFT*', 'AMZN MKTP', 'AMAZON MKTPLACE', 'SQUARE *',
];

// Leading transaction-type noise the bank adds.
const LEADING_NOISE = [
  'POS DEBIT', 'POS CREDIT', 'POS PURCHASE', 'DEBIT CARD PURCHASE',
  'CREDIT CARD PURCHASE', 'CHECKCARD', 'CHECK CARD', 'VISA PURCHASE',
  'PURCHASE AUTHORIZED ON', 'PURCHASE AUTHORIZED', 'RECURRING PAYMENT',
  'PREAUTHORIZED DEBIT', 'PREAUTHORIZED CREDIT', 'ACH DEBIT', 'ACH CREDIT',
  'ELECTRONIC WITHDRAWAL', 'ELECTRONIC DEPOSIT', 'EXTERNAL WITHDRAWAL',
  'EXTERNAL DEPOSIT', 'WITHDRAWAL', 'DEPOSIT', 'PAYMENT', 'DIRECT DEP',
  'DIRECT DEPOSIT', 'MOBILE DEPOSIT', 'POS', 'DES:',
];

// US state codes, stripped when they trail the description.
const STATE_CODES = new Set(
  ('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO ' +
   'MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC')
    .split(' ')
);

function stripAccents(s) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/**
 * Human-facing merchant label: title-cased, punctuation tidied.
 */
function prettyMerchant(key) {
  if (!key) return 'Unknown';
  return key
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length <= 2 && /^[a-z]+$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * Reduce a raw bank description to a stable, comparable merchant key.
 * Returns an UPPERCASE string with no punctuation, ids, dates or locations.
 */
function normaliseMerchant(raw) {
  if (!raw) return 'UNKNOWN';
  let s = stripAccents(String(raw)).toUpperCase().trim();

  // Drop everything after a "DES:"/"ID:"/"INDN:" ACH addenda marker.
  s = s.replace(/\b(DES|ID|INDN|CO ID|TRN|PPD ID|CCD ID|WEB ID|ARC ID)\s*:.*$/i, ' ');

  // Credit-union transaction-type wrappers sit in front of any processor
  // prefix — Golden 1 writes "WITHDRAWAL AT SQ *SHOP" and
  // "CHECKING DEPOSIT-ACH-1064831 EMPLOYER". Strip them first so the processor
  // unwrapping below sees the merchant. The trailing "AT"/"@" is only removed
  // when a wrapper was, so a merchant genuinely named "AT ..." survives.
  const unwrapped = s
    .replace(/^(?:CHECKING|SAVINGS|MONEY MARKET)\s+(?:DEPOSIT|WITHDRAWAL)(?:-ACH(?:-[A-Z])?-\d+)?(?:\s+|$)/, '')
    .replace(/^(?:WITHDRAWAL|DEPOSIT)(?:-ACH(?:-[A-Z])?-\d+)?(?:\s+REVERSAL)?(?:\s+|$)/, '');
  if (unwrapped !== s) s = unwrapped.replace(/^(?:AT|@)\s+/, '');

  // Unwrap payment-processor prefixes, which stack ("AMZN MKTP US*1A2B3C").
  for (let i = 0; i < 3; i += 1) {
    const before = s;
    s = s.trimStart();
    for (const p of PROCESSOR_PREFIXES) {
      if (s.startsWith(p)) { s = s.slice(p.length).trimStart(); break; }
    }
    // Generic "XXX*MERCHANT" processor form.
    s = s.replace(/^[A-Z0-9]{2,6}\s?\*\s?/, '');
    if (s === before) break;
  }

  // Customer-service phone numbers riding along in the description.
  s = s.replace(/\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/g, ' ');
  s = s.replace(/\b\d{3}[-. ]\d{7}\b/g, ' ');
  s = s.replace(/\b1[-. ]\d{3}[-. ]\d{3}[-. ]\d{4}\b/g, ' ');

  // Strip leading transaction-type noise, possibly stacked.
  let changed = true;
  while (changed) {
    changed = false;
    const t = s.trimStart();
    for (const n of LEADING_NOISE) {
      if (t.startsWith(n + ' ') || t === n) {
        s = t.slice(n.length);
        changed = true;
        break;
      }
    }
  }

  // Dates in any common shape.
  s = s.replace(/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/g, ' ');
  s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');

  // Card / reference / trace numbers.
  s = s.replace(/\bX{2,}\d+\b/g, ' ');
  s = s.replace(/\b\d{4,}\b/g, ' ');          // long digit runs
  s = s.replace(/#\s?\d+/g, ' ');             // store numbers
  s = s.replace(/\b[A-Z]*\d[A-Z0-9]{5,}\b/g, ' '); // alphanumeric order ids

  // Currency amounts embedded in the description.
  s = s.replace(/\$\s?[\d,]+\.\d{2}/g, ' ');

  // Punctuation -> spaces, then collapse.
  s = s.replace(/[^A-Z0-9&' ]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Trailing "CITY ST" / "ST" location tails.
  const parts = s.split(' ');
  while (parts.length > 1 && STATE_CODES.has(parts[parts.length - 1])) {
    parts.pop();
    // The token before a state code is usually the city; drop it only when the
    // name still has substance without it.
    if (parts.length > 2) parts.pop();
  }
  s = parts.join(' ').trim();

  // Common country tail.
  s = s.replace(/\b(USA|US|U S A)$/g, '').trim();

  // Cap the key length so a runaway description cannot fragment grouping.
  s = s.split(' ').slice(0, 5).join(' ');

  return s || 'UNKNOWN';
}

module.exports = { normaliseMerchant, prettyMerchant };
