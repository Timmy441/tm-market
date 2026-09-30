const express = require('express');

const c = require('../controllers/sellerController');
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

module.exports = router;
