const express = require('express');

const c = require('../controllers/requestController');
const { authenticateToken } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/', c.publicRequests);                                   // approved requests, no customer details
router.get('/mine', authenticateToken, c.myRequests);
router.post('/uploads/sign', authenticateToken, c.signRequestUpload);
router.post('/', authenticateToken, c.submitRequest);

module.exports = router;
