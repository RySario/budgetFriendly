'use strict';
const { Pool } = require('pg');
const { config } = require('../config');

// numeric/int8 come back as strings from pg by default so precision is not
// silently lost. Money lives in numeric(14,2); parse it to Number at the edge.
const types = require('pg').types;
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));
// `date` columns stay as their 'YYYY-MM-DD' text. The default turns them into
// JS Dates at local midnight, which stringify as "Tue Aug 04 ..." and shift a
// day when serialised in any timezone other than UTC.
types.setTypeParser(1082, (v) => v);

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.pgSsl ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err.message);
});

/**
 * The query helpers bound to one runner — the pool, or a single client inside
 * a transaction. Services take one of these as `q` so the same code runs
 * standalone or as part of a larger atomic unit of work.
 */
function scope(runner) {
  return {
    query: (text, params) => runner.query(text, params),
    one: async (text, params) => (await runner.query(text, params)).rows[0] || null,
    many: async (text, params) => (await runner.query(text, params)).rows,
  };
}

/** Run fn(q) inside BEGIN/COMMIT; any throw rolls the whole unit back. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(scope(client));
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, ...scope(pool), tx, scope };
