'use strict';
const { renormaliseMerchants, categorizeAll } = require('../../services/detect/categorize');
const { runDetection } = require('../../services/detect');

// Detection results are stored, and until now only an upload refreshed them.
// Statements imported before the Golden 1 description and variable-paycheck
// fixes kept their old merchant keys and never had a paycheck found. Bring
// every existing row up to the current normalisation, rules and detection —
// the same pass an upload runs.

async function up(q) {
  await renormaliseMerchants(q);
  await categorizeAll({}, q);
  await runDetection(q);
}

module.exports = { up };
