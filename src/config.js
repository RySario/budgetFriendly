'use strict';
require('dotenv').config();

function bool(v, dflt = false) {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v));
}
function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 3000),

  databaseUrl: process.env.DATABASE_URL,
  pgSsl: /^require$/i.test(process.env.PGSSLMODE || ''),

  sessionSecret: process.env.SESSION_SECRET || '',
  sessionTtlDays: int(process.env.SESSION_TTL_DAYS, 30),
  adminEmail: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || '',

  encryptionKey: process.env.ENCRYPTION_KEY || '',

  maxUploadBytes: int(process.env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024),

  // Number of reverse proxies in front of the app, so Express resolves req.ip
  // to the real client rather than a proxy. The login throttle keys on it.
  //   1 = Dokku's nginx alone
  //   2 = Dokku's nginx behind a tunnel (Tailscale serve, Cloudflare Tunnel)
  trustProxy: int(process.env.TRUST_PROXY, 1),

  ofx: {
    url: process.env.OFX_URL || '',
    org: process.env.OFX_FI_ORG || '',
    fid: process.env.OFX_FI_ID || '',
    bankId: process.env.OFX_BANK_ID || '',
    appId: process.env.OFX_APP_ID || 'QWIN',
    appVer: process.env.OFX_APP_VER || '2700',
    version: process.env.OFX_VERSION || '103',
    syncDays: int(process.env.OFX_SYNC_DAYS, 90),
  },

  webAdapterEnabled: bool(process.env.WEB_ADAPTER_ENABLED, false),
};

config.isProd = config.env === 'production';

function validate() {
  const problems = [];
  if (!config.databaseUrl) problems.push('DATABASE_URL is not set.');
  if (!config.sessionSecret || config.sessionSecret.length < 16) {
    problems.push('SESSION_SECRET is missing or too short (need >= 16 chars).');
  }
  if (config.encryptionKey && !/^[0-9a-f]{64}$/i.test(config.encryptionKey)) {
    problems.push('ENCRYPTION_KEY must be exactly 64 hex characters.');
  }
  return problems;
}

module.exports = { config, validate };
