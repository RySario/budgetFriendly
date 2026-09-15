'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { config } = require('../config');
const { runImport, findOrCreateUploadConnection } = require('../services/importers');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

/** Upload an OFX / QFX / CSV statement. */
router.post('/', (req, res, next) => {
  upload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({
        error: uploadErr.code === 'LIMIT_FILE_SIZE'
          ? 'That file is larger than the upload limit.'
          : uploadErr.message,
      });
    }
    if (!req.file) return res.status(400).json({ error: 'Choose a statement file to upload.' });

    try {
      const connection = await findOrCreateUploadConnection();
      const result = await runImport(connection, { file: req.file });
      res.json({ result });
    } catch (err) {
      // The file itself was the problem (wrong format, unreadable); say why.
      res.status(400).json({ error: err.message });
    }
  });
});

router.get('/history', async (req, res, next) => {
  try {
    const runs = await db.many(
      `SELECT id, started_at, finished_at, status, imported, duplicates, message
         FROM sync_runs ORDER BY started_at DESC LIMIT 20`
    );
    res.json({ runs });
  } catch (err) { next(err); }
});

module.exports = router;
