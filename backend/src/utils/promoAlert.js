// Emails the admin when a seller pays for a promotion (same ADMIN_NOTIFY_EMAIL and Brevo setup as order alerts).
// Never throws and never slows payment confirmation: failures are only logged.
const { mailConfigured, sendMail } = require('./mailer');
const { getPromotionAlertInfo } = require('../models/promotionModel');

const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const naira = n => '\u20A6' + Number(n).toLocaleString('en-NG');
const day = d => (d ? new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : '-');

async function notifyAdminOfPromotion(id) {
  try {
    const to = (process.env.ADMIN_NOTIFY_EMAIL || '').trim();
    if (!to || !mailConfigured()) return;
    const p = await getPromotionAlertInfo(id);
    if (!p) return;

    const adminUrl = process.env.ADMIN_URL || 'https://tm-market-admin.vercel.app';
    const lines = [
      ['Product', p.product_name || '-'], ['Store', p.seller_name || '-'], ['Seller email', p.seller_email || '-'],
      ['Plan', `${p.plan_days} days`], ['Paid', naira(p.amount)], ['Starts', day(p.starts_at)], ['Ends', day(p.ends_at)]
    ];
    const head = 'A seller paid for a promotion';
    const html = `<div style="font-family:Arial,sans-serif;max-width:520px"><h2>${esc(head)}</h2>` +
      `<table cellpadding="6" style="border-collapse:collapse;font-size:14px">${lines.map(l => `<tr><td style="color:#555">${esc(l[0])}</td><td><b>${esc(l[1])}</b></td></tr>`).join('')}</table>` +
      `<p><a href="${esc(adminUrl)}">Open the admin panel (Promotions tab)</a></p></div>`;
    const text = `${head}\n\n${lines.map(l => `${l[0]}: ${l[1]}`).join('\n')}\n\nAdmin panel: ${adminUrl}`;
    await sendMail({ to, subject: `New promotion: ${p.product_name || 'listing'} (${naira(p.amount)})`, html, text });
  } catch (e) {
    console.error('Promotion alert failed:', e && e.message ? e.message : e);
  }
}

module.exports = { notifyAdminOfPromotion };
