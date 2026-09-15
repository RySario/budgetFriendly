'use strict';
const { config } = require('../../config');
const { decryptJSON } = require('../../utils/crypto');

// Web-automation adapter — an extension point, deliberately not implemented.
//
// Golden 1 publishes no web API, so the only way to "just log in" without OFX
// Direct Connect is to drive their website in a headless browser. That is worth
// understanding before you build it:
//
//   * It breaks whenever they change their markup, which is unannounced.
//   * MFA (SMS/email/app code) fires on every new "device". Any automated login
//     will sit at a challenge screen unless you handle the code out-of-band.
//   * Bot detection can lock the account rather than just fail the login.
//   * Your banking password has to sit on disk in a form the app can replay.
//
// If you still want it — and on a hardened homelab that is a reasonable call —
// implement fetch() below and set WEB_ADAPTER_ENABLED=true. The contract is the
// same as every other adapter, so nothing downstream changes: return normalised
// accounts and transactions and the rest of the app behaves identically.
//
// Sketch, using Playwright (npm i playwright, then npx playwright install
// chromium):
//
//   const { chromium } = require('playwright');
//   const browser = await chromium.launch({ headless: true });
//   // Persist storageState between runs so the device stays "remembered" and
//   // MFA is not re-challenged on every sync.
//   const ctx = await browser.newContext({ storageState: savedState });
//   const page = await ctx.newPage();
//   await page.goto(LOGIN_URL);
//   await page.fill('#username', creds.username);
//   await page.fill('#password', creds.password);
//   await page.click('button[type=submit]');
//   // ... handle the MFA challenge, navigate to the statements/export page,
//   //     download the QFX, then hand the bytes to parse-ofx.js:
//   //   const { parseOFXFile } = require('./parse-ofx');
//   //   return parseOFXFile(downloadedText);
//   await ctx.storageState({ path: STATE_PATH });
//
// Reusing parse-ofx.js for the downloaded file is the shortcut worth taking:
// scrape only as far as the export button, never the transaction table itself.

module.exports = {
  id: 'web',
  label: 'Web automation (not implemented)',
  description:
    'Drive the institution website in a headless browser. Ships disabled — see ' +
    'src/services/importers/web.js for the contract and a Playwright sketch.',
  capabilities: { sync: true, upload: false, needsCredentials: true },

  isConfigured() {
    return config.webAdapterEnabled;
  },

  configHint() {
    return config.webAdapterEnabled
      ? 'Enabled, but fetch() is still a stub — implement it in src/services/importers/web.js.'
      : 'Disabled. Implement fetch() in src/services/importers/web.js and set WEB_ADAPTER_ENABLED=true.';
  },

  async fetch(connection) {
    if (!config.webAdapterEnabled) {
      throw new Error('The web automation adapter is disabled (WEB_ADAPTER_ENABLED is not true).');
    }
    // Credentials are decrypted here so an implementation has them to hand.
    const creds = decryptJSON(connection.credentials_enc);
    void creds;

    throw new Error(
      'The web automation adapter has no implementation yet. Implement fetch() in ' +
      'src/services/importers/web.js, or use the Direct Connect (OFX) or statement ' +
      'upload adapters instead.'
    );
  },
};
