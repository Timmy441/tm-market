const express = require('express');

const { start, message } = require('../controllers/chatController');
const { authenticateToken } = require('../middleware/authMiddleware');

const router = express.Router();

// The chat works for everyone. A valid login only unlocks the person's OWN order status.
// An expired, wrong or missing token never blocks the chat: the visitor is simply treated as logged out.
function optionalAuth(req, res, next) {
  if (!req.headers.authorization) return next();

  let done = false;
  const proceed = () => { if (!done) { done = true; next(); } };
  const quiet = { status() { return quiet; }, json() { proceed(); return quiet; } };

  authenticateToken(req, quiet, proceed);
}

router.get('/start', start);
router.post('/', optionalAuth, message);

module.exports = router;
