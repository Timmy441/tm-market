const crypto = require('crypto');
const { parsePositiveInt } = require('./productController');
const {
  findOrderForPayment,
  savePendingPayment,
  confirmPayment
} = require('../models/paymentModel');
const { notifyAdminOfOrder, notifySellerOfOrder } = require('../utils/adminAlert');
const {
  paymentsStatus,
  initializeTransaction,
  verifyTransaction,
  verifySignature
} = require('../utils/paystack');

function paymentsDisabledResponse(res) {
  const status = paymentsStatus();
  if (status === 'ok') return null;
  if (status === 'missing') {
    return res.status(503).json({ success: false, message: 'Payments are not configured yet.' });
  }
  return res.status(503).json({ success: false, message: 'Live payments are blocked until enabled by admin.' });
}

function siteOrigin() {
  const raw = process.env.SITE_URL || 'https://tm-market-pi.vercel.app';
  try { return new URL(raw).origin; } catch (e) { return 'https://tm-market-pi.vercel.app'; }
}

// Only allow Paystack to send the buyer back to our own site.
// Anything else (another domain, odd scheme, too long) is replaced with a safe default.
function safeCallbackUrl(candidate, orderId) {
  const origin = siteOrigin();
  const fallback = `${origin}/homepage.html?payreturn=1&orderId=${encodeURIComponent(orderId)}`;
  if (typeof candidate !== 'string' || !candidate || candidate.length > 500) return fallback;
  try {
    const u = new URL(candidate);
    if (u.origin !== origin || u.username || u.password) return fallback;
    return u.toString();
  } catch (e) {
    return fallback;
  }
}

// Outcomes that should email the admin. confirmPayment returns each of these only once per order,
// so the webhook and the buyer's return page cannot both send an email.
const ALERT_OUTCOMES = ['paid', 'paid_but_cancelled', 'oversold'];

function makeReference(orderId) {
  const salt = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `TM-${orderId}-${Date.now()}-${salt}`;
}

function normalizeOutcome(outcome) {
  switch (outcome) {
    case 'paid':
      return { ok: true, code: 200, message: 'Payment confirmed. Your order is now confirmed.' };
    case 'already_paid':
      return { ok: true, code: 200, message: 'This order is already paid.' };
    case 'duplicate_payment':
      return { ok: false, code: 409, message: 'This order was already paid with another transaction.' };
    case 'amount_mismatch':
      return { ok: false, code: 409, message: 'Payment amount mismatch. Please contact support.' };
    case 'no_payment_record':
      return { ok: false, code: 409, message: 'Payment was not initialized for this order.' };
    case 'paid_but_cancelled':
      return { ok: false, code: 409, message: 'Payment was received after cancellation. Support has been notified.' };
    case 'oversold':
      return { ok: false, code: 409, message: 'Payment succeeded but stock changed. Support has been notified.' };
    case 'already_refunded':
      return { ok: false, code: 409, message: 'This payment has been refunded.' };
    case 'unexpected_status':
      return { ok: false, code: 409, message: 'This order cannot be confirmed from its current status.' };
    default:
      return { ok: false, code: 404, message: 'Order not found.' };
  }
}

async function initializePaystackPayment(req, res) {
  try {
    if (paymentsDisabledResponse(res)) return;

    const orderId = parsePositiveInt(req.body && req.body.orderId);
    if (!orderId) return res.status(400).json({ success: false, message: 'A valid orderId is required.' });

    const order = await findOrderForPayment(orderId, req.user.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'pending') {
      return res.status(409).json({ success: false, message: 'Only unpaid orders can be paid.' });
    }

    const total = Number(order.total);
    const amount = Math.round(total * 100);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(409).json({ success: false, message: 'This order cannot be paid right now.' });
    }

    const reference = makeReference(orderId);
    const callbackUrl = typeof (req.body && req.body.callbackUrl) === 'string'
      ? req.body.callbackUrl.trim()
      : '';

    const payload = {
      email: order.email,
      amount,
      reference,
      currency: 'NGN',
      metadata: {
        orderId: order.id,
        orderNumber: order.order_number,
        userId: req.user.id
      }
    };

    payload.callback_url = safeCallbackUrl(callbackUrl, order.id);

    const tx = await initializeTransaction(payload);
    const saved = await savePendingPayment(order.id, reference, total);

    if (!saved) {
      return res.status(409).json({ success: false, message: 'This order is already paid.' });
    }

    return res.status(200).json({
      success: true,
      message: 'Payment initialized.',
      payment: {
        orderId: Number(order.id),
        orderNumber: order.order_number,
        reference,
        authorizationUrl: tx.authorization_url,
        accessCode: tx.access_code
      }
    });
  } catch (error) {
    console.error('Initialize payment error:', error);
    return res.status(502).json({ success: false, message: 'Unable to start payment at the moment.' });
  }
}

async function verifyPaystackPayment(req, res) {
  try {
    if (paymentsDisabledResponse(res)) return;

    const q = req.query || {};
    const b = req.body || {};
    const orderId = parsePositiveInt(q.orderId || b.orderId);
    const reference = typeof (q.reference || b.reference) === 'string'
      ? String(q.reference || b.reference).trim()
      : '';

    if (!orderId || !reference) {
      return res.status(400).json({ success: false, message: 'orderId and reference are required.' });
    }

    const order = await findOrderForPayment(orderId, req.user.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const tx = await verifyTransaction(reference);
    if (!tx || tx.status !== 'success') {
      return res.status(409).json({ success: false, message: 'Payment is not successful yet.' });
    }

    const result = await confirmPayment(order.id, reference, Number(tx.amount), tx.currency);
    const mapped = normalizeOutcome(result.outcome);
    if (ALERT_OUTCOMES.includes(result.outcome)) { notifyAdminOfOrder(order.id, result.outcome); notifySellerOfOrder(order.id, result.outcome); }

    return res.status(mapped.code).json({
      success: mapped.ok,
      message: mapped.message,
      outcome: result.outcome,
      orderNumber: result.orderNumber || order.order_number
    });
  } catch (error) {
    console.error('Verify payment error:', error);
    return res.status(502).json({ success: false, message: 'Unable to verify payment right now.' });
  }
}

async function paystackWebhook(req, res) {
  try {
    const signature = req.headers['x-paystack-signature'];
    const rawBody = req.body;

    if (!verifySignature(rawBody, signature)) {
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    const event = JSON.parse(rawBody.toString('utf8'));

    if (event.event !== 'charge.success') {
      return res.status(200).json({ success: true });
    }

    const data = event.data || {};
    const metadata = data.metadata || {};
    const orderId = parsePositiveInt(metadata.orderId || metadata.order_id);
    const reference = typeof data.reference === 'string' ? data.reference : '';

    if (!orderId || !reference) {
      return res.status(200).json({ success: true });
    }

    const result = await confirmPayment(orderId, reference, Number(data.amount), data.currency);
    if (ALERT_OUTCOMES.includes(result.outcome)) { notifyAdminOfOrder(orderId, result.outcome); notifySellerOfOrder(orderId, result.outcome); }
    if (result.outcome !== 'paid' && result.outcome !== 'already_paid') {
      console.warn('Webhook payment outcome:', result.outcome, result.orderNumber || orderId);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Paystack webhook error:', error);
    return res.status(500).json({ success: false, message: 'Webhook processing failed' });
  }
}

module.exports = {
  initializePaystackPayment,
  verifyPaystackPayment,
  paystackWebhook
};