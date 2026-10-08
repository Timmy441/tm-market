const express = require('express');

const c = require('../controllers/sellerController');
const orders = require('../controllers/orderController');
const payouts = require('../controllers/payoutController');
const { authenticateToken, requireSeller } = require('../middleware/authMiddleware');

const router = express.Router();

// Any logged-in customer can open a store (this is what upgrades them to SELLER).
router.post('/', authenticateToken, c.becomeSeller);

// Everything below is SELLER-only, verified against the database.
router.get('/me', authenticateToken, requireSeller, c.getMySeller);
router.put('/me', authenticateToken, requireSeller, c.updateMySeller);
router.post('/me/uploads/sign', authenticateToken, requireSeller, c.signUpload);

router.get('/me/products', authenticateToken, requireSeller, c.getMyProducts);
router.post('/me/products', authenticateToken, requireSeller, c.createMyProduct);
router.put('/me/products/:id', authenticateToken, requireSeller, c.updateMyProduct);
router.delete('/me/products/:id', authenticateToken, requireSeller, c.deleteMyProduct);

// Paid orders for this seller's products (unpaid orders are never shown to sellers).
router.get('/me/orders', authenticateToken, requireSeller, orders.sellerOrders);
router.post('/me/orders/:id/status', authenticateToken, requireSeller, orders.sellerUpdateStatus);
router.put('/me/orders/:id/delivery-window', authenticateToken, requireSeller, orders.sellerSetDeliveryWindow);

// Earnings, bank details and withdrawals (the backend checks the seller role in the database).
router.get('/me/payouts', authenticateToken, requireSeller, payouts.myPayouts);
router.get('/me/bank/list', authenticateToken, requireSeller, payouts.bankList);
router.post('/me/bank/resolve', authenticateToken, requireSeller, payouts.resolveBank);
router.put('/me/bank', authenticateToken, requireSeller, payouts.saveMyBank);
router.post('/me/withdrawals', authenticateToken, requireSeller, payouts.requestMyWithdrawal);

module.exports = router;
