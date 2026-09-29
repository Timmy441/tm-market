const express = require('express');

const {
  getProducts,
  getProduct,
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

router.post('/', authenticateToken, requireAdmin, createNewProduct);
router.put('/:id', authenticateToken, requireAdmin, updateExistingProduct);
router.delete('/:id', authenticateToken, requireAdmin, removeProduct);

module.exports = router;