// Emails about withdrawals. Never throws and never blocks the request: failures are only logged.
// Admin emails go to ADMIN_NOTIFY_EMAIL (the same Fly secret used for order alerts).
const { mailConfigured, sendMail } = require('./mailer');
const { adminGetWithdrawal } = require('../models/payoutModel');

const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const naira = n => '\u20A6' + Number(n).toLocaleString('en-NG');

function page(title, intro, lines, linkText, linkUrl) {
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px"><h2>${esc(title)}</h2><p>${esc(intro)}</p>` +
    `<table cellpadding="6" style="border-collapse:collapse;font-size:14px">${lines.map(l => `<tr><td style="color:#555">${esc(l[0])}</td><td><b>${esc(l[1])}</b></td></tr>`).join('')}</table>` +
    `<p><a href="${esc(linkUrl)}">${esc(linkText)}</a></p></div>`;
  const text = `${title}\n${intro}\n\n${lines.map(l => `${l[0]}: ${l[1]}`).join('\n')}\n\n${linkText}: ${linkUrl}`;
  return { html, text };
}

async function notifyAdminOfWithdrawal(withdrawalId) {
  try {
    const to = (process.env.ADMIN_NOTIFY_EMAIL || '').trim();
    if (!to || !mailConfigured()) return;
    const w = await adminGetWithdrawal(withdrawalId);
    if (!w) return;
    const adminUrl = process.env.ADMIN_URL || 'https://tm-market-admin.vercel.app';
    const { html, text } = page(
      'New withdrawal request',
      'A seller has asked to be paid. Check the details, pay them, then mark it as paid in the admin panel.',
      [['Store', w.store_name || '-'], ['Seller', `${w.first_name || ''} ${w.last_name || ''}`.trim() || w.seller_email],
       ['Amount', naira(w.amount)], ['Bank', w.bank_name], ['Account number', w.account_number], ['Account name', w.account_name]],
      'Open the admin panel', adminUrl
    );
    await sendMail({ to, subject: `Withdrawal request: ${naira(w.amount)} from ${w.store_name || 'a seller'}`, html, text });
  } catch (e) {
    console.error('Withdrawal alert failed:', e && e.message ? e.message : e);
  }
}

// Tells the seller their request was paid or rejected.
async function notifySellerOfSettlement(withdrawalId) {
  try {
    if (!mailConfigured()) return;
    const w = await adminGetWithdrawal(withdrawalId);
    const to = w && w.seller_email ? String(w.seller_email).trim() : '';
    if (!to || (w.status !== 'paid' && w.status !== 'rejected')) return;
    const siteUrl = process.env.SITE_URL || 'https://tm-market-pi.vercel.app';
    const paid = w.status === 'paid';
    const lines = [['Amount', naira(w.amount)], ['Bank', w.bank_name], ['Account', `******${String(w.account_number).slice(-4)}`]];
    if (paid && w.payment_reference) lines.push(['Reference', w.payment_reference]);
    if (!paid && w.admin_note) lines.push(['Reason', w.admin_note]);
    const { html, text } = page(
      paid ? 'Your withdrawal has been paid' : 'Your withdrawal request was not approved',
      paid ? 'We have sent the money to your bank account. Some banks take a little time to show it.' : 'The amount is back in your available balance. You can send a new request after fixing the issue below.',
      lines, 'Open TM Market', siteUrl
    );
    await sendMail({ to, subject: paid ? `Withdrawal paid: ${naira(w.amount)}` : `Withdrawal request not approved: ${naira(w.amount)}`, html, text });
  } catch (e) {
    console.error('Withdrawal email to seller failed:', e && e.message ? e.message : e);
  }
}

module.exports = { notifyAdminOfWithdrawal, notifySellerOfSettlement };
