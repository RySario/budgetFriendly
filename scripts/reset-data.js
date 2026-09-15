'use strict';
/* Wipe all financial data and start clean. Keeps the login.
 *
 *   dokku run budgetfriendly npm run reset-data -- --yes
 *   npm run reset-data -- --yes            (local)
 *
 * Deletes transactions, accounts, uploads history, recurring bills and income,
 * budgets, goals, categories and rules, then restores the default categories
 * and rules. Your user account and password are untouched. Cannot be undone —
 * re-upload your statements afterwards.
 */

const db = require('../src/db');
const { run: migrate } = require('../src/db/migrate');
const { seedCategories } = require('../src/db/seed');

const TABLES = [
  'budgets', 'goal_contributions', 'goals', 'subscriptions', 'income_sources',
  'sync_runs', 'transactions', 'accounts', 'bank_connections', 'settings',
  'category_rules', 'categories', 'category_groups',
];

async function main() {
  if (!process.argv.includes('--yes')) {
    console.error(
      'This permanently deletes every transaction, account, budget, goal, category and rule.\n' +
      'Your login is kept. Re-run with --yes to proceed:\n\n' +
      '  npm run reset-data -- --yes\n'
    );
    process.exit(1);
  }

  // The tables must exist in their current shape before they can be emptied.
  await migrate();

  const before = await db.one(
    `SELECT (SELECT COUNT(*)::int FROM transactions) AS transactions,
            (SELECT COUNT(*)::int FROM accounts)     AS accounts,
            (SELECT COUNT(*)::int FROM users)        AS users`
  );

  await db.tx(async (q) => {
    await q.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    await seedCategories(q);
  });

  const after = await db.one(
    `SELECT (SELECT COUNT(*)::int FROM transactions) AS transactions,
            (SELECT COUNT(*)::int FROM categories)   AS categories,
            (SELECT COUNT(*)::int FROM category_rules) AS rules,
            (SELECT COUNT(*)::int FROM users)        AS users`
  );

  console.log(`[reset] removed ${before.transactions} transactions and ${before.accounts} accounts`);
  console.log(`[reset] restored ${after.categories} categories and ${after.rules} rules`);
  console.log(`[reset] kept ${after.users} login(s) — done. Upload your statements again.`);
}

main()
  .then(() => db.pool.end())
  .catch((err) => {
    console.error('[reset] failed, nothing was changed:', err.message);
    process.exit(1);
  });
