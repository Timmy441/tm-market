const model = require('../models/refundModel');
const rules = require('../utils/payoutRules');
const { notifyOfRefund } = require('../utils/refundAlert');

const bad = (res, message, code = 400) => res.status(code).json({ success: false, message });
const parseId = v => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

// Money actions are written to the server log (visible with `fly logs`).
function log(action, who, extra) {
  console.log(JSON.stringify({ payout: true, at: new Date().toISOString(), action, by: who, ...extra }));
}

// POST /api/admin/orders/:id/refund { reference, note }
// The admin has ALREADY refunded the buyer in the Paystack dashboard. This only records it.
async function adminRefund(req, res) {
  try {
    const id = parseId(req.params.id);
    if (!id) return bad(res, 'Invalid order id');
    const b = req.body || {};

    const reference = typeof b.reference === 'string' ? b.reference.trim() : '';
    if (reference.length < 4 || reference.length > 120 || !/^[\w\-./ ]+$/.test(reference)) {
      return bad(res, 'Enter the Paystack refund reference (4 to 120 letters, numbers or - . / _).');
    }
    const note = typeof b.note === 'string' ? b.note.trim() : '';
    if (note.length < 3 || note.length > 200) return bad(res, 'Please give a short reason for the refund (3 to 200 characters).');

    const info = await model.getRefundInfo(id);
    if (!info) return bad(res, 'Order not found', 404);

    const result = await model.recordRefund(id, req.user.id, reference, note, rules.holdDays());
    if (result.status === 'not_found') return bad(res, 'Order not found', 404);
    if (result.status === 'not_paid') return bad(res, 'This order has no successful payment to refund.', 409);
    if (result.status === 'already_refunded') return bad(res, 'This order has already been refunded.', 409);
    if (result.status === 'duplicate_reference') return bad(res, 'This refund reference is already recorded on another order.', 409);
    if (result.status === 'already_withdrawn') {
      return bad(res, 'The seller has already withdrawn, or has asked to withdraw, money that includes this order, so the refund cannot be recorded here. Nothing was changed. Sort it out with the seller first.', 409);
    }
    if (result.status !== 'ok') return bad(res, 'Something went wrong', 500);

    log('order.refund', req.user.id, { orderId: id, orderNumber: result.orderNumber, amount: Number(info.amount), reference });
    notifyOfRefund(id);
    return res.json({ success: true, message: 'Refund recorded.' });
  } catch (e) {
    console.error('Admin refund error:', e);
    return bad(res, 'Something went wrong', 500);
  }
}

module.exports = { adminRefund };
