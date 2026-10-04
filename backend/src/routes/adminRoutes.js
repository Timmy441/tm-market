const express = require('express');

const c = require('../controllers/adminController');
const { authenticateToken, requireAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

// Every admin route needs a valid login AND an admin role confirmed in the database.
router.use(authenticateToken, requireAdmin);

router.get('/me', c.me);
router.get('/stats', c.stats);
router.get('/stats/timeseries', c.timeseries);

router.get('/users', c.users);
router.get('/users/:id', c.userDetail);
router.post('/users/:id/suspend', c.suspendUser);
router.post('/users/:id/reactivate', c.reactivateUser);

router.get('/products', c.products);
router.get('/products/:id', c.productDetail);
router.patch('/products/:id/status', c.changeProductStatus);

router.get('/orders', c.orders);
router.get('/orders/:id', c.orderDetail);
router.post('/orders/:id/status', c.changeOrderStatus);
router.put('/orders/:id/delivery-window', c.changeOrderWindow);

module.exports = router;
