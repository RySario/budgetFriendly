'use strict';

// The category set and merchant rules. Shared by migration 004 (which replaces
// the original flat categories) and scripts/reset-data.js, so a reset always
// lands on exactly what a fresh install gets. Every insert is idempotent.

// Groups carry the kind; every category inherits its group's kind.
//   income   — counts toward income
//   spending — counts toward expenses and budgets
//   transfer — money moving between your own accounts; excluded everywhere
const GROUPS = [
  { name: 'Income', kind: 'income', categories: [
    ['💰', 'Paychecks'], ['🏦', 'Interest'], ['💵', 'Other Income'],
  ] },
  { name: 'Housing', kind: 'spending', categories: [
    ['🏠', 'Rent'], ['🏡', 'Mortgage'], ['🔨', 'Home Improvement'],
  ] },
  { name: 'Bills & Utilities', kind: 'spending', categories: [
    ['⚡', 'Gas & Electric'], ['💧', 'Water'], ['🗑️', 'Garbage'],
    ['🌐', 'Internet & Cable'], ['📱', 'Phone'],
  ] },
  { name: 'Food & Dining', kind: 'spending', categories: [
    ['🛒', 'Groceries'], ['🍽️', 'Restaurants & Bars'], ['☕', 'Coffee Shops'],
  ] },
  { name: 'Auto & Transport', kind: 'spending', categories: [
    ['🚗', 'Auto Payment'], ['⛽', 'Gas'], ['🔧', 'Auto Maintenance'],
    ['🅿️', 'Parking & Tolls'], ['🚕', 'Taxi & Ride Shares'], ['🚌', 'Public Transit'],
  ] },
  { name: 'Shopping', kind: 'spending', categories: [
    ['🛍️', 'Shopping'], ['👕', 'Clothing'], ['💻', 'Electronics'],
    ['🛋️', 'Furniture & Housewares'],
  ] },
  { name: 'Lifestyle', kind: 'spending', categories: [
    ['📺', 'Subscriptions & Streaming'], ['🎮', 'Entertainment & Recreation'],
    ['💇', 'Personal Care'], ['🐾', 'Pets'], ['✈️', 'Travel & Vacation'],
  ] },
  { name: 'Health & Wellness', kind: 'spending', categories: [
    ['💊', 'Medical'], ['🦷', 'Dentist'], ['🏋️', 'Fitness'],
  ] },
  { name: 'Gifts & Donations', kind: 'spending', categories: [
    ['🎁', 'Gifts'], ['❤️', 'Charity'],
  ] },
  { name: 'Education', kind: 'spending', categories: [
    ['🎓', 'Education'], ['📚', 'Student Loans'],
  ] },
  { name: 'Financial', kind: 'spending', categories: [
    ['🛡️', 'Insurance'], ['🧾', 'Taxes'], ['💸', 'Financial Fees'],
    ['🏧', 'Cash & ATM'], ['📄', 'Loan Repayment'],
  ] },
  { name: 'Other', kind: 'spending', categories: [
    ['❓', 'Uncategorized'], ['✏️', 'Check'], ['📦', 'Miscellaneous'],
  ] },
  { name: 'Transfers', kind: 'transfer', categories: [
    ['🔁', 'Transfer'], ['💳', 'Credit Card Payment'],
  ] },
];

// Categories the code refers to by name; they cannot be deleted.
const SYSTEM = new Set(['Paychecks', 'Other Income', 'Uncategorized', 'Transfer']);

// [category, patterns, priority]. Patterns are "contains" matches against the
// normalised merchant plus the raw description. Where two rules match, the
// higher priority wins, then the longer pattern ("UBER EATS" beats "UBER").
const RULES = [
  ['Paychecks', ['PAYROLL', 'DIRECT DEP']],
  ['Interest', ['INTEREST PAID', 'DIVIDEND']],
  ['Rent', ['RENT PAYMENT', 'PROPERTY MGMT', 'APARTMENTS']],
  ['Mortgage', ['MORTGAGE']],
  ['Home Improvement', ['HOME DEPOT', 'LOWES', 'ACE HARDWARE']],
  ['Gas & Electric', ['SMUD', 'PG&E', 'PGANDE']],
  ['Water', ['WATER DIST', 'WATER DEPT']],
  ['Garbage', ['WASTE MANAGEMENT', 'REPUBLIC SERVICES', 'RECOLOGY']],
  ['Internet & Cable', ['COMCAST', 'XFINITY', 'SPECTRUM', 'SONIC.NET', 'FRONTIER COMM']],
  ['Phone', ['AT&T', 'VERIZON', 'T-MOBILE', 'MINT MOBILE', 'VISIBLE']],
  ['Groceries', ['SAFEWAY', 'TRADER JOE', 'WHOLE FOODS', 'RALEYS', 'WINCO', 'SPROUTS',
    'COSTCO', 'SAVE MART', 'GROCERY OUTLET', 'FOOD MAXX', 'SMART FINAL', 'ALDI']],
  ['Restaurants & Bars', ['DOORDASH', 'DD *', 'UBER EATS', 'GRUBHUB', 'CHIPOTLE', 'MCDONALD',
    'TACO BELL', 'IN-N-OUT', 'CHICK-FIL-A', 'PANDA EXPRESS', 'WENDYS', 'DOMINO', 'PIZZA']],
  ['Coffee Shops', ['STARBUCKS', 'DUTCH BROS', 'PEETS', 'BLUE BOTTLE', 'PHILZ']],
  ['Auto Payment', ['AUTO LOAN', 'TOYOTA FINANCIAL', 'HONDA FINANCIAL']],
  ['Gas', ['CHEVRON', 'SHELL', 'ARCO', 'VALERO', 'EXXON', 'CIRCLE K', 'COSTCO GAS']],
  ['Auto Maintenance', ['JIFFY LUBE', 'AUTOZONE', 'OREILLY AUTO', 'DISCOUNT TIRE']],
  ['Parking & Tolls', ['PARKING', 'FASTRAK', 'PARKMOBILE']],
  ['Taxi & Ride Shares', ['UBER', 'LYFT']],
  ['Public Transit', ['SACRT', 'CLIPPER']],
  ['Shopping', ['AMAZON', 'AMZN', 'TARGET', 'WALMART', 'ETSY', 'EBAY', 'SHEIN', 'TEMU']],
  ['Clothing', ['HOLLISTER', 'NIKE', 'OLD NAVY', 'UNIQLO', 'ZARA', 'ROSS STORES', 'TJ MAXX', 'NORDSTROM']],
  ['Electronics', ['BEST BUY', 'APPLE STORE', 'MICRO CENTER', 'NEWEGG']],
  ['Furniture & Housewares', ['IKEA', 'WAYFAIR', 'CRATE & BARREL']],
  ['Subscriptions & Streaming', ['NETFLIX', 'SPOTIFY', 'HULU', 'DISNEY', 'APPLE.COM/BILL',
    'YOUTUBEPREMIUM', 'YOUTUBE PREMIUM', 'AMAZON PRIME', 'PRIME VIDEO', 'ADOBE', 'PATREON',
    'OPENAI', 'CHATGPT', 'ANTHROPIC', 'CLAUDE.AI', 'GITHUB', 'DROPBOX', 'ICLOUD',
    'PARAMOUNT', 'MAX.COM', 'HBO', 'PEACOCK', 'CRUNCHYROLL', 'AUDIBLE']],
  ['Entertainment & Recreation', ['STEAM', 'CINEMARK', 'REGAL', 'TICKETMASTER', 'AMC THEATRE',
    'XBOX', 'PLAYSTATION', 'NINTENDO', 'EPIC GAMES']],
  ['Personal Care', ['GREAT CLIPS', 'SUPERCUTS', 'SEPHORA', 'ULTA', 'SALON', 'BARBER']],
  ['Pets', ['PETCO', 'PETSMART', 'CHEWY', 'VETERINARY', 'BANFIELD']],
  ['Travel & Vacation', ['AIRBNB', 'EXPEDIA', 'SOUTHWEST', 'UNITED AIR', 'DELTA AIR',
    'ALASKA AIR', 'MARRIOTT', 'HILTON', 'HOTEL']],
  ['Medical', ['CVS', 'WALGREENS', 'KAISER', 'SUTTER', 'PHARMACY', 'URGENT CARE']],
  ['Dentist', ['DENTAL', 'DENTIST', 'ORTHODONT']],
  ['Fitness', ['PLANET FITNESS', '24 HOUR FITNESS', 'PELOTON', 'CLIMBING']],
  ['Charity', ['GOFUNDME', 'RED CROSS']],
  ['Education', ['COURSERA', 'UDEMY', 'TUITION']],
  ['Student Loans', ['NELNET', 'MOHELA', 'NAVIENT', 'DEPT OF ED']],
  ['Insurance', ['GEICO', 'STATE FARM', 'PROGRESSIVE', 'ALLSTATE', 'MERCURY INS', 'LEMONADE']],
  ['Taxes', ['FRANCHISE TAX', 'IRS TREAS', 'IRS USATAXPYMT', 'CA DMV']],
  ['Financial Fees', ['OVERDRAFT', 'SERVICE CHARGE', 'ATM FEE', 'FOREIGN TRANSACTION',
    'SINGLE-CURRENCY FEE', 'INTEREST CHARGE', 'LATE FEE', 'MONTHLY FEE']],
  ['Cash & ATM', ['ATM WITHDRAWAL', 'CASH WITHDRAWAL']],
  ['Loan Repayment', ['LOAN PMT', 'LOAN PAYMENT']],
  ['Check', ['CHECK #', 'CHECK NO']],
  ['Transfer', ['TRANSFER', 'VENMO', 'ZELLE', 'CASH APP', 'PAYPAL INST', 'APPLE CASH']],
  // Golden 1 moves between your own accounts: "G1 ONLINE TRANSFER", truncated
  // in many ways by the 32-character OFX name limit.
  ['Transfer', ['G1 ONLINE'], 300],
  ['Credit Card Payment', ['CREDIT CARD PMT', 'CARD PAYMENT', 'CRCARDPMT', 'AUTOPAY PAYMENT',
    'DISCOVER E-PAYMENT', 'CHASE CREDIT CRD', 'CITI CARD', 'AMEX EPAYMENT']],
];

async function seedCategories(q) {
  for (let gi = 0; gi < GROUPS.length; gi += 1) {
    const g = GROUPS[gi];
    const group = await q.one(
      `INSERT INTO category_groups (name, kind, sort_order) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET kind = EXCLUDED.kind
       RETURNING id`,
      [g.name, g.kind, (gi + 1) * 10]
    );
    for (let ci = 0; ci < g.categories.length; ci += 1) {
      const [emoji, name] = g.categories[ci];
      await q.query(
        `INSERT INTO categories (name, kind, emoji, group_id, sort_order, is_system)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (name) DO NOTHING`,
        [name, g.kind, emoji, group.id, (gi + 1) * 100 + ci, SYSTEM.has(name)]
      );
    }
  }

  const names = [];
  const patterns = [];
  const priorities = [];
  for (const [name, list, priority = 100] of RULES) {
    for (const pattern of list) {
      names.push(name);
      patterns.push(pattern);
      priorities.push(priority);
    }
  }
  await q.query(
    `INSERT INTO category_rules (category_id, match_type, pattern, priority)
     SELECT c.id, 'contains', v.pattern, v.priority
       FROM unnest($1::text[], $2::text[], $3::int[]) AS v(name, pattern, priority)
       JOIN categories c ON c.name = v.name
     ON CONFLICT (category_id, match_type, pattern) DO NOTHING`,
    [names, patterns, priorities]
  );
}

module.exports = { seedCategories, GROUPS, RULES, SYSTEM };
