'use strict';
const { parseTransactionCSV } = require('./parse-csv');
const { parseOFXFile } = require('./parse-ofx');

// File adapter: you download a statement from Golden 1's online banking (CSV,
// QFX or OFX) and upload it here. No credentials are stored, nothing logs in on
// your behalf, and it works regardless of what the bank's website does next.
//
// The upload route hands the file through in options.file.

function sniffFormat(filename, text) {
  const name = String(filename || '').toLowerCase();
  if (/<OFX>/i.test(text) || name.endsWith('.ofx') || name.endsWith('.qfx')) return 'ofx';
  if (name.endsWith('.csv') || name.endsWith('.txt')) return 'csv';
  // Fall back to content: a comma-heavy first line is a CSV.
  const firstLine = text.split('\n')[0] || '';
  return firstLine.split(',').length >= 3 ? 'csv' : 'ofx';
}

module.exports = {
  id: 'file',
  label: 'Statement upload (CSV / QFX / OFX)',
  description:
    'Download a statement from Golden 1 online banking and upload it. ' +
    'Nothing is stored on your behalf and no login happens here.',
  capabilities: { sync: false, upload: true, needsCredentials: false },

  isConfigured() { return true; },

  async fetch(connection, options = {}) {
    const file = options.file;
    if (!file || !file.buffer) {
      throw new Error('No file was uploaded.');
    }
    const text = file.buffer.toString('utf8');
    const format = sniffFormat(file.originalname, text);

    if (format === 'ofx') {
      return parseOFXFile(text);
    }

    // A CSV carries no account identity, so everything lands in one account per
    // connection — named after the connection so multiple uploads merge.
    const externalId = `csv-${connection.id}`;
    const { transactions, warnings } = parseTransactionCSV(text, { accountExternalId: externalId });

    if (!transactions.length) {
      throw new Error(warnings.join(' ') || 'No transactions found in the CSV.');
    }

    return {
      accounts: [{
        externalId,
        name: connection.name || 'Uploaded statements',
        type: 'depository',
        subtype: 'checking',
      }],
      transactions,
      warnings,
    };
  },
};
