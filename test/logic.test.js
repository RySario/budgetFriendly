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

// --- Golden 1 description formats (OFX NAME capped at 32 characters) -------
for (const [raw, want] of [
  ['WITHDRAWAL AT SQ *BLUE BOTTLE CO', 'BLUE BOTTLE'],
  ['CHECKING DEPOSIT AT G1 ONLINE TR', 'G1 ONLINE TR'],
  ['WITHDRAWAL @ G1 ONLINE TRANSFER', 'G1 ONLINE TRANSFER'],
  ['CHECKING DEPOSIT-ACH-1064831 ACME PAYROLL', 'ACME PAYROLL'],
  ['CHECKING DEPOSIT-ACH-A-1218243 VENMO', 'VENMO'],
  ['WITHDRAWAL-ACH-A-1218243 NETFLIX', 'NETFLIX'],
  ['WITHDRAWAL REVERSAL AT HOLLISTER', 'HOLLISTER'],
  // No wrapper: a leading "AT" is part of the name and must survive.
  ['AT HOME STORE', 'AT HOME STORE'],
  ['AT&T MOBILITY', 'AT&T MOBILITY'],
]) {
  const got = normaliseMerchant(raw);
  check(`normalise "${raw}"`, got === want, `got "${got}", want "${want}"`);
}
check('Golden 1 wrapper then processor prefix',
  normaliseMerchant('WITHDRAWAL AT STEAMGAMES.COM 425').startsWith('STEAMGAMES'),
  normaliseMerchant('WITHDRAWAL AT STEAMGAMES.COM 425'));

// --- Variable paychecks still count as income --------------------------------
// Hourly pay moves the amount (coefficient of variation ~0.42 here) while the
// cadence stays exact. Income detection in src/services/detect/index.js allows
// 0.6; the subscription limit of 0.35 would wrongly reject it.
const payAmounts = [900, 2600, 1200, 2900, 1000, 2400, 3100, 1100, 2700, 1500, 2800, 950, 2200];
const pay = series('CHECKING DEPOSIT-ACH-1064831 ACME PAYROLL', 0, 2, 14, payAmounts.length)
  .map((t, i) => ({ ...t, amount: payAmounts[i] }));
const payIncome = detectRecurring(pay, 'in', { minOccurrences: 3, maxAmountVariation: 0.6 });
check('variable biweekly paycheck detected as income',
  payIncome.length === 1 && payIncome[0].cadence === 'biweekly',
  JSON.stringify(payIncome.map((p) => [p.name, p.cadence, p.amountVariation])));
check('same paycheck rejected at the subscription amount limit',
  detectRecurring(pay, 'in', { minOccurrences: 3, maxAmountVariation: 0.35 }).length === 0,
  'detected anyway');

// --- Date objects, the shape node-postgres returns by default -------------
// Regression: a Date stringified and cut to 10 chars became "Tue Aug 04",
// which Postgres rejected when detection wrote it back.
const asDates = series('HULU 877-824-4858 CA', -17.99, 4, 30, 5).map((t) => {
  const [y, m, d] = t.posted_on.split('-').map(Number);
  return { ...t, posted_on: new Date(y, m - 1, d) };
});
// Two charges on one day must merge into a single event. The extra charge is a
// cent so the merged amount stays within the amount-variation limit.
asDates.push({ ...asDates[asDates.length - 1], amount: -0.01 });
const fromDates = detectRecurring(asDates, 'out', { minOccurrences: 3 });
const hulu = fromDates[0];
const isoRe = /^\d{4}-\d{2}-\d{2}$/;
check('Date inputs still detected', !!hulu, JSON.stringify(fromDates));
check('Date inputs yield ISO first/last/next dates',
  hulu && isoRe.test(hulu.firstSeenOn) && isoRe.test(hulu.lastSeenOn) && isoRe.test(hulu.nextExpectedOn),
  hulu && [hulu.firstSeenOn, hulu.lastSeenOn, hulu.nextExpectedOn].join(' | '));
check('same-day charges from Date inputs collapse', hulu && hulu.occurrences === 5,
  hulu && String(hulu.occurrences));

// --- Recurring calendar projection --------------------------------------------
const { expectedDates } = require('../src/services/recurring');
const monthEnd = expectedDates('2026-01-31', 'monthly', 30, '2026-02-01', '2026-04-30');
check('monthly bill on the 31st lands on each short month\'s last day',
  JSON.stringify(monthEnd) === JSON.stringify(['2026-02-28', '2026-03-31', '2026-04-30']), JSON.stringify(monthEnd));
const biweekly = expectedDates('2026-09-11', 'biweekly', 14, '2026-09-01', '2026-09-30');
check('biweekly paycheck projects into the month from its last date',
  JSON.stringify(biweekly) === JSON.stringify(['2026-09-11', '2026-09-25']), JSON.stringify(biweekly));
const backward = expectedDates('2026-09-11', 'biweekly', 14, '2026-08-01', '2026-08-31');
check('projection also walks backward into past months',
  JSON.stringify(backward) === JSON.stringify(['2026-08-14', '2026-08-28']), JSON.stringify(backward));

// --- Paycheck plan -------------------------------------------------------------
const { buildPlan, paychecksPerYear, perPaycheck } = require('../src/services/plan/math');
const { payPeriod, isBillPayment } = require('../src/services/plan');
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

check('paychecks per year', paychecksPerYear('biweekly') === 26 && paychecksPerYear('semimonthly') === 24
  && paychecksPerYear('monthly') === 12, '');
check('monthly amount spread per biweekly paycheck', perPaycheck(1300, 26) === 600, String(perPaycheck(1300, 26)));

const TODAY = '2026-09-15';
const fund = { id: 1, name: 'Emergency fund', remaining: 2600, targetDate: '2027-09-14' }; // 364 days out
const base = { income: 2000, bills: 800, goals: [fund], today: TODAY, perYear: 26 };
const need = 2600 / (364 / (365.25 / 26));
const rec = buildPlan(base);
check('plan: goal need per paycheck', near(rec.goalNeed, need), `${rec.goalNeed} vs ${need}`);
check('plan: recommended = paycheck - bills - goals', near(rec.recommended, 1200 - need), String(rec.recommended));
check('plan: recommended keeps the goal on its date',
  rec.goals[0].shiftDays === 0 && Math.abs(require('../src/utils/dates').daysBetween(rec.goals[0].plannedDate, fund.targetDate)) <= 1,
  JSON.stringify(rec.goals[0]));

const over = buildPlan({ ...base, spend: rec.recommended + need / 2 });
check('plan: spending half the goal money doubles the time', over.goals[0].shiftDays > 350 && over.goals[0].shiftDays < 380,
  JSON.stringify(over.goals[0]));
check('plan: difference reported', near(over.difference, need / 2), String(over.difference));

const under = buildPlan({ ...base, spend: rec.recommended - 100 });
check('plan: spending less finishes sooner', under.goals[0].shiftDays < -3, JSON.stringify(under.goals[0]));

const blowout = buildPlan({ ...base, spend: 1500 });
check('plan: spending everything after bills stalls goals',
  blowout.goals[0].projectedDate === null && blowout.overPaycheck === 300 && blowout.toGoals === 0, JSON.stringify(blowout));

const tight = buildPlan({ ...base, income: 850 });
check('plan: unaffordable goals give a shortfall, not a negative budget',
  tight.recommended === 0 && near(tight.shortfall, need - 50) && tight.goals[0].shiftDays > 0, JSON.stringify(tight));

const odd = buildPlan({
  ...base,
  goals: [
    { id: 2, name: 'Someday', remaining: 500, targetDate: null },
    { id: 3, name: 'Late', remaining: 500, targetDate: '2026-09-01' },
    { id: 4, name: 'Monthly', remaining: 500, targetDate: null, monthlyContribution: 130 },
  ],
});
check('plan: undated goal left out, past-date goal flagged, monthly goal spread per paycheck',
  odd.goals[0].plan === 'unplanned' && odd.goals[1].plan === 'overdue' && odd.goals[2].required === 60
  && odd.goalNeed === 60, JSON.stringify(odd.goals));

const schedule = { anchor: '2026-09-11', cadence: 'biweekly', intervalDays: 14, perYear: 26 };
const period = payPeriod(schedule, TODAY);
check('pay period: last payday through the day before the next',
  period.start === '2026-09-11' && period.end === '2026-09-24' && period.nextPayday === '2026-09-25' && period.daysLeft === 10,
  JSON.stringify(period));
const payday = payPeriod(schedule, '2026-09-25');
check('pay period: a new period starts on payday', payday.start === '2026-09-25' && payday.nextPayday === '2026-10-09',
  JSON.stringify(payday));
const fromNext = payPeriod({ ...schedule, anchor: '2026-09-25' }, TODAY);
check('pay period: works from a future payday entered by hand', fromNext.start === '2026-09-11', JSON.stringify(fromNext));

const billList = [{ merchantKey: 'NETFLIX', amount: 15.49 }];
check('bill payments are not everyday spending',
  isBillPayment({ amount: '-15.49', merchant_key: 'NETFLIX' }, billList)
  && !isBillPayment({ amount: '-60.00', merchant_key: 'NETFLIX' }, billList)
  && !isBillPayment({ amount: '15.49', merchant_key: 'NETFLIX' }, billList)
  && !isBillPayment({ amount: '-15.49', merchant_key: 'SAFEWAY' }, billList), '');

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures ? 1 : 0);
