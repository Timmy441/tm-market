const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const { findUserByEmail } = require('../models/userModel');
const { createResetToken, requestedRecently, consumeResetToken } = require('../models/resetModel');
const { mailConfigured, sendMail } = require('../utils/mailer');

const EXPIRY_MINUTES = 30;
const COOLDOWN_SECONDS = 60;
const SAME_ANSWER = 'If an account exists for that email, we have sent a password reset link. It expires in 30 minutes.';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
const escapeHtml = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The link base comes from configuration, never from the request (prevents host-header tricks).
function siteUrl() {
  return (process.env.SITE_URL || 'https://tm-market-pi.vercel.app').replace(/\/+$/, '');
}

async function sendResetEmail(user, token) {
  // The token travels in the #fragment so it is never sent to a server or written to access logs.
  const link = `${siteUrl()}/index.html#reset=${token}`;
  const name = escapeHtml(user.first_name || 'there');
  await sendMail({
    to: user.email,
    name: `${user.first_name} ${user.last_name}`.trim(),
    subject: 'Reset your TM Market password',
    text: `Hi ${user.first_name || 'there'},\n\nUse this link to choose a new password (valid for ${EXPIRY_MINUTES} minutes):\n${link}\n\nIf you did not ask for this, ignore this email. Your password will not change.`,
    html: `<p>Hi ${name},</p><p>Use the button below to choose a new password. The link is valid for ${EXPIRY_MINUTES} minutes and works once.</p>
<p><a href="${link}" style="display:inline-block;padding:12px 22px;background:#7c3aed;color:#fff;border-radius:10px;text-decoration:none;font-weight:bold">Reset password</a></p>
<p>If the button does not work, copy this link into your browser:<br>${link}</p>
<p>If you did not ask for this, ignore this email. Your password will not change.</p>`
  });
}

// POST /api/forgot-password  { email }
async function forgotPassword(req, res) {
  try {
    if (!mailConfigured()) {
      // A server-wide setting, not specific to any email address, so it reveals nothing about accounts.
      return res.status(503).json({ success: false, message: 'Password reset by email is not available yet. Please contact support.' });
    }

    const email = req.body && typeof req.body.email === 'string' ? req.body.email.trim() : '';
    if (!email || email.length > 255 || !EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }

    // Same answer whether or not the account exists, and sent BEFORE any work, so timing reveals nothing.
    res.status(200).json({ success: true, message: SAME_ANSWER });

    const user = await findUserByEmail(email.toLowerCase());
    if (!user || !user.is_active) return;
    if (await requestedRecently(user.id, COOLDOWN_SECONDS)) return;

    const token = crypto.randomBytes(32).toString('hex');
    await createResetToken(user.id, sha256(token), EXPIRY_MINUTES);
    await sendResetEmail(user, token);
  } catch (error) {
    console.error('Forgot password error:', error.message);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Unable to process your request' });
  }
}

// POST /api/reset-password  { token, newPassword }
async function resetPassword(req, res) {
  try {
    const { token, newPassword } = req.body || {};

    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
      return res.status(400).json({ success: false, message: 'This reset link is invalid or has expired.' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 72) {
      return res.status(400).json({ success: false, message: 'New password must be between 8 and 72 characters long.' });
    }

    const userId = await consumeResetToken(sha256(token), await bcrypt.hash(newPassword, 12));
    if (!userId) {
      return res.status(400).json({ success: false, message: 'This reset link is invalid or has expired. Please request a new one.' });
    }

    // Every existing session was signed out by the password change; the person logs in fresh.
    return res.status(200).json({ success: true, message: 'Your password has been updated. Please log in.' });
  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({ success: false, message: 'Unable to reset your password' });
  }
}

module.exports = { forgotPassword, resetPassword };
