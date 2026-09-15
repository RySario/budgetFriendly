'use strict';
const { config } = require('../../config');
const { decryptJSON } = require('../../utils/crypto');
const { parseOFX, extractStatements, arr } = require('./parse-ofx');
const { toISODate, addDays } = require('../../utils/dates');

// OFX Direct Connect.
//
// This is the protocol Quicken and Microsoft Money used, and many credit unions
// still run an OFX server for it. You store your online-banking credentials
// once (encrypted with ENCRYPTION_KEY), and "Sync now" posts a signed OFX
// request straight to the institution's OFX endpoint and reads the statement
// back. It is a real API — no screen scraping, no HTML parsing, nothing that
// breaks when the bank restyles its website.
//
// What you need before this works (see README):
//   OFX_URL      the institution's OFX server endpoint
//   OFX_FI_ORG   the FI "ORG" string
//   OFX_FI_ID    the FI "FID" number
//   OFX_BANK_ID  your routing number
//
// Those four values are institution-specific and are NOT guessed here. Look
// them up at ofxhome.com or ask Golden 1 for their Direct Connect settings; some
// institutions also require you to enable Direct Connect on your account first,
// and some issue a separate Direct Connect PIN rather than your web password.

function ofxTimestamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    date.getUTCFullYear() +
    p(date.getUTCMonth() + 1) + p(date.getUTCDate()) +
    p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) +
    '.' + p(date.getUTCMilliseconds(), 3) + '[0:GMT]'
  );
}

function ofxDateOnly(iso) {
  return String(iso).replace(/-/g, '') + '000000';
}

function settingsFor(connection) {
  const stored = connection.settings || {};
  return {
    url: stored.url || config.ofx.url,
    org: stored.org || config.ofx.org,
    fid: stored.fid || config.ofx.fid,
    bankId: stored.bankId || config.ofx.bankId,
    appId: stored.appId || config.ofx.appId,
    appVer: stored.appVer || config.ofx.appVer,
    version: String(stored.version || config.ofx.version),
  };
}

function buildHeader(version) {
  if (version.startsWith('2')) {
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\r\n' +
      `<?OFX OFXHEADER="200" VERSION="${version}" SECURITY="NONE" ` +
      'OLDFILEUID="NONE" NEWFILEUID="NONE"?>\r\n'
    );
  }
  return [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    `VERSION:${version}`,
    'SECURITY:NONE',
    'ENCODING:USASCII',
    'CHARSET:1252',
    'COMPRESSION:NONE',
    'OLDFILEUID:NONE',
    'NEWFILEUID:NONE',
    '', '',
  ].join('\r\n');
}

function signOn(s, creds) {
  return [
    '<SIGNONMSGSRQV1>',
    '<SONRQ>',
    `<DTCLIENT>${ofxTimestamp()}`,
    `<USERID>${creds.username}`,
    `<USERPASS>${creds.password}`,
    '<LANGUAGE>ENG',
    '<FI>',
    `<ORG>${s.org}`,
    `<FID>${s.fid}`,
    '</FI>',
    `<APPID>${s.appId}`,
    `<APPVER>${s.appVer}`,
    '</SONRQ>',
    '</SIGNONMSGSRQV1>',
  ].join('\r\n');
}

function uuid() {
  return require('crypto').randomUUID().toUpperCase();
}

/** Request the list of accounts the credentials can see. */
function buildAccountListRequest(s, creds) {
  return (
    buildHeader(s.version) +
    '<OFX>\r\n' + signOn(s, creds) + '\r\n' +
    [
      '<SIGNUPMSGSRQV1>',
      '<ACCTINFOTRNRQ>',
      `<TRNUID>${uuid()}`,
      '<ACCTINFORQ>',
      '<DTACCTUP>19700101000000',
      '</ACCTINFORQ>',
      '</ACCTINFOTRNRQ>',
      '</SIGNUPMSGSRQV1>',
      '</OFX>',
    ].join('\r\n')
  );
}

/** Request a statement for one account over a date range. */
function buildStatementRequest(s, creds, account, startIso, endIso) {
  const isCredit = account.type === 'credit' || account.acctType === 'CREDITLINE';

  const body = isCredit
    ? [
        '<CREDITCARDMSGSRQV1>',
        '<CCSTMTTRNRQ>',
        `<TRNUID>${uuid()}`,
        '<CCSTMTRQ>',
        '<CCACCTFROM>',
        `<ACCTID>${account.externalId}`,
        '</CCACCTFROM>',
        '<INCTRAN>',
        `<DTSTART>${ofxDateOnly(startIso)}`,
        `<DTEND>${ofxDateOnly(endIso)}`,
        '<INCLUDE>Y',
        '</INCTRAN>',
        '</CCSTMTRQ>',
        '</CCSTMTTRNRQ>',
        '</CREDITCARDMSGSRQV1>',
      ]
    : [
        '<BANKMSGSRQV1>',
        '<STMTTRNRQ>',
        `<TRNUID>${uuid()}`,
        '<STMTRQ>',
        '<BANKACCTFROM>',
        `<BANKID>${s.bankId}`,
        `<ACCTID>${account.externalId}`,
        `<ACCTTYPE>${account.acctType || 'CHECKING'}`,
        '</BANKACCTFROM>',
        '<INCTRAN>',
        `<DTSTART>${ofxDateOnly(startIso)}`,
        `<DTEND>${ofxDateOnly(endIso)}`,
        '<INCLUDE>Y',
        '</INCTRAN>',
        '</STMTRQ>',
        '</STMTTRNRQ>',
        '</BANKMSGSRQV1>',
      ];

  return (
    buildHeader(s.version) +
    '<OFX>\r\n' + signOn(s, creds) + '\r\n' + body.join('\r\n') + '\r\n</OFX>'
  );
}

async function post(url, payload, version) {
  const contentType = version.startsWith('2')
    ? 'application/x-ofx'
    : 'application/x-ofx';

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      Accept: '*/*, application/x-ofx',
      'User-Agent': 'InetClntApp/3.0',
      Connection: 'close',
    },
    body: payload,
    // Institutions are slow; give them room but do not hang a request forever.
    signal: AbortSignal.timeout(60000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OFX server returned HTTP ${res.status}. ${text.slice(0, 200)}`);
  }
  return text;
}

function checkSignOn(tree) {
  const status = tree?.SIGNONMSGSRSV1?.SONRS?.STATUS;
  const code = String(status?.CODE ?? '0');
  if (code === '0') return;
  const message = status?.MESSAGE || '';
  if (code === '15500') {
    throw new Error('The institution rejected the username or password (OFX 15500).');
  }
  if (code === '15000' || code === '15502') {
    throw new Error(
      `The institution requires a password change or extra verification before Direct Connect will work (OFX ${code}). ${message}`
    );
  }
  throw new Error(`OFX sign-on failed (code ${code}). ${message}`);
}

/** Read ACCTINFO entries out of an account-list response. */
function parseAccountList(tree) {
  const responses = arr(tree?.SIGNUPMSGSRSV1?.ACCTINFOTRNRS).flatMap((r) => arr(r.ACCTINFORS));
  const infos = responses.flatMap((r) => arr(r.ACCTINFO));
  const out = [];

  for (const info of infos) {
    for (const bank of arr(info.BANKACCTINFO)) {
      const from = bank.BANKACCTFROM || {};
      if (!from.ACCTID) continue;
      out.push({
        externalId: String(from.ACCTID),
        acctType: String(from.ACCTTYPE || 'CHECKING').toUpperCase(),
        type: 'depository',
        description: info.DESC || null,
      });
    }
    for (const cc of arr(info.CCACCTINFO)) {
      const from = cc.CCACCTFROM || {};
      if (!from.ACCTID) continue;
      out.push({
        externalId: String(from.ACCTID),
        acctType: 'CREDITLINE',
        type: 'credit',
        description: info.DESC || null,
      });
    }
  }
  return out;
}

module.exports = {
  id: 'ofx',
  label: 'Direct Connect (OFX)',
  description:
    'Log in to your institution with your online-banking credentials over the ' +
    'OFX Direct Connect protocol and pull statements on demand. Requires the ' +
    'institution OFX endpoint details.',
  capabilities: { sync: true, upload: false, needsCredentials: true },

  isConfigured() {
    return Boolean(config.ofx.url && config.ofx.org && config.ofx.fid);
  },

  configHint() {
    const missing = [];
    if (!config.ofx.url) missing.push('OFX_URL');
    if (!config.ofx.org) missing.push('OFX_FI_ORG');
    if (!config.ofx.fid) missing.push('OFX_FI_ID');
    if (!config.ofx.bankId) missing.push('OFX_BANK_ID');
    return missing.length
      ? `Set ${missing.join(', ')} — look the values up at ofxhome.com or ask your institution for their Direct Connect settings.`
      : null;
  },

  /** Probe credentials and list accounts without importing anything. */
  async discover(connection) {
    const s = settingsFor(connection);
    const creds = decryptJSON(connection.credentials_enc);
    if (!creds) throw new Error('No stored credentials for this connection.');
    if (!s.url) throw new Error('OFX_URL is not set.');

    const tree = parseOFX(await post(s.url, buildAccountListRequest(s, creds), s.version));
    checkSignOn(tree);
    return parseAccountList(tree);
  },

  async fetch(connection, options = {}) {
    const s = settingsFor(connection);
    if (!s.url) throw new Error('OFX_URL is not set — see the README section on Direct Connect.');
    if (!s.org || !s.fid) throw new Error('OFX_FI_ORG and OFX_FI_ID must both be set.');

    const creds = decryptJSON(connection.credentials_enc);
    if (!creds || !creds.username) {
      throw new Error('No stored credentials for this connection. Re-enter them in Settings.');
    }

    const today = toISODate(new Date());
    const days = options.days || config.ofx.syncDays;
    const startIso = options.since || addDays(today, -days);

    // Ask what accounts exist, falling back to any we already know about if the
    // institution does not support ACCTINFO.
    let accountList = [];
    try {
      const tree = parseOFX(await post(s.url, buildAccountListRequest(s, creds), s.version));
      checkSignOn(tree);
      accountList = parseAccountList(tree);
    } catch (err) {
      if (/rejected the username|sign-on failed|verification/i.test(err.message)) throw err;
      accountList = [];
    }

    if (!accountList.length && Array.isArray(options.knownAccounts) && options.knownAccounts.length) {
      accountList = options.knownAccounts.map((a) => ({
        externalId: a.external_id,
        acctType: (a.subtype || 'checking').toUpperCase(),
        type: a.type || 'depository',
      }));
    }

    if (!accountList.length) {
      throw new Error(
        'The institution did not return any accounts. Direct Connect may need to be ' +
        'enabled on your account, or it may require a separate Direct Connect PIN.'
      );
    }

    const accounts = [];
    const transactions = [];

    for (const account of accountList) {
      const raw = await post(s.url, buildStatementRequest(s, creds, account, startIso, today), s.version);
      const tree = parseOFX(raw);
      checkSignOn(tree);

      const extracted = extractStatements(tree);
      for (const a of extracted.accounts) {
        accounts.push({ ...a, name: account.description || a.name });
      }
      transactions.push(...extracted.transactions);
    }

    return { accounts, transactions };
  },
};
