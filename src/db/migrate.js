'use strict';
const fs = require('fs');
const path = require('path');
const { validate } = require('../config');
const db = require('./index');

const DIR = path.join(__dirname, 'migrations');

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
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
    process.stdout.write(`[migrate] applying ${file} ... `);
    await db.tx(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
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
