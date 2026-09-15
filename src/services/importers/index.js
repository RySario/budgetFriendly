'use strict';
const db = require('../../db');
const { normaliseMerchant } = require('../../utils/merchant');
const { importHash } = require('../../utils/crypto');
const { round2 } = require('../../utils/money');
const { toISODate } = require('../../utils/dates');
const { categorizeAll, renormaliseMerchants } = require('../detect/categorize');
const { runDetection } = require('../detect');

// ---------------------------------------------------------------------------
// Adapter registry.
//
// Every bank source implements the same tiny contract, so adding an institution
// or a new access method never touches the code downstream of here:
//
//   {
//     id:          'file',
//     label:       'Statement upload',
//     capabilities: { sync: false, upload: true, needsCredentials: false },
//     async fetch(connection, options) -> { accounts: [...], transactions: [...] }
//   }
//
// A normalised transaction is:
//   { externalId?, postedOn: 'YYYY-MM-DD', amount: Number (+in/-out),
//     description: String, accountExternalId: String, pending?: Boolean }
//
// A normalised account is:
//   { externalId, name, type?, subtype?, mask?, currency?,
//     currentBalance?, availableBalance? }
// ---------------------------------------------------------------------------

const adapters = new Map();

function register(adapter) {
  adapters.set(adapter.id, adapter);
}

function getAdapter(id) {
  const a = adapters.get(id);
  if (!a) throw new Error(`Unknown import adapter: ${id}`);
  return a;
}

function listAdapters() {
  return [...adapters.values()].map((a) => ({
    id: a.id,
    label: a.label,
    description: a.description,
    capabilities: a.capabilities,
    configured: typeof a.isConfigured === 'function' ? a.isConfigured() : true,
    configHint: typeof a.configHint === 'function' ? a.configHint() : null,
  }));
}

register(require('./file'));
register(require('./ofx'));
register(require('./web'));

// ---------------------------------------------------------------------------
// Persistence: normalised payload -> database, with dedupe.
// ---------------------------------------------------------------------------

async function upsertAccount(q, connectionId, acct) {
  return q.one(
    `INSERT INTO accounts
       (connection_id, external_id, name, official_name, type, subtype, mask,
        currency, current_balance, available_balance, balance_as_of, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), now())
     ON CONFLICT (connection_id, external_id) DO UPDATE SET
       official_name     = COALESCE(EXCLUDED.official_name, accounts.official_name),
       type              = COALESCE(EXCLUDED.type, accounts.type),
       subtype           = COALESCE(EXCLUDED.subtype, accounts.subtype),
       mask              = COALESCE(EXCLUDED.mask, accounts.mask),
       current_balance   = COALESCE(EXCLUDED.current_balance, accounts.current_balance),
       available_balance = COALESCE(EXCLUDED.available_balance, accounts.available_balance),
       balance_as_of     = now(),
       updated_at        = now()
     RETURNING *`,
    [
      connectionId,
      String(acct.externalId),
      acct.name || 'Account',
      acct.officialName || null,
      acct.type || null,
      acct.subtype || null,
      acct.mask || null,
      acct.currency || 'USD',
      acct.currentBalance == null ? null : round2(acct.currentBalance),
      acct.availableBalance == null ? null : round2(acct.availableBalance),
    ]
  );
}

/**
 * Persist a normalised payload. Dedupe is by content hash (the bank's own id
 * when it gives one), so re-importing an overlapping statement adds nothing.
 * All transactions go in as one INSERT.
 */
async function persist(q, connection, payload, { source }) {
  const accountsById = new Map();
  for (const acct of payload.accounts || []) {
    accountsById.set(String(acct.externalId), await upsertAccount(q, connection.id, acct));
  }
  // A CSV may carry transactions for an account it did not describe.
  const fallbackAccount = accountsById.size === 1 ? [...accountsById.values()][0] : null;

  const rows = new Map(); // hash -> row, so a file repeating itself is harmless
  let skipped = 0;
  let firstOn = null;
  let lastOn = null;

  for (const t of payload.transactions || []) {
    const acctKey = t.accountExternalId == null ? null : String(t.accountExternalId);
    let account = acctKey ? accountsById.get(acctKey) : null;
    if (!account && acctKey) {
      account = await upsertAccount(q, connection.id, { externalId: acctKey, name: `Account ${acctKey.slice(-4)}` });
      accountsById.set(acctKey, account);
    }
    if (!account) account = fallbackAccount;
    if (!account) { skipped += 1; continue; }

    const postedOn = toISODate(t.postedOn);
    const amount = round2(t.amount);
    if (!postedOn || !Number.isFinite(amount)) { skipped += 1; continue; }

    const description = String(t.description || '').trim() || 'Transaction';
    const hash = importHash([
      String(account.id),
      t.externalId ? `id:${t.externalId}` : `c:${postedOn}:${amount.toFixed(2)}:${description}`,
    ]);
    if (rows.has(hash)) continue;

    rows.set(hash, {
      accountId: account.id,
      externalId: t.externalId || null,
      hash,
      postedOn,
      amount,
      description,
      merchantRaw: t.merchantRaw || description,
      merchantKey: normaliseMerchant(t.merchantRaw || description),
      pending: !!t.pending,
    });
    if (!firstOn || postedOn < firstOn) firstOn = postedOn;
    if (!lastOn || postedOn > lastOn) lastOn = postedOn;
  }

  const list = [...rows.values()];
  let imported = 0;
  if (list.length) {
    const res = await q.query(
      `INSERT INTO transactions
         (account_id, external_id, import_hash, posted_on, amount, description,
          merchant_raw, merchant_key, pending, source, needs_review)
       SELECT v.account_id, v.external_id, v.import_hash, v.posted_on, v.amount,
              v.description, v.merchant_raw, v.merchant_key, v.pending, $10, true
         FROM unnest($1::bigint[], $2::text[], $3::text[], $4::date[], $5::numeric[],
                     $6::text[], $7::text[], $8::text[], $9::boolean[])
           AS v(account_id, external_id, import_hash, posted_on, amount,
                description, merchant_raw, merchant_key, pending)
       ON CONFLICT (import_hash) DO NOTHING`,
      [
        list.map((r) => r.accountId),
        list.map((r) => r.externalId),
        list.map((r) => r.hash),
        list.map((r) => r.postedOn),
        list.map((r) => r.amount),
        list.map((r) => r.description),
        list.map((r) => r.merchantRaw),
        list.map((r) => r.merchantKey),
        list.map((r) => r.pending),
        source,
      ]
    );
    imported = res.rowCount;
  }

  return {
    imported,
    duplicates: list.length - imported,
    skipped,
    accounts: [...accountsById.values()].map((a) => ({ id: a.id, name: a.name, mask: a.mask })),
    firstOn,
    lastOn,
  };
}

/** The single connection all statement uploads belong to. */
async function findOrCreateUploadConnection(q = db) {
  const existing = await q.one(
    `SELECT * FROM bank_connections WHERE adapter = 'file' ORDER BY id LIMIT 1`
  );
  if (existing) return existing;
  return q.one(
    `INSERT INTO bank_connections (name, adapter) VALUES ('Statement uploads', 'file') RETURNING *`
  );
}

/**
 * Run one import end-to-end: fetch -> persist -> normalise -> categorise ->
 * detect. Everything after fetching is one database transaction: an import
 * either lands completely or not at all. The attempt is recorded in sync_runs
 * either way, outside the transaction, so failures stay visible.
 */
async function runImport(connection, options = {}) {
  const adapter = getAdapter(connection.adapter);
  const run = await db.one(
    `INSERT INTO sync_runs (connection_id, adapter) VALUES ($1, $2) RETURNING *`,
    [connection.id, connection.adapter]
  );

  try {
    const payload = await adapter.fetch(connection, options);

    const result = await db.tx(async (q) => {
      const stats = await persist(q, connection, payload, { source: adapter.id });
      // Bring every existing row up to the current merchant normalisation and
      // rules, so improvements reach already-imported data. Manually
      // categorised rows are locked and left alone.
      await renormaliseMerchants(q);
      const categorised = await categorizeAll({}, q);
      const detection = await runDetection(q);
      return { ...stats, categorised, detection };
    });

    await db.query(
      `UPDATE sync_runs
          SET finished_at = now(), status = 'ok', imported = $2, duplicates = $3, message = $4
        WHERE id = $1`,
      [run.id, result.imported, result.duplicates,
       `${result.imported} new, ${result.duplicates} already present`]
    );
    await db.query(
      `UPDATE bank_connections SET last_sync_at = now(), status = 'active', last_error = NULL WHERE id = $1`,
      [connection.id]
    );

    return { ...result, runId: run.id };
  } catch (err) {
    console.error('[import] failed:', err);
    await db.query(
      `UPDATE sync_runs SET finished_at = now(), status = 'error', message = $2 WHERE id = $1`,
      [run.id, err.message]
    );
    await db.query(
      `UPDATE bank_connections SET status = 'error', last_error = $2 WHERE id = $1`,
      [connection.id, err.message]
    );
    throw err;
  }
}

module.exports = {
  register, getAdapter, listAdapters, runImport, persist, findOrCreateUploadConnection,
};
