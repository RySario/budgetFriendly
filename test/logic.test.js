/* Offline exercise of the pure logic: parsers + recurrence detection. */
process.env.DATABASE_URL = 'postgres://x/x';
process.env.SESSION_SECRET = 'x'.repeat(32);

const { parseTransactionCSV } = require("../src/services/importers/parse-csv");
const { parseOFXFile } = require("../src/services/importers/parse-ofx");
const { detectRecurring } = require("../src/services/detect/recurrence");
const { normaliseMerchant } = require("../src/utils/merchant");

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  -> ${detail}`}`);
  if (!cond) failures += 1;
}

// --- CSV: "Amount" style ---------------------------------------------------
const csvAmount = `Account Number,1234567890
Posted Date,Description,Amount,Balance
09/12/2026,"SAFEWAY #1234 ROSEVILLE CA",-84.19,2100.55
09/10/2026,"DIRECT DEP ACME CORP PAYROLL",2450.00,2184.74
09/01/2026,"NETFLIX.COM 866-579-7172 CA",-22.99,1000.00
`;
const a = parseTransactionCSV(csvAmount, { accountExternalId: 'acct-1' });
check('CSV(amount) row count', a.transactions.length === 3, JSON.stringify(a));
check('CSV(amount) signs', a.transactions[0].amount === -84.19 && a.transactions[1].amount === 2450,
  JSON.stringify(a.transactions));
check('CSV(amount) date', a.transactions[0].postedOn === '2026-09-12', a.transactions[0].postedOn);

// --- CSV: Debit/Credit columns + metadata preamble --------------------------
const csvDebitCredit = `Golden 1 Credit Union
Export generated 09/14/2026

Transaction Date,Description,Debit,Credit
9/5/2026,CHEVRON 0093749 FOLSOM CA,$45.10,
9/3/2026,PAYROLL DEPOSIT,,"$2,450.00"
9/2/2026,"TRADER JOES #178","$62.40",
`;
const b = parseTransactionCSV(csvDebitCredit, { accountExternalId: 'acct-1' });
check('CSV(debit/credit) row count', b.transactions.length === 3, JSON.stringify(b));
check('CSV(debit/credit) debit negative', b.transactions[0].amount === -45.10, String(b.transactions[0]?.amount));
check('CSV(debit/credit) credit positive w/ comma', b.transactions[1].amount === 2450, String(b.transactions[1]?.amount));

// --- CSV: Type column disambiguating unsigned amounts -----------------------
const csvType = `Date,Description,Type,Amount
09/08/2026,SMUD ONLINE PMT,DEBIT,142.33
09/07/2026,INTEREST PAID,CREDIT,1.02
`;
const c = parseTransactionCSV(csvType, { accountExternalId: 'acct-1' });
check('CSV(type) debit flipped negative', c.transactions[0].amount === -142.33, String(c.transactions[0]?.amount));
check('CSV(type) credit stays positive', c.transactions[1].amount === 1.02, String(c.transactions[1]?.amount));

// --- OFX 1.x SGML (the shape a real bank/Direct Connect returns) ------------
const ofx = `OFXHEADER:100
DATA:OFXSGML
VERSION:103
SECURITY:NONE
ENCODING:USASCII

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS>
<DTSERVER>20260914120000<LANGUAGE>ENG
<FI><ORG>GOLDEN1<FID>1234</FI>
</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS><CURDEF>USD
<BANKACCTFROM><BANKID>321175261<ACCTID>9876543210<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260801<DTEND>20260914
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260912120000[0:GMT]<TRNAMT>-84.19<FITID>2026091201
<NAME>SAFEWAY #1234<MEMO>ROSEVILLE CA</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260910120000[0:GMT]<TRNAMT>2450.00<FITID>2026091001
<NAME>ACME CORP PAYROLL</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260901120000[0:GMT]<TRNAMT>22.99<FITID>2026090101
<NAME>NETFLIX.COM</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>2100.55<DTASOF>20260914120000</LEDGERBAL>
<AVAILBAL><BALAMT>2050.55<DTASOF>20260914120000</AVAILBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;
const o = parseOFXFile(ofx);
check('OFX account parsed', o.accounts.length === 1 && o.accounts[0].externalId === '9876543210',
  JSON.stringify(o.accounts));
check('OFX balance', o.accounts[0].currentBalance === 2100.55, String(o.accounts[0]?.currentBalance));
check('OFX txn count', o.transactions.length === 3, String(o.transactions.length));
check('OFX signed amount preserved', o.transactions[0].amount === -84.19, String(o.transactions[0]?.amount));
check('OFX credit positive', o.transactions[1].amount === 2450, String(o.transactions[1]?.amount));
check('OFX unsigned DEBIT flipped', o.transactions[2].amount === -22.99, String(o.transactions[2]?.amount));
check('OFX date', o.transactions[0].postedOn === '2026-09-12', o.transactions[0]?.postedOn);
check('OFX FITID captured', o.transactions[0].externalId === '2026091201', o.transactions[0]?.externalId);

// --- OFX error response is surfaced, not silently empty ---------------------
const ofxErr = `OFXHEADER:100

<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>15500<SEVERITY>ERROR
<MESSAGE>Invalid credentials</STATUS></SONRS></SIGNONMSGSRSV1></OFX>`;
let threw = false;
try { parseOFXFile(ofxErr); } catch (e) { threw = /Invalid credentials/.test(e.message); }
check('OFX error surfaces', threw, 'no throw');

// --- Recurrence detection --------------------------------------------------
function series(desc, amount, startDay, intervalDays, count, jitter = 0) {
  const out = [];
  const start = new Date(Date.UTC(2026, 2, startDay));
  for (let i = 0; i < count; i += 1) {
    const d = new Date(start.getTime() + i * intervalDays * 86400000
      + (jitter ? ((i * 7) % (jitter * 2) - jitter) * 86400000 : 0));
    out.push({
      posted_on: d.toISOString().slice(0, 10),
      amount,
      description: desc,
      merchant_key: normaliseMerchant(desc),
      category_id: null,
      excluded: false,
    });
  }
  return out;
}

const txns = [
  ...series('NETFLIX.COM', -22.99, 3, 30, 6),
  ...series('SPOTIFY USA', -11.99, 8, 30, 6),
  ...series('ADOBE SYSTEMS', -59.99, 15, 30, 5, 2),   // wobbly billing date
  ...series('DIRECT DEP ACME CORP', 2450.00, 1, 14, 12),
  // Noise: irregular one-offs at the same merchant should not become a sub.
  { posted_on: '2026-04-02', amount: -18.40, description: 'CHIPOTLE 0421', merchant_key: normaliseMerchant('CHIPOTLE 0421'), excluded: false },
  { posted_on: '2026-04-19', amount: -44.10, description: 'CHIPOTLE 0421', merchant_key: normaliseMerchant('CHIPOTLE 0421'), excluded: false },
  { posted_on: '2026-06-27', amount: -9.25,  description: 'CHIPOTLE 0421', merchant_key: normaliseMerchant('CHIPOTLE 0421'), excluded: false },
];

const subs = detectRecurring(txns, 'out', { minOccurrences: 3 });
const names = subs.map((s) => s.name);
check('detects Netflix', names.some((n) => /Netflix/i.test(n)), names.join(', '));
check('detects Spotify', names.some((n) => /Spotify/i.test(n)), names.join(', '));
check('detects Adobe despite jitter', names.some((n) => /Adobe/i.test(n)), names.join(', '));
check('rejects irregular Chipotle', !names.some((n) => /Chipotle/i.test(n)), names.join(', '));
const netflix = subs.find((s) => /Netflix/i.test(s.name));
check('monthly amount for monthly sub', netflix && netflix.monthlyAmount === 22.99,
  JSON.stringify(netflix));
check('cadence monthly', netflix && netflix.cadence === 'monthly', netflix?.cadence);

const inflows = detectRecurring(txns, 'in', { minOccurrences: 3, maxAmountVariation: 0.35 });
check('detects biweekly payroll', inflows.length === 1 && inflows[0].cadence === 'biweekly',
  JSON.stringify(inflows.map((i) => [i.name, i.cadence])));
check('biweekly -> ~2.17x monthly',
  inflows[0] && Math.abs(inflows[0].monthlyAmount - 2450 * (365.25 / 14 / 12)) < 1,
  String(inflows[0]?.monthlyAmount));

// --- Semimonthly (1st and 15th) should not read as biweekly ----------------
const semi = [];
for (let m = 2; m <= 8; m += 1) {
  for (const day of [1, 15]) {
    semi.push({
      posted_on: new Date(Date.UTC(2026, m, day)).toISOString().slice(0, 10),
      amount: 1800, description: 'PAYROLL CITY OF SAC',
      merchant_key: normaliseMerchant('PAYROLL CITY OF SAC'), excluded: false,
    });
  }
}
const semiOut = detectRecurring(semi, 'in', { minOccurrences: 3 });
check('semimonthly detected', semiOut[0] && semiOut[0].cadence === 'semimonthly',
  JSON.stringify(semiOut.map((s) => [s.name, s.cadence, s.monthlyAmount])));
check('semimonthly monthly = 2x', semiOut[0] && semiOut[0].monthlyAmount === 3600,
  String(semiOut[0]?.monthlyAmount));

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures ? 1 : 0);
