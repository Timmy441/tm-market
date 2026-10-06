const jwt = require('jsonwebtoken');
const { getAuthState } = require('../models/sellerModel');

// Verifies the JWT, then re-checks the account in the DATABASE on every request:
// a deleted or suspended account is refused immediately, even with an unexpired token,
// and req.user.role is the role stored in the database (never the one inside the token).
async function authenticateToken(req, res, next) {
  let decoded;

  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Authentication token is required' });
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ success: false, message: 'Authentication token is required' });
    }

    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Authentication token has expired' });
    }

    return res.status(401).json({ success: false, message: 'Invalid authentication token' });
  }

  try {
    const state = await getAuthState(decoded.userId);

    if (!state) {
      return res.status(401).json({ success: false, message: 'Invalid authentication token' });
    }

    if (!state.is_active) {
      return res.status(403).json({ success: false, message: 'This account is inactive' });
    }

    // A password change/reset signs out every older session.
    if (state.password_changed_at && decoded.iat < Math.floor(new Date(state.password_changed_at).getTime() / 1000)) {
      return res.status(401).json({ success: false, message: 'Your password was changed. Please log in again.' });
    }

    req.user = { id: decoded.userId, role: state.role };
    return next();
  } catch (error) {
    console.error('Auth check error:', error);
    return res.status(500).json({ success: false, message: 'Unable to verify account' });
  }
}

// Admin access is decided by the DATABASE on every call. A forged, stale, demoted
// or suspended account is rejected no matter what the token says.
async function requireAdmin(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const state = await getAuthState(req.user.id);

    if (!state || !state.is_active) {
      return res.status(403).json({ success: false, message: 'This account is inactive' });
    }

    if (state.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    req.user.role = state.role;
    return next();
  } catch (error) {
    console.error('Admin check error:', error);
    return res.status(500).json({ success: false, message: 'Unable to verify account' });
  }
}

// The role is re-read from the database on every call, so a stale token
// (or a suspended / demoted account) cannot be used to reach seller features.
async function requireSeller(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const state = await getAuthState(req.user.id);

    if (!state || !state.is_active) {
      return res.status(403).json({ success: false, message: 'This account is inactive' });
    }

    if (state.role !== 'seller') {
      return res.status(403).json({ success: false, message: 'A seller profile is required' });
    }

    req.user.role = state.role;
    next();
  } catch (error) {
    console.error('Seller check error:', error);
    return res.status(500).json({ success: false, message: 'Unable to verify account' });
  }
}

module.exports = {
  authenticateToken,
  requireAdmin,
  requireSeller
};