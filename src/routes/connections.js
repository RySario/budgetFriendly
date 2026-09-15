'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { config } = require('../config');
const { encryptJSON } = require('../utils/crypto');
const { listAdapters, getAdapter, runImport } = require('../services/importers');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

// Never let the encrypted credential blob out of the API.
function publicConnection(row, accounts = []) {
  const { credentials_enc, ...rest } = row;
  return {
    ...rest,
    hasCredentials: Boolean(credentials_enc),
    accounts,
  };
}

router.get('/adapters', (req, res) => {
  res.json({ adapters: listAdapters() });
});

router.get('/', async (req, res, next) => {
  try {
    const rows = await db.many('SELECT * FROM bank_connections ORDER BY id');
    const accounts = await db.many(
      `SELECT id, connection_id, external_id, name, type, subtype, mask,
              current_balance, available_balance, balance_as_of, archived
         FROM accounts ORDER BY connection_id, name`
    );
    res.json({
      connections: rows.map((c) =>
        publicConnection(c, accounts.filter((a) => a.connection_id === c.id))
      ),
    });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, adapter, institutionId, username, password, settings } = req.body || {};
    if (!name || !adapter) return res.status(400).json({ error: 'name and adapter are required.' });

    let adapterDef;
    try { adapterDef = getAdapter(adapter); }
    catch { return res.status(400).json({ error: `Unknown adapter "${adapter}".` }); }

    let credentials = null;
    if (adapterDef.capabilities.needsCredentials) {
      if (!username || !password) {
        return res.status(400).json({ error: 'This connection type needs a username and password.' });
      }
      if (!config.encryptionKey) {
        return res.status(400).json({
          error: 'ENCRYPTION_KEY is not set, so bank credentials cannot be stored securely.',
        });
      }
      credentials = encryptJSON({ username, password, settings: settings || {} });
    }

    const row = await db.one(
      `INSERT INTO bank_connections (name, adapter, institution_id, credentials_enc)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, adapter, institutionId || null, credentials]
    );
    res.status(201).json({ connection: publicConnection(row) });
  } catch (err) { next(err); }
});

router.put('/:id/credentials', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required.' });
    }
    const row = await db.one(
      `UPDATE bank_connections SET credentials_enc = $2, status = 'active', last_error = NULL
        WHERE id = $1 RETURNING *`,
      [req.params.id, encryptJSON({ username, password })]
    );
    if (!row) return res.status(404).json({ error: 'Connection not found.' });
    res.json({ connection: publicConnection(row) });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await db.query('DELETE FROM bank_connections WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** Probe credentials without importing (OFX adapter only). */
router.post('/:id/discover', async (req, res, next) => {
  try {
    const conn = await db.one('SELECT * FROM bank_connections WHERE id = $1', [req.params.id]);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });

    const adapter = getAdapter(conn.adapter);
    if (typeof adapter.discover !== 'function') {
      return res.status(400).json({ error: 'This connection type does not support discovery.' });
    }
    res.json({ accounts: await adapter.discover(conn) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/** Manual "sync now". */
router.post('/:id/sync', async (req, res, next) => {
  try {
    const conn = await db.one('SELECT * FROM bank_connections WHERE id = $1', [req.params.id]);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });

    const adapter = getAdapter(conn.adapter);
    if (!adapter.capabilities.sync) {
      return res.status(400).json({
        error: `"${adapter.label}" cannot sync on its own — upload a statement instead.`,
      });
    }

    const knownAccounts = await db.many(
      'SELECT external_id, type, subtype FROM accounts WHERE connection_id = $1',
      [conn.id]
    );
    const result = await runImport(conn, {
      days: req.body && req.body.days ? Number(req.body.days) : undefined,
      knownAccounts,
    });
    res.json({ result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/** Statement upload (file adapter). */
router.post('/:id/upload', upload.single('file'), async (req, res, next) => {
  try {
    const conn = await db.one('SELECT * FROM bank_connections WHERE id = $1', [req.params.id]);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const result = await runImport(conn, { file: req.file });
    res.json({ result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/runs', async (req, res, next) => {
  try {
    const runs = await db.many(
      `SELECT r.*, c.name AS connection_name
         FROM sync_runs r LEFT JOIN bank_connections c ON c.id = r.connection_id
        ORDER BY r.started_at DESC LIMIT 25`
    );
    res.json({ runs });
  } catch (err) { next(err); }
});

module.exports = router;
