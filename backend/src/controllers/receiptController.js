const { getReceiptData } = require('../models/receiptModel');
const { buildReceiptPdf } = require('../utils/receiptPdf');
const { SUPPORT } = require('../utils/chatFaq');

function parsePositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// A receipt exists only once the money was really received (or was received and later refunded).
const RECEIPT_PAYMENT_STATUSES = ['successful', 'refunded'];

function toReceipt(row) {
  const buyerName = `${row.first_name || ''} ${row.last_name || ''}`.trim() || row.shipping_name;
  const paid = row.payment_amount !== null && row.payment_amount !== undefined ? row.payment_amount : row.total;
  return {
    orderNumber: row.order_number,
    refunded: row.payment_status === 'refunded',
    paidAt: row.paid_at,
    reference: row.transaction_reference,
    method: String(row.provider || '').toLowerCase() === 'paystack' ? 'Online payment (Paystack)' : 'Online payment',
    buyer: { name: buyerName, email: row.email },
    seller: row.seller_name || 'TM Market seller',
    shipTo: {
      name: row.shipping_name, phone: row.shipping_phone, address: row.shipping_address,
      city: row.shipping_city, state: row.shipping_state, country: row.shipping_country
    },
    items: (row.items || []).map(i => ({
      name: i.product_name, quantity: i.quantity, unitPrice: Number(i.unit_price), totalPrice: Number(i.total_price)
    })),
    subtotal: Number(row.subtotal),
    shippingFee: Number(row.shipping_fee),
    discount: Number(row.discount),
    total: Number(paid),
    supportEmail: SUPPORT.emails[0],
    siteUrl: process.env.SITE_URL || 'https://tm-market-pi.vercel.app'
  };
}

// The order number is already safe, but the file name is cleaned anyway.
function fileName(orderNumber) {
  const safe = String(orderNumber || '').replace(/[^A-Za-z0-9_-]/g, '');
  return `TM-Receipt-${safe || 'order'}.pdf`;
}

// ownerOnly = true for buyers (only their own order); false for admins (any order).
function sendReceipt(ownerOnly) {
  return async function (req, res) {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(404).json({ success: false, message: 'Order not found' });

      const row = await getReceiptData(id);
      // Someone else's order gets exactly the same answer as a missing one.
      if (!row || (ownerOnly && Number(row.user_id) !== Number(req.user.id))) {
        return res.status(404).json({ success: false, message: 'Order not found' });
      }
      if (!RECEIPT_PAYMENT_STATUSES.includes(row.payment_status)) {
        return res.status(409).json({ success: false, message: 'A receipt is available once your payment has been confirmed.' });
      }

      const pdf = buildReceiptPdf(toReceipt(row));
      res.status(200);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName(row.order_number)}"`);
      res.setHeader('Content-Length', String(pdf.length));
      res.setHeader('Cache-Control', 'private, no-store');
      return res.end(pdf);
    } catch (error) {
      console.error('Receipt error:', error);
      return res.status(500).json({ success: false, message: 'Unable to create your receipt' });
    }
  };
}

module.exports = { buyerReceipt: sendReceipt(true), adminReceipt: sendReceipt(false), toReceipt, fileName };
