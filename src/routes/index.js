'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use('/auth', require('./auth'));

// Everything past this point requires a session.
router.use(requireAuth);

router.use('/connections', require('./connections'));
router.use('/transactions', require('./transactions'));
router.use('/categories', require('./categories'));
router.use('/subscriptions', require('./subscriptions'));
router.use('/income', require('./income'));
router.use('/goals', require('./goals'));
router.use('/budget', require('./budget'));
router.use('/settings', require('./settings'));

module.exports = router;
