const express = require('express');

const c = require('../controllers/reviewController');
const { authenticateToken } = require('../middleware/authMiddleware');

const router = express.Router();

// Anyone can read a product's reviews. Writing needs a login (and a delivered order).
router.get('/product/:id', c.getProductReviews);
router.get('/mine', authenticateToken, c.myReviews);
router.post('/', authenticateToken, c.submitReview);

module.exports = router;
