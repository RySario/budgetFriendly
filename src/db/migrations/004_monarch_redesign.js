'use strict';
const { seedCategories } = require('../seed');

// Schema for the redesign: category groups with emoji, per-month budgets that
// carry forward, and a review flag on imported transactions. Replaces the
// original flat category set with the grouped one — existing transactions lose
// their category here and are re-categorised on the next import.

async function up(q) {
  // Category names carry emoji. A non-UTF8 database rejects them mid-seed with
  // an opaque conversion error, so say what is actually wrong up front.
  const { server_encoding: encoding } = await q.one('SHOW server_encoding');
  if (encoding !== 'UTF8') {
    throw new Error(
      `The database uses ${encoding} encoding; BudgetFriendly needs UTF8. ` +
      'Create the database with ENCODING \'UTF8\' (Dokku\'s postgres plugin does this by default).'
    );
  }

  await q.query(`
    CREATE TABLE IF NOT EXISTS category_groups (
      id         bigserial PRIMARY KEY,
      name       text NOT NULL UNIQUE,
      kind       text NOT NULL DEFAULT 'spending', -- income | spending | transfer
      sort_order integer NOT NULL DEFAULT 100,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await q.query(`
    ALTER TABLE categories
      ADD COLUMN IF NOT EXISTS group_id bigint REFERENCES category_groups(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS emoji text
  `);

  // A budget row applies from its month onward until a later row replaces it,
  // so setting groceries to $600 in September also budgets October onward.
  await q.query(`
    CREATE TABLE IF NOT EXISTS budgets (
      id          bigserial PRIMARY KEY,
      category_id bigint NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      month       date NOT NULL, -- first day of the month
      amount      numeric(14,2) NOT NULL,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (category_id, month)
    )
  `);

  await q.query(`
    ALTER TABLE transactions
      ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false
  `);
  await q.query(`
    CREATE INDEX IF NOT EXISTS transactions_review_idx
      ON transactions (posted_on DESC) WHERE needs_review
  `);

  await q.query('UPDATE transactions SET category_id = NULL, category_locked = false');
  await q.query('DELETE FROM category_rules');
  await q.query('DELETE FROM categories');
  await seedCategories(q);
}

module.exports = { up };
