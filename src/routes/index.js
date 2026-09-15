'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use('/auth', require('./auth'));

// Everything past this point requires a session.
router.use(requireAuth);

router.use('/dashboard', require('./dashboard'));
router.use('/import', require('./import'));
router.use('/accounts', require('./accounts'));
router.use('/transactions', require('./transactions'));
router.use('/categories', require('./categories'));
router.use('/budget', require('./budget'));
router.use('/cashflow', require('./cashflow'));
router.use('/recurring', require('./recurring'));
router.use('/goals', require('./goals'));
router.use('/settings', require('./settings'));

module.exports = router;
