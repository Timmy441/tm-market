const bcrypt = require('bcryptjs');

const { createToken, publicUser } = require('./authController');
const { findUserById, findUserByPhone, updateProfile, getPasswordHash, setPassword } = require('../models/userModel');
const { normalizeNigerianPhone } = require('../utils/phone');
const { isTrustedImageUrl, signUploadParams } = require('../utils/cloudinary');

const PHONE_EXISTS = 'This phone number is already registered.';

function text(value, { min = 0, max }) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v.length >= min && v.length <= max ? v : null;
}

const bad = (res, message) => res.status(400).json({ success: false, message });

// PUT /api/me/profile: only the fields that are sent are changed.
async function saveProfile(req, res) {
  try {
    const b = req.body || {};
    const f = {};

    if (b.name !== undefined || b.firstName !== undefined || b.lastName !== undefined) {
      let first = b.firstName, last = b.lastName;
      if ((!first || !last) && typeof b.name === 'string') {
        const parts = b.name.trim().split(/\s+/).filter(Boolean);
        first = parts[0];
        last = parts.slice(1).join(' ');
      }
      first = text(first, { min: 2, max: 100 });
      last = text(last, { min: 2, max: 100 });
      if (!first || !last) return bad(res, 'Please enter your first and last name.');
      f.firstName = first;
      f.lastName = last;
    }

    if (b.phone !== undefined) {
      const raw = typeof b.phone === 'string' ? b.phone.trim() : '';
      const current = await findUserById(req.user.id);
      if (!raw) {
        // The phone number identifies the account; once set it cannot be removed.
        if (current && current.phone_normalized) return bad(res, 'Your phone number cannot be removed. You can change it to another number.');
      } else {
        const normalized = normalizeNigerianPhone(raw);
        if (!normalized) return bad(res, 'Please enter a valid Nigerian phone number, e.g. 08012345678.');
        if (await findUserByPhone(normalized, req.user.id)) return res.status(409).json({ success: false, message: PHONE_EXISTS });
        f.phone = raw;
        f.phoneNormalized = normalized;
      }
    }

    for (const [key, max] of [['address', 500], ['location', 150], ['bio', 1000]]) {
      if (b[key] === undefined) continue;
      const v = text(b[key], { max });
      if (v === null) return bad(res, `${key[0].toUpperCase() + key.slice(1)} is too long.`);
      f[key] = v || null;
    }

    if (b.avatarUrl !== undefined) {
      if (b.avatarUrl === null || b.avatarUrl === '') f.avatarUrl = null;
      else if (isTrustedImageUrl(b.avatarUrl)) f.avatarUrl = b.avatarUrl;
      else return bad(res, 'That profile picture is not valid.');
    }

    const user = await updateProfile(req.user.id, f);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.status(200).json({ success: true, message: 'Profile updated', user: publicUser(user) });
  } catch (error) {
    // Two people saving the same number at once: the database constraint is the final guard.
    if (error.code === '23505') return res.status(409).json({ success: false, message: PHONE_EXISTS });
    console.error('Save profile error:', error);
    return res.status(500).json({ success: false, message: 'Unable to save your profile' });
  }
}

// POST /api/me/change-password
async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body || {};

    if (typeof currentPassword !== 'string' || !currentPassword) return bad(res, 'Please enter your current password.');
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 72) {
      return bad(res, 'New password must be between 8 and 72 characters long.');
    }
    if (newPassword === currentPassword) return bad(res, 'Your new password must be different from the current one.');

    const hash = await getPasswordHash(req.user.id);
    if (!hash || !(await bcrypt.compare(currentPassword, hash))) {
      return bad(res, 'Your current password is incorrect.');
    }

    await setPassword(req.user.id, await bcrypt.hash(newPassword, 12));

    // Every older session is now invalid; this device gets a fresh token so it stays signed in.
    const user = await findUserById(req.user.id);
    return res.status(200).json({
      success: true,
      message: 'Password changed. Other devices have been signed out.',
      token: createToken(user),
      user: publicUser(user)
    });
  } catch (error) {
    console.error('Change password error:', error);
    return res.status(500).json({ success: false, message: 'Unable to change your password' });
  }
}

// POST /api/me/uploads/sign (profile pictures)
function signAvatarUpload(req, res) {
  const signed = signUploadParams('tm-market/avatars');
  if (!signed) return res.status(503).json({ success: false, message: 'Image uploads are not available yet.' });
  return res.status(200).json({ success: true, ...signed });
}

module.exports = { saveProfile, changePassword, signAvatarUpload };
