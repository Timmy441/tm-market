// Emails the admin when an order is paid (or paid but needs a manual refund).
// Never throws and never slows payment confirmation: failures are only logged.
// Needs the Fly secret ADMIN_NOTIFY_EMAIL (plus the Brevo secrets already set). If it is missing, nothing is sent.
const { mailConfigured, sendMail } = require('./mailer');
const { getOrderAlertInfo } = require('../models/paymentModel');

const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const naira = n => '\u20A6' + Number(n).toLocaleString('en-NG');

const HEADLINES = {
  paid: ['New paid order', 'Payment received. Please attend to this customer.'],
  paid_but_cancelled: ['ACTION NEEDED: paid but cancelled', 'Money was received for an order that was already cancelled. Check it and refund in the Paystack dashboard if needed.'],
  oversold: ['ACTION NEEDED: paid but out of stock', 'Money was received but the item sold out first, so the order was cancelled. Refund the buyer in the Paystack dashboard.']
};

async function notifyAdminOfOrder(orderId, outcome) {
  try {
    const to = (process.env.ADMIN_NOTIFY_EMAIL || '').trim();
    const head = HEADLINES[outcome];
    if (!to || !head || !mailConfigured()) return;

    const o = await getOrderAlertInfo(orderId);
    if (!o) return;

    const items = Array.isArray(o.items) ? o.items : [];
    const buyer = `${o.buyer_first_name || ''} ${o.buyer_last_name || ''}`.trim() || o.buyer_email || 'Unknown buyer';
    const where = [o.shipping_address, o.shipping_city, o.shipping_state].filter(Boolean).join(', ');
    const itemText = items.map(i => `${i.quantity} x ${i.name}`).join('; ') || '(no items found)';
    const adminUrl = process.env.ADMIN_URL || 'https://tm-market-admin.vercel.app';

    const lines = [
      ['Order', o.order_number], ['Total', naira(o.total)], ['Items', itemText], ['Store', o.seller_name || '-'],
      ['Buyer', buyer], ['Buyer email', o.buyer_email || '-'], ['Deliver to', o.shipping_name || '-'],
      ['Phone', o.shipping_phone || '-'], ['Address', where || '-']
    ];
    const html = `<div style="font-family:Arial,sans-serif;max-width:520px"><h2>${esc(head[0])}</h2><p>${esc(head[1])}</p>` +
      `<table cellpadding="6" style="border-collapse:collapse;font-size:14px">${lines.map(l => `<tr><td style="color:#555">${esc(l[0])}</td><td><b>${esc(l[1])}</b></td></tr>`).join('')}</table>` +
      `<p><a href="${esc(adminUrl)}">Open the admin panel</a></p></div>`;
    const text = `${head[0]}\n${head[1]}\n\n${lines.map(l => `${l[0]}: ${l[1]}`).join('\n')}\n\nAdmin panel: ${adminUrl}`;

    await sendMail({ to, subject: `${head[0]}: ${o.order_number} (${naira(o.total)})`, html, text });
  } catch (e) {
    console.error('Admin order alert failed:', e && e.message ? e.message : e);
  }
}

const dayText = d => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; };

// Tells the seller their item was paid for, so they can prepare it. Sent only for normal paid orders.
// It does not say the seller has been paid: seller payouts are handled separately by TM Market.
async function notifySellerOfOrder(orderId, outcome) {
  try {
    if (outcome !== 'paid' || !mailConfigured()) return;
    const o = await getOrderAlertInfo(orderId);
    const to = o && o.seller_email ? String(o.seller_email).trim() : '';
    if (!to || to.toLowerCase() === (process.env.ADMIN_NOTIFY_EMAIL || '').trim().toLowerCase()) return;

    const items = Array.isArray(o.items) ? o.items : [];
    const where = [o.shipping_address, o.shipping_city, o.shipping_state].filter(Boolean).join(', ');
    const from = dayText(o.delivery_window_start), end = dayText(o.delivery_window_end);
    const dates = from && end ? (from === end ? from : `${from} to ${end}`) : 'Not set yet';
    const siteUrl = process.env.SITE_URL || 'https://tm-market-pi.vercel.app';

    const lines = [
      ['Order', o.order_number], ['Items', items.map(i => `${i.quantity} x ${i.name}`).join('; ') || '-'],
      ['Order total', naira(o.total)], ['Deliver to', o.shipping_name || '-'], ['Phone', o.shipping_phone || '-'],
      ['Address', where || '-'], ['Delivery dates', dates]
    ];
    const intro = 'A customer has paid for an item from your store on TM Market. Please prepare it for delivery and update the order status in your seller dashboard.';
    const html = `<div style="font-family:Arial,sans-serif;max-width:520px"><h2>You have a new paid order</h2><p>${esc(intro)}</p>` +
      `<table cellpadding="6" style="border-collapse:collapse;font-size:14px">${lines.map(l => `<tr><td style="color:#555">${esc(l[0])}</td><td><b>${esc(l[1])}</b></td></tr>`).join('')}</table>` +
      `<p><a href="${esc(siteUrl)}">Open TM Market</a></p></div>`;
    const text = `You have a new paid order\n${intro}\n\n${lines.map(l => `${l[0]}: ${l[1]}`).join('\n')}\n\nTM Market: ${siteUrl}`;

    await sendMail({ to, name: o.seller_name || undefined, subject: `New paid order for your store: ${o.order_number}`, html, text });
  } catch (e) {
    console.error('Seller order email failed:', e && e.message ? e.message : e);
  }
}

module.exports = { notifyAdminOfOrder, notifySellerOfOrder };
