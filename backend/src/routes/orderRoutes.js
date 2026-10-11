const express = require('express');

const c = require('../controllers/orderController');
const receipts = require('../controllers/receiptController');
const { authenticateToken } = require('../middleware/authMiddleware');

const router = express.Router();

// Every order route needs a valid login. The account is re-checked in the database on each call.
router.use(authenticateToken);

router.post('/', c.createOrder);
router.get('/me', c.myOrders);          // keep above '/:id'
router.get('/:id', c.getOrder);
router.get('/:id/receipt', receipts.buyerReceipt); // PDF payment receipt, buyer only
router.post('/:id/cancel', c.cancelOrder);
router.post('/:id/delivered', c.confirmDelivered); // buyer confirms the parcel arrived

module.exports = router;
