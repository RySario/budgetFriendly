'use strict';
const crypto = require('crypto');
const { config } = require('../config');

// Bank credentials for the OFX adapter have to be replayable on every sync, so
// they are stored reversibly — AES-256-GCM under ENCRYPTION_KEY, which lives in
// the environment and never in the database. Losing or rotating that key makes
// stored credentials unreadable (re-enter them; nothing else is affected).

const ALGO = 'aes-256-gcm';

function key() {
  if (!config.encryptionKey) {
    throw new Error('ENCRYPTION_KEY is not set — cannot store bank credentials.');
  }
  return Buffer.from(config.encryptionKey, 'hex');
}

function encryptJSON(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

function decryptJSON(blob) {
  if (!blob) return null;
  const [version, ivB64, tagB64, dataB64] = String(blob).split('.');
  if (version !== 'v1') throw new Error('Unrecognised credential blob version.');
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(dec.toString('utf8'));
}

/** Stable dedupe fingerprint for an imported transaction. */
function importHash(parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

module.exports = { encryptJSON, decryptJSON, importHash };
