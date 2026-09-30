const jwt = require('jsonwebtoken');
const { getAuthState } = require('../models/sellerModel');

function authenticateToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Authentication token is required'
      });
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication token is required'
      });
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    req.user = {
      id: decoded.userId,
      role: decoded.role
    };

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Authentication token has expired'
      });
    }

    return res.status(401).json({
      success: false,
      message: 'Invalid authentication token'
    });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required'
    });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Admin access required'
    });
  }

  next();
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