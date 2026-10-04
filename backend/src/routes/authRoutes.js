const express = require('express');

const {
    register,
    login,
    getMe
} = require('../controllers/authController');

const {
    authenticateToken
} = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.get('/me', authenticateToken, getMe);

const { saveProfile, changePassword, signAvatarUpload } = require('../controllers/profileController');

router.put('/me/profile', authenticateToken, saveProfile);
router.post('/me/change-password', authenticateToken, changePassword);
router.post('/me/uploads/sign', authenticateToken, signAvatarUpload);

const { forgotPassword, resetPassword } = require('../controllers/resetController');

router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

module.exports = router;