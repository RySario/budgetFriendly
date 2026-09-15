'use strict';
const fs = require('fs');
const path = require('path');
const { validate } = require('../config');
const db = require('./index');

const DIR = path.join(__dirname, 'migrations');

// Forward-only migrations, applied in filename order, each in its own
// transaction. A `.sql` file runs as-is; a `.js` file exports `up(q)` for the
// migrations that need shared code (the category seed).

async function run() {
  const problems = validate().filter((p) => p.includes('DATABASE_URL'));
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await db.many('SELECT name FROM schema_migrations')).map((r) => r.name)
  );
  const files = fs.readdirSync(DIR).filter((f) => /\.(sql|js)$/.test(f)).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const full = path.join(DIR, file);
    process.stdout.write(`[migrate] applying ${file} ... `);
    await db.tx(async (q) => {
      if (file.endsWith('.js')) {
        await require(full).up(q);
      } else {
        await q.query(fs.readFileSync(full, 'utf8'));
      }
      await q.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    console.log('done');
  }
  console.log(`[migrate] up to date (${files.length} migration(s))`);
}

if (require.main === module) {
  run()
    .then(() => db.pool.end())
    .catch((err) => {
      console.error('[migrate] failed:', err.message);
      process.exit(1);
    });
}

module.exports = { run };
