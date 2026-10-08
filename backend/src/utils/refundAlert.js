// Emails after a refund is recorded: one to the buyer, one to the seller. Never throws and never blocks the request.
const { mailConfigured, sendMail } = require('./mailer');
const { getRefundInfo } = require('../models/refundModel');

const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const naira = n => '\u20A6' + Number(n).toLocaleString('en-NG');

function page(title, intro, lines, linkText, linkUrl) {
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px"><h2>${esc(title)}</h2><p>${esc(intro)}</p>` +
    `<table cellpadding="6" style="border-collapse:collapse;font-size:14px">${lines.map(l => `<tr><td style="color:#555">${esc(l[0])}</td><td><b>${esc(l[1])}</b></td></tr>`).join('')}</table>` +
    `<p><a href="${esc(linkUrl)}">${esc(linkText)}</a></p></div>`;
  const text = `${title}\n${intro}\n\n${lines.map(l => `${l[0]}: ${l[1]}`).join('\n')}\n\n${linkText}: ${linkUrl}`;
  return { html, text };
}

async function notifyOfRefund(orderId) {
  try {
    if (!mailConfigured()) return;
    const info = await getRefundInfo(orderId);
    if (!info || info.payment_status !== 'refunded') return;
    const siteUrl = process.env.SITE_URL || 'https://tm-market-pi.vercel.app';
    const lines = [['Order', info.order_number], ['Amount', naira(info.amount)]];

    const buyer = info.buyer_email ? String(info.buyer_email).trim() : '';
    if (buyer) {
      try {
        const { html, text } = page(
          'Your refund has been sent',
          'TM Market has refunded this order to the card or account you paid with. Banks can take several days to show a refund.',
          lines, 'Open TM Market', siteUrl
        );
        await sendMail({ to: buyer, subject: `Refund sent for order ${info.order_number}`, html, text });
      } catch (e) { console.error('Refund email to buyer failed:', e && e.message ? e.message : e); }
    }

    const seller = info.seller_email ? String(info.seller_email).trim() : '';
    if (seller) {
      try {
        const { html, text } = page(
          'An order was refunded',
          'This order was refunded to the buyer, so it no longer counts towards your earnings. If you have questions, contact TM Market support.',
          lines, 'Open TM Market', siteUrl
        );
        await sendMail({ to: seller, subject: `Order ${info.order_number} was refunded`, html, text });
      } catch (e) { console.error('Refund email to seller failed:', e && e.message ? e.message : e); }
    }
  } catch (e) {
    console.error('Refund email failed:', e && e.message ? e.message : e);
  }
}

module.exports = { notifyOfRefund };
