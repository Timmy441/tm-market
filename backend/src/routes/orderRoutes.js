const express = require('express');

const c = require('../controllers/orderController');
const { authenticateToken } = require('../middleware/authMiddleware');

const router = express.Router();

// Every order route needs a valid login. The account is re-checked in the database on each call.
router.use(authenticateToken);

router.post('/', c.createOrder);
router.get('/me', c.myOrders);          // keep above '/:id'
router.get('/:id', c.getOrder);
router.post('/:id/cancel', c.cancelOrder);

module.exports = router;
