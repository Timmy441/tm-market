// Sends transactional email through Brevo's HTTPS API (no extra libraries).
// Keys live in Fly secrets only: BREVO_API_KEY, MAIL_FROM_EMAIL (a sender verified in Brevo), MAIL_FROM_NAME.
const API_URL = 'https://api.brevo.com/v3/smtp/email';

function mailConfigured() {
  return !!(process.env.BREVO_API_KEY && process.env.MAIL_FROM_EMAIL);
}

async function sendMail({ to, name, subject, html, text }) {
  if (!mailConfigured()) throw new Error('Email is not configured');

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY.trim(), 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: process.env.MAIL_FROM_NAME || 'TM Market', email: process.env.MAIL_FROM_EMAIL.trim() },
      to: [{ email: to, name: name || undefined }],
      subject,
      htmlContent: html,
      textContent: text
    })
  });

  if (!res.ok) {
    const err = new Error(`Email provider rejected the message (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
}

module.exports = { mailConfigured, sendMail };
