const express = require('express');

const c = require('../controllers/requestController');
const { authenticateToken, requireSeller } = require('../middleware/authMiddleware');

const router = express.Router();

// Approved requests are for TM Market sellers only. There is no public list.
router.get('/seller', authenticateToken, requireSeller, c.sellerRequests);
router.get('/mine', authenticateToken, c.myRequests);
router.post('/uploads/sign', authenticateToken, c.signRequestUpload);
router.post('/', authenticateToken, c.submitRequest);

module.exports = router;
