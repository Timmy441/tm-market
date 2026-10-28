const crypto = require('crypto');
const { parsePositiveInt } = require('./productController');
const {
  findPromotableProduct, findBlockingPromotion, createPendingPromotion, deletePendingPromotion,
  findPromotionByReference, confirmPromotionPayment, listSellerPromotions,
  adminListPromotions, adminChangePromotion
} = require('../models/promotionModel');
const { getPlans, findPlan } = require('../utils/promoPlans');
const { notifyAdminOfPromotion } = require('../utils/promoAlert');
const { paymentsStatus, initializeTransaction, verifyTransaction } = require('../utils/paystack');

function siteOrigin() {
  const raw = process.env.SITE_URL || 'https://tm-market-pi.vercel.app';
  try { return new URL(raw).origin; } catch (e) { return 'https://tm-market-pi.vercel.app'; }
}

// Paystack may only send the seller back to our own site.
function safeCallbackUrl(candidate) {
  const origin = siteOrigin();
  const fallback = `${origin}/vendor-register.html?promoreturn=1`;
  if (typeof candidate !== 'string' || !candidate || candidate.length > 500) return fallback;
  try {
    const u = new URL(candidate);
    if (u.origin !== origin || u.username || u.password) return fallback;
    return u.toString();
  } catch (e) { return fallback; }
}

function makeReference(productId) {
  return `TMP-${productId}-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

const fmtDay = d => new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });

function mapOutcome(outcome) {
  switch (outcome) {
    case 'activated': return { ok: true, code: 200, message: 'Payment confirmed. Your promotion is live.' };
    case 'already_active': return { ok: true, code: 200, message: 'This promotion is already confirmed.' };
    case 'amount_mismatch': return { ok: false, code: 409, message: 'Payment amount mismatch. Please contact support.' };
    default: return { ok: false, code: 404, message: 'Promotion not found.' };
  }
}

async function getMyPromotions(req, res) {
  try {
    return res.status(200).json({
      success: true,
      plans: getPlans(),
      paymentsReady: paymentsStatus() === 'ok',
      promotions: await listSellerPromotions(req.user.id)
    });
  } catch (error) {
    console.error('List promotions error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load your promotions' });
  }
}

async function startPromotion(req, res) {
  let pendingId = null;
  try {
    const status = paymentsStatus();
    if (status === 'missing') return res.status(503).json({ success: false, message: 'Payments are not configured yet.' });
    if (status !== 'ok') return res.status(503).json({ success: false, message: 'Live payments are blocked until enabled by admin.' });

    const body = req.body || {};
    const productId = parsePositiveInt(body.productId);
    const plan = findPlan(body.days);
    if (!productId) return res.status(400).json({ success: false, message: 'A valid productId is required.' });
    if (!plan) return res.status(400).json({ success: false, message: 'Choose a promotion plan: 7, 14 or 30 days.' });

    const product = await findPromotableProduct(productId, req.user.id);
    if (!product) return res.status(404).json({ success: false, message: 'Listing not found' });
    if (product.status !== 'active' || product.is_active === false || (product.quantity !== null && product.quantity !== undefined && Number(product.quantity) <= 0)) {
      return res.status(409).json({ success: false, message: 'Only active listings that are in stock can be promoted.' });
    }

    const blocking = await findBlockingPromotion(productId);
    if (blocking) {
      return res.status(409).json({
        success: false,
        message: blocking.status === 'paused'
          ? 'This listing already has a promotion that is paused by TM Market.'
          : `This listing is already promoted until ${fmtDay(blocking.ends_at)}. You can promote it again after that.`
      });
    }

    const reference = makeReference(productId);
    pendingId = await createPendingPromotion({ productId, sellerId: req.user.id, planDays: plan.days, amount: plan.price, reference });

    const tx = await initializeTransaction({
      email: product.email,
      amount: Math.round(plan.price * 100),
      reference,
      currency: 'NGN',
      callback_url: safeCallbackUrl(typeof body.callbackUrl === 'string' ? body.callbackUrl.trim() : ''),
      metadata: { type: 'promotion', promotionId: pendingId, productId, userId: req.user.id }
    });

    return res.status(200).json({
      success: true,
      message: 'Payment initialized.',
      payment: { reference, authorizationUrl: tx.authorization_url, accessCode: tx.access_code }
    });
  } catch (error) {
    console.error('Start promotion error:', error);
    if (pendingId) { try { await deletePendingPromotion(pendingId); } catch (e) { /* harmless leftover */ } }
    return res.status(502).json({ success: false, message: 'Unable to start payment at the moment.' });
  }
}

async function verifyMyPromotion(req, res) {
  try {
    const status = paymentsStatus();
    if (status !== 'ok') return res.status(503).json({ success: false, message: 'Payments are not available right now.' });

    const reference = typeof (req.query && req.query.reference) === 'string' ? req.query.reference.trim() : '';
    if (!reference) return res.status(400).json({ success: false, message: 'reference is required.' });

    const own = await findPromotionByReference(reference, req.user.id);
    if (!own) return res.status(404).json({ success: false, message: 'Promotion not found.' });

    const tx = await verifyTransaction(reference);
    if (!tx || tx.status !== 'success') {
      return res.status(409).json({ success: false, message: 'Payment is not successful yet.' });
    }

    const result = await confirmPromotionPayment(reference, Number(tx.amount), tx.currency);
    if (result.outcome === 'activated') notifyAdminOfPromotion(result.id);
    const mapped = mapOutcome(result.outcome);
    return res.status(mapped.code).json({ success: mapped.ok, message: mapped.message, outcome: result.outcome });
  } catch (error) {
    console.error('Verify promotion error:', error);
    return res.status(502).json({ success: false, message: 'Unable to verify payment right now.' });
  }
}

// Called by the Paystack webhook for charge.success events that carry metadata.type === 'promotion'.
async function handlePromotionWebhook(data) {
  const reference = data && typeof data.reference === 'string' ? data.reference : '';
  if (!reference) return;
  const result = await confirmPromotionPayment(reference, Number(data.amount), data.currency);
  if (result.outcome === 'activated') notifyAdminOfPromotion(result.id);
  else if (result.outcome !== 'already_active') console.warn('Promotion webhook outcome:', result.outcome, reference);
}

async function adminList(req, res) {
  try {
    const page = parsePositiveInt(req.query.page) || 1;
    const limit = Math.min(parsePositiveInt(req.query.limit) || 20, 50);
    const state = typeof req.query.status === 'string' ? req.query.status : '';
    const d = await adminListPromotions({ state, limit, offset: (page - 1) * limit });
    return res.status(200).json({ success: true, promotions: d.promotions, summary: d.summary, total: d.total, page, limit });
  } catch (error) {
    console.error('Admin list promotions error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load promotions' });
  }
}

const ACTION_MESSAGES = { pause: 'Promotion paused', resume: 'Promotion resumed', remove: 'Promotion removed' };

function adminAction(action) {
  return async function (req, res) {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Invalid promotion id' });
      const out = await adminChangePromotion(id, action);
      if (out.result === 'not_found') return res.status(404).json({ success: false, message: 'Promotion not found' });
      if (out.result === 'bad_state') return res.status(409).json({ success: false, message: `This promotion cannot be ${action === 'remove' ? 'removed' : action + 'd'} in its current state.` });
      return res.status(200).json({ success: true, message: ACTION_MESSAGES[action], promotion: out.promotion });
    } catch (error) {
      console.error('Admin promotion action error:', error);
      return res.status(500).json({ success: false, message: 'Unable to update the promotion' });
    }
  };
}

module.exports = {
  getMyPromotions, startPromotion, verifyMyPromotion, handlePromotionWebhook,
  adminList, adminPause: adminAction('pause'), adminResume: adminAction('resume'), adminRemove: adminAction('remove')
};
