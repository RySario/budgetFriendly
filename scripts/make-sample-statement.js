'use strict';
/* Generates a sample QFX and CSV covering the last ~5 months, so you can
 * exercise the whole pipeline locally without touching a real bank.
 *
 *   npm run make-sample
 *
 * The data deliberately contains things the detectors should find (biweekly
 * payroll, monthly subscriptions with wobbly billing dates, a semiannual
 * insurance premium) and things they should NOT flag (irregular dining and
 * shopping).
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'samples');
const MS_DAY = 86400000;
const today = new Date();
const start = new Date(today.getTime() - 150 * MS_DAY);

const iso = (d) => d.toISOString().slice(0, 10);
const ofxDate = (d) => iso(d).replace(/-/g, '') + '120000[0:GMT]';

const rows = [];
let fitid = 1000;

function push(date, amount, name, memo = '') {
  if (date > today || date < start) return;
  rows.push({ date: new Date(date), amount: +amount.toFixed(2), name, memo, fitid: `SAMPLE${fitid++}` });
}

// --- recurring: biweekly payroll -------------------------------------------
for (let d = new Date(start); d <= today; d = new Date(d.getTime() + 14 * MS_DAY)) {
  push(d, 2450.00, 'DIRECT DEP ACME CORP PAYROLL', 'DES:PAYROLL ID:88213');
}

// --- recurring: monthly bills and subscriptions ----------------------------
const monthly = [
  { day: 1,  amount: -1850.00, name: 'RENT PAYMENT PROPERTY MGMT LLC', jitter: 0 },
  { day: 3,  amount: -22.99,   name: 'NETFLIX.COM 866-579-7172 CA',    jitter: 1 },
  { day: 8,  amount: -11.99,   name: 'SPOTIFY USA 877-778-1161 NY',    jitter: 1 },
  { day: 12, amount: -59.99,   name: 'ADOBE SYSTEMS 408-536-6000 CA',  jitter: 2 },
  { day: 15, amount: -24.99,   name: 'PLANET FITNESS 8446807300 NH',   jitter: 1 },
  { day: 18, amount: -89.00,   name: 'COMCAST XFINITY 800-266-2278',   jitter: 2 },
  { day: 22, amount: -45.00,   name: 'T-MOBILE POSTPAID 800-937-8997', jitter: 1 },
];
for (let m = 0; m < 6; m += 1) {
  const base = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + m, 1));
  for (const bill of monthly) {
    const wobble = bill.jitter ? ((m * 3) % (bill.jitter * 2 + 1)) - bill.jitter : 0;
    push(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), bill.day + wobble)),
      bill.amount, bill.name);
  }
}

// --- recurring: utilities that vary in amount but not cadence ---------------
for (let m = 0; m < 6; m += 1) {
  const base = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + m, 9));
  push(base, -(120 + (m * 17) % 55), 'SMUD ONLINE PMT');
}

// --- recurring: semiannual insurance ---------------------------------------
for (let m = 0; m < 6; m += 6) {
  push(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + m, 14)),
    -412.00, 'STATE FARM INSURANCE 8009564442');
}

// --- irregular spending: must NOT be detected as recurring ------------------
const irregular = [
  ['SAFEWAY #1234 ROSEVILLE CA', 40, 130],
  ['TRADER JOES #178 SACRAMENTO CA', 25, 95],
  ['SQ *BLUE BOTTLE COFFEE SACRAMENTO CA', 4, 12],
  ['CHIPOTLE 0421 FOLSOM CA', 9, 28],
  ['CHEVRON 0093749 FOLSOM CA', 30, 72],
  ['AMAZON MKTPLACE PMTS AMZN.COM/BILL WA', 12, 180],
  ['TARGET 00021456 SACRAMENTO CA', 20, 140],
  ['DOORDASH*THAI BASIL 855-431-0459', 18, 55],
  ['CVS/PHARMACY #09812 FOLSOM CA', 8, 60],
];
// Deterministic pseudo-random so regenerating gives comparable data.
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

for (let day = 0; day <= 150; day += 1) {
  const d = new Date(start.getTime() + day * MS_DAY);
  const count = rnd() < 0.55 ? 1 : rnd() < 0.8 ? 2 : 0;
  for (let i = 0; i < count; i += 1) {
    const [name, lo, hi] = irregular[Math.floor(rnd() * irregular.length)];
    push(d, -(lo + rnd() * (hi - lo)), name);
  }
}

// --- a couple of transfers and a refund ------------------------------------
for (let m = 0; m < 5; m += 1) {
  push(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + m, 16)),
    -400.00, 'TRANSFER TO SAVINGS ****8890');
}
push(new Date(today.getTime() - 22 * MS_DAY), 63.48, 'AMAZON.COM REFUND');

rows.sort((a, b) => a.date - b.date);

fs.mkdirSync(OUT, { recursive: true });

// --- QFX (OFX 1.0.3 SGML) ---------------------------------------------------
const qfx = [
  'OFXHEADER:100',
  'DATA:OFXSGML',
  'VERSION:103',
  'SECURITY:NONE',
  'ENCODING:USASCII',
  'CHARSET:1252',
  'COMPRESSION:NONE',
  'OLDFILEUID:NONE',
  'NEWFILEUID:NONE',
  '',
  '<OFX>',
  '<SIGNONMSGSRSV1><SONRS>',
  '<STATUS><CODE>0<SEVERITY>INFO</STATUS>',
  `<DTSERVER>${ofxDate(today)}<LANGUAGE>ENG`,
  '<FI><ORG>SAMPLE CU<FID>0000</FI>',
  '</SONRS></SIGNONMSGSRSV1>',
  '<BANKMSGSRSV1><STMTTRNRS>',
  '<TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>',
  '<STMTRS><CURDEF>USD',
  '<BANKACCTFROM><BANKID>321175261<ACCTID>9876543210<ACCTTYPE>CHECKING</BANKACCTFROM>',
  `<BANKTRANLIST><DTSTART>${ofxDate(start)}<DTEND>${ofxDate(today)}`,
  ...rows.map((r) => [
    '<STMTTRN>',
    `<TRNTYPE>${r.amount < 0 ? 'DEBIT' : 'CREDIT'}`,
    `<DTPOSTED>${ofxDate(r.date)}`,
    `<TRNAMT>${r.amount.toFixed(2)}`,
    `<FITID>${r.fitid}`,
    `<NAME>${r.name.slice(0, 32)}`,
    r.memo ? `<MEMO>${r.memo}` : '',
    '</STMTTRN>',
  ].filter(Boolean).join('')),
  '</BANKTRANLIST>',
  `<LEDGERBAL><BALAMT>4182.55<DTASOF>${ofxDate(today)}</LEDGERBAL>`,
  `<AVAILBAL><BALAMT>4182.55<DTASOF>${ofxDate(today)}</AVAILBAL>`,
  '</STMTRS></STMTTRNRS></BANKMSGSRSV1>',
  '</OFX>',
].join('\r\n');

fs.writeFileSync(path.join(OUT, 'sample-statement.qfx'), qfx);

// --- CSV (the shape a bank export usually takes) ----------------------------
const csv = [
  'Posted Date,Description,Amount,Balance',
  ...rows.map((r) => {
    const desc = `"${r.name.replace(/"/g, '""')}"`;
    const [y, m, d] = iso(r.date).split('-');
    return `${Number(m)}/${Number(d)}/${y},${desc},${r.amount.toFixed(2)},`;
  }),
].join('\r\n');

fs.writeFileSync(path.join(OUT, 'sample-statement.csv'), csv);

const income = rows.filter((r) => r.amount > 0).length;
console.log(`Wrote samples/sample-statement.qfx and samples/sample-statement.csv`);
console.log(`${rows.length} transactions from ${iso(start)} to ${iso(today)} (${income} deposits).`);
