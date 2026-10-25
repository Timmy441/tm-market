const express = require('express');

const c = require('../controllers/requestController');
const { authenticateToken, requireAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

// Same protection as every other admin route: valid login AND admin role confirmed in the database.
router.use(authenticateToken, requireAdmin);

router.get('/summary', c.adminSummary);
router.get('/', c.adminList);
router.get('/:id', c.adminDetail);
router.post('/:id/status', c.adminSetStatus);
router.delete('/:id', c.adminDelete);

module.exports = router;
