'use strict';
const db = require('../../db');
const { normaliseMerchant } = require('../../utils/merchant');
const { importHash } = require('../../utils/crypto');
const { round2 } = require('../../utils/money');
const { toISODate } = require('../../utils/dates');
const { categorizeAll } = require('../detect/categorize');
const { runDetection } = require('../detect');

// ---------------------------------------------------------------------------
// Adapter registry.
//
// Every bank source implements the same tiny contract, so adding an institution
// or a new access method never touches the code downstream of here:
//
//   {
//     id:          'ofx',
//     label:       'Direct Connect (OFX)',
//     capabilities: { sync: true, upload: false, needsCredentials: true },
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

async function upsertAccount(connectionId, acct) {
  const row = await db.one(
    `INSERT INTO accounts
       (connection_id, external_id, name, official_name, type, subtype, mask,
        currency, current_balance, available_balance, balance_as_of, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), now())
     ON CONFLICT (connection_id, external_id) DO UPDATE SET
       name              = EXCLUDED.name,
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
  return row;
}

/**
 * Persist a normalised payload. Dedupe is by content hash, so re-importing an
 * overlapping statement is a no-op rather than a pile of duplicates.
 */
async function persist(connection, payload, { source }) {
  const accountsById = new Map();

  for (const acct of payload.accounts || []) {
    const row = await upsertAccount(connection.id, acct);
    accountsById.set(String(acct.externalId), row);
  }

  // A file import may carry transactions for an account it did not describe.
  const fallbackAccount = accountsById.size === 1 ? [...accountsById.values()][0] : null;

  let imported = 0;
  let duplicates = 0;
  let skipped = 0;

  for (const t of payload.transactions || []) {
    const acctKey = t.accountExternalId == null ? null : String(t.accountExternalId);
    let account = acctKey ? accountsById.get(acctKey) : null;

    if (!account && acctKey) {
      account = await upsertAccount(connection.id, { externalId: acctKey, name: `Account ${acctKey}` });
      accountsById.set(acctKey, account);
    }
    if (!account) account = fallbackAccount;
    if (!account) { skipped += 1; continue; }

    const postedOn = toISODate(t.postedOn);
    const amount = round2(t.amount);
    if (!postedOn || !Number.isFinite(amount)) { skipped += 1; continue; }

    const description = String(t.description || '').trim() || 'Transaction';
    const merchantKey = normaliseMerchant(t.merchantRaw || description);

    // Include the bank's own id when it gives one — it is the strongest signal —
    // and otherwise fall back to the content fingerprint.
    const hash = importHash([
      String(account.id),
      t.externalId ? `id:${t.externalId}` : `c:${postedOn}:${amount.toFixed(2)}:${description}`,
    ]);

    const res = await db.query(
      `INSERT INTO transactions
         (account_id, external_id, import_hash, posted_on, amount, description,
          merchant_raw, merchant_key, pending, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (import_hash) DO NOTHING`,
      [
        account.id, t.externalId || null, hash, postedOn, amount, description,
        t.merchantRaw || description, merchantKey, !!t.pending, source,
      ]
    );
    if (res.rowCount === 1) imported += 1; else duplicates += 1;
  }

  return { imported, duplicates, skipped, accounts: accountsById.size };
}

/**
 * Run one import end-to-end: fetch -> persist -> categorise -> detect.
 * Records the attempt in sync_runs either way so failures are visible in the UI.
 */
async function runImport(connection, options = {}) {
  const adapter = getAdapter(connection.adapter);

  const run = await db.one(
    `INSERT INTO sync_runs (connection_id, adapter) VALUES ($1, $2) RETURNING *`,
    [connection.id, connection.adapter]
  );

  try {
    const payload = await adapter.fetch(connection, options);
    const stats = await persist(connection, payload, { source: adapter.id });
    const categorised = await categorizeAll({ onlyUncategorised: true });
    const detection = await runDetection();

    await db.query(
      `UPDATE sync_runs
          SET finished_at = now(), status = 'ok', imported = $2, duplicates = $3, message = $4
        WHERE id = $1`,
      [run.id, stats.imported, stats.duplicates,
       `${stats.imported} new, ${stats.duplicates} already present`]
    );
    await db.query(
      `UPDATE bank_connections
          SET last_sync_at = now(), status = 'active', last_error = NULL
        WHERE id = $1`,
      [connection.id]
    );

    return { ...stats, categorised, detection, runId: run.id };
  } catch (err) {
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

module.exports = { register, getAdapter, listAdapters, runImport, persist };
