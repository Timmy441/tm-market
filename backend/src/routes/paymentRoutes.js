const express = require('express');

const c = require('../controllers/paymentController');
const { authenticateToken } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(authenticateToken);
router.post('/initialize', c.initializePaystackPayment);
router.get('/verify', c.verifyPaystackPayment);

module.exports = router;