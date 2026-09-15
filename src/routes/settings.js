'use strict';
const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const counts = await db.one(
      `SELECT (SELECT COUNT(*)::int FROM transactions)                   AS transactions,
              (SELECT COUNT(*)::int FROM transactions WHERE needs_review) AS needs_review,
              (SELECT COUNT(*)::int FROM accounts)                       AS accounts,
              (SELECT COUNT(*)::int FROM categories)                     AS categories,
              (SELECT COUNT(*)::int FROM category_rules)                 AS rules,
              (SELECT COUNT(*)::int FROM category_rules WHERE auto)      AS learned_rules,
              (SELECT COUNT(*)::int FROM goals)                          AS goals`
    );
    res.json({ user: { email: req.user.email }, counts });
  } catch (err) { next(err); }
});

module.exports = router;
