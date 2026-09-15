-- Starter categories + merchant rules. Safe to re-run; all inserts are guarded.
INSERT INTO categories (name, kind, color, sort_order, is_system) VALUES
  ('Income',          'income',   '#16a34a', 10,  true),
  ('Transfer',        'transfer', '#64748b', 20,  true),
  ('Rent & Mortgage', 'spending', '#7c3aed', 30,  false),
  ('Utilities',       'spending', '#0ea5e9', 40,  false),
  ('Groceries',       'spending', '#22c55e', 50,  false),
  ('Dining & Coffee', 'spending', '#f97316', 60,  false),
  ('Transportation',  'spending', '#06b6d4', 70,  false),
  ('Subscriptions',   'spending', '#ec4899', 80,  false),
  ('Insurance',       'spending', '#8b5cf6', 90,  false),
  ('Health',          'spending', '#ef4444', 100, false),
  ('Shopping',        'spending', '#eab308', 110, false),
  ('Entertainment',   'spending', '#a855f7', 120, false),
  ('Fees & Interest', 'spending', '#78716c', 130, false),
  ('Savings',         'transfer', '#14b8a6', 140, false),
  ('Uncategorized',   'spending', '#9ca3af', 999, true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO category_rules (category_id, match_type, pattern, priority)
SELECT c.id, 'contains', p.pattern, 100
FROM (VALUES
  ('Groceries',       'SAFEWAY'), ('Groceries','TRADER JOE'), ('Groceries','WHOLE FOODS'),
  ('Groceries',       'RALEYS'),  ('Groceries','WINCO'),      ('Groceries','SPROUTS'),
  ('Groceries',       'COSTCO'),  ('Groceries','SAVE MART'),  ('Groceries','GROCERY OUTLET'),
  ('Dining & Coffee', 'STARBUCKS'), ('Dining & Coffee','DUTCH BROS'), ('Dining & Coffee','CHIPOTLE'),
  ('Dining & Coffee', 'DOORDASH'),  ('Dining & Coffee','UBER EATS'),  ('Dining & Coffee','GRUBHUB'),
  ('Dining & Coffee', 'PEETS'),     ('Dining & Coffee','MCDONALD'),   ('Dining & Coffee','TACO BELL'),
  ('Transportation',  'CHEVRON'), ('Transportation','SHELL'),  ('Transportation','ARCO'),
  ('Transportation',  'UBER'),    ('Transportation','LYFT'),   ('Transportation','VALERO'),
  ('Transportation',  'DMV'),     ('Transportation','PARKING'),
  ('Utilities',       'SMUD'),    ('Utilities','PG&E'),        ('Utilities','PGANDE'),
  ('Utilities',       'COMCAST'), ('Utilities','XFINITY'),     ('Utilities','AT&T'),
  ('Utilities',       'VERIZON'), ('Utilities','T-MOBILE'),    ('Utilities','WASTE MANAGEMENT'),
  ('Subscriptions',   'NETFLIX'), ('Subscriptions','SPOTIFY'), ('Subscriptions','HULU'),
  ('Subscriptions',   'DISNEY'),  ('Subscriptions','APPLE.COM/BILL'), ('Subscriptions','YOUTUBEPREMIUM'),
  ('Subscriptions',   'AMAZON PRIME'), ('Subscriptions','ADOBE'), ('Subscriptions','PATREON'),
  ('Subscriptions',   'OPENAI'),  ('Subscriptions','ANTHROPIC'), ('Subscriptions','GITHUB'),
  ('Subscriptions',   'DROPBOX'), ('Subscriptions','ICLOUD'),
  ('Shopping',        'AMAZON'),  ('Shopping','TARGET'),       ('Shopping','WALMART'),
  ('Shopping',        'BEST BUY'),('Shopping','HOME DEPOT'),   ('Shopping','ETSY'),
  ('Entertainment',   'STEAM'),   ('Entertainment','CINEMARK'),('Entertainment','TICKETMASTER'),
  ('Health',          'CVS'),     ('Health','WALGREENS'),      ('Health','KAISER'),
  ('Health',          'SUTTER'),  ('Health','DENTAL'),         ('Health','PHARMACY'),
  ('Insurance',       'GEICO'),   ('Insurance','STATE FARM'),  ('Insurance','PROGRESSIVE'),
  ('Insurance',       'ALLSTATE'),('Insurance','MERCURY INS'),
  ('Rent & Mortgage', 'RENT'),    ('Rent & Mortgage','MORTGAGE'), ('Rent & Mortgage','PROPERTY MGMT'),
  ('Fees & Interest', 'OVERDRAFT'),   ('Fees & Interest','SERVICE CHARGE'),
  ('Fees & Interest', 'ATM FEE'),     ('Fees & Interest','INTEREST CHARGE'),
  ('Fees & Interest', 'FOREIGN TRANSACTION'),
  ('Transfer',        'TRANSFER'), ('Transfer','VENMO'),       ('Transfer','ZELLE'),
  ('Transfer',        'CASH APP'), ('Transfer','PAYPAL INST')
) AS p(category_name, pattern)
JOIN categories c ON c.name = p.category_name
WHERE NOT EXISTS (
  SELECT 1 FROM category_rules r WHERE r.category_id = c.id AND r.pattern = p.pattern
);
