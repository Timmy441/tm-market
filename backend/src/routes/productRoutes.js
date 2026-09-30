const express = require('express');

const {
  getProducts,
  getProduct,
  getProductContact,
  createNewProduct,
  updateExistingProduct,
  removeProduct
} = require('../controllers/productController');

const {
  authenticateToken,
  requireAdmin
} = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/', getProducts);
router.get('/:id', getProduct);
// Seller contact is only shown to logged-in users.
router.get('/:id/contact', authenticateToken, getProductContact);

router.post('/', authenticateToken, requireAdmin, createNewProduct);
router.put('/:id', authenticateToken, requireAdmin, updateExistingProduct);
router.delete('/:id', authenticateToken, requireAdmin, removeProduct);

module.exports = router;