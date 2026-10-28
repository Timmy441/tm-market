const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'test-only-value';

function mock(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

mock('../src/models/productModel', {});

const calls = { confirm: [], deleted: [], changed: [], orderConfirm: 0 };
let state;
function reset() {
  state = {
    paymentMode: 'ok',
    product: { id: 5, name: 'Pencil', status: 'active', is_active: true, quantity: 3, email: 'seller@test.com' },
    blocking: null,
    own: { id: 11 },
    verifyTx: { status: 'success', amount: 180000, currency: 'NGN' },
    confirm: { outcome: 'activated', id: 11 },
    initFails: false,
    change: { result: 'ok', promotion: { id: 11, state: 'paused' } },
    mail: []
  };
  calls.confirm = []; calls.deleted = []; calls.changed = []; calls.orderConfirm = 0;
}
reset();

mock('../src/models/promotionModel', {
  findPromotableProduct: async () => state.product,
  findBlockingPromotion: async () => state.blocking,
  createPendingPromotion: async args => { state.pending = args; return 11; },
  deletePendingPromotion: async id => { calls.deleted.push(id); },
  findPromotionByReference: async () => state.own,
  confirmPromotionPayment: async (ref, kobo, cur) => { calls.confirm.push([ref, kobo, cur]); return state.confirm; },
  listSellerPromotions: async () => [{ id: 11, state: 'running' }],
  adminListPromotions: async () => ({ promotions: [], total: 0, summary: { total: 0, last30: 0, sold: 0, running: 0 } }),
  adminChangePromotion: async (id, action) => { calls.changed.push([id, action]); return state.change; },
  getPromotionAlertInfo: async () => ({
    plan_days: 14, amount: '1800.00', reference: 'TMP-5-1', starts_at: '2026-10-28T10:00:00Z', ends_at: '2026-11-11T10:00:00Z',
    product_name: 'Pencil', seller_name: 'Jay Store', seller_email: 'seller@test.com'
  })
});

mock('../src/utils/mailer', {
  mailConfigured: () => true,
  sendMail: async m => { state.mail.push(m); }
});

mock('../src/utils/paystack', {
  paymentsStatus: () => state.paymentMode,
  initializeTransaction: async payload => {
    if (state.initFails) throw new Error('paystack down');
    state.lastPayload = payload;
    return { authorization_url: 'https://paystack.test/pay', access_code: 'AC1' };
  },
  verifyTransaction: async () => state.verifyTx,
  verifySignature: () => true
});

mock('../src/models/paymentModel', {
  findOrderForPayment: async () => null,
  savePendingPayment: async () => true,
  confirmPayment: async () => { calls.orderConfirm++; return { outcome: 'paid' }; },
  getOrderAlertInfo: async () => null
});

const { getPlans, findPlan } = require('../src/utils/promoPlans');
const { sponsoredSlots, mergeSponsored } = require('../src/utils/sponsored');
const c = require('../src/controllers/promotionController');
const pay = require('../src/controllers/paymentController');

const call = (handler, req) => new Promise(resolve => {
  const res = { status(x) { this.code = x; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
  handler({ headers: {}, params: {}, query: {}, body: {}, user: { id: 9, role: 'seller' }, ...req }, res);
});
const quietly = async fn => {
  const e = console.error, w = console.warn;
  console.error = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.error = e; console.warn = w; }
};
const tick = () => new Promise(r => setTimeout(r, 20));

test('plans use the placeholder prices and Fly secrets override them', () => {
  delete process.env.PROMO_PRICE_7; delete process.env.PROMO_PRICE_14; delete process.env.PROMO_PRICE_30;
  assert.deepStrictEqual(getPlans(), [{ days: 7, price: 1000 }, { days: 14, price: 1800 }, { days: 30, price: 3000 }]);
  process.env.PROMO_PRICE_14 = '2500';
  assert.strictEqual(findPlan(14).price, 2500);
  process.env.PROMO_PRICE_14 = 'abc';
  assert.strictEqual(findPlan(14).price, 1800);
  process.env.PROMO_PRICE_14 = '5';
  assert.strictEqual(findPlan(14).price, 1800);
  delete process.env.PROMO_PRICE_14;
  assert.strictEqual(findPlan(10), null);
});

test('sponsored items: at most 2 per 8, never on a tiny page, never duplicated', () => {
  assert.strictEqual(sponsoredSlots(6), 0);
  assert.strictEqual(sponsoredSlots(8), 2);
  assert.strictEqual(sponsoredSlots(12), 2);
  assert.strictEqual(sponsoredSlots(16), 4);
  assert.strictEqual(sponsoredSlots(50), 6);

  const organic = Array.from({ length: 12 }, (_, i) => ({ id: i + 1 }));
  const out = mergeSponsored(organic, [{ id: 5 }, { id: 99 }]);
  assert.strictEqual(out.filter(p => String(p.id) === '5').length, 1);
  assert.strictEqual(out.length, 13);
  assert.deepStrictEqual(out.filter(p => p.is_sponsored).map(p => p.id), [5, 99]);
  assert.strictEqual(out[1].id, 5);
  assert.strictEqual(mergeSponsored(organic, []).every(p => p.is_sponsored === false), true);
});

test('seller sees the plans and their promotions', async () => {
  const r = await call(c.getMyPromotions, {});
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.plans.length, 3);
  assert.strictEqual(r.body.paymentsReady, true);
  assert.strictEqual(r.body.promotions[0].state, 'running');
});

test('starting a promotion is refused when payments are not configured or live is blocked', async () => {
  reset(); state.paymentMode = 'missing';
  assert.strictEqual((await call(c.startPromotion, { body: { productId: 5, days: 14 } })).code, 503);
  state.paymentMode = 'live_blocked';
  assert.strictEqual((await call(c.startPromotion, { body: { productId: 5, days: 14 } })).code, 503);
});

test('starting a promotion validates the listing id and the plan', async () => {
  reset();
  assert.strictEqual((await call(c.startPromotion, { body: { days: 14 } })).code, 400);
  assert.strictEqual((await call(c.startPromotion, { body: { productId: 5, days: 10 } })).code, 400);
  assert.strictEqual((await call(c.startPromotion, { body: { productId: 5 } })).code, 400);
});

test('a seller cannot promote a listing that is not theirs, sold, or out of stock', async () => {
  reset(); state.product = null;
  assert.strictEqual((await call(c.startPromotion, { body: { productId: 5, days: 7 } })).code, 404);
  reset(); state.product.status = 'sold';
  assert.strictEqual((await call(c.startPromotion, { body: { productId: 5, days: 7 } })).code, 409);
  reset(); state.product.quantity = 0;
  assert.strictEqual((await call(c.startPromotion, { body: { productId: 5, days: 7 } })).code, 409);
});

test('a listing that is already promoted cannot be bought twice', async () => {
  reset(); state.blocking = { id: 3, status: 'active', ends_at: '2026-11-20T00:00:00Z' };
  const r = await call(c.startPromotion, { body: { productId: 5, days: 7 } });
  assert.strictEqual(r.code, 409);
  assert.match(r.body.message, /already promoted until/i);
  assert.strictEqual(state.pending, undefined);
});

test('starting a promotion charges the server-side price, not anything the browser sends', async () => {
  reset();
  const r = await call(c.startPromotion, {
    body: { productId: 5, days: 14, price: 1, amount: 1, callbackUrl: 'https://tm-market-pi.vercel.app/vendor-register.html?promoreturn=1' }
  });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.payment.authorizationUrl, 'https://paystack.test/pay');
  assert.ok(r.body.payment.reference.startsWith('TMP-5-'));
  assert.strictEqual(state.lastPayload.amount, 180000);
  assert.strictEqual(state.lastPayload.currency, 'NGN');
  assert.strictEqual(state.lastPayload.email, 'seller@test.com');
  assert.strictEqual(state.lastPayload.metadata.type, 'promotion');
  assert.strictEqual(state.pending.amount, 1800);
  assert.strictEqual(state.pending.planDays, 14);
  assert.strictEqual(state.pending.sellerId, 9);
});

test('Paystack can only send the seller back to our own site', async () => {
  reset(); delete process.env.SITE_URL;
  await call(c.startPromotion, { body: { productId: 5, days: 7, callbackUrl: 'https://evil.example/steal' } });
  assert.strictEqual(state.lastPayload.callback_url, 'https://tm-market-pi.vercel.app/vendor-register.html?promoreturn=1');
});

test('if Paystack is down, the unpaid attempt is removed and the seller is told to retry', async () => {
  reset(); state.initFails = true;
  const r = await quietly(() => call(c.startPromotion, { body: { productId: 5, days: 7 } }));
  assert.strictEqual(r.code, 502);
  assert.deepStrictEqual(calls.deleted, [11]);
});

test('verify: only the owner can check a payment, and an unpaid one is not activated', async () => {
  reset(); state.own = null;
  assert.strictEqual((await call(c.verifyMyPromotion, { query: { reference: 'TMP-5-1' } })).code, 404);
  reset(); state.verifyTx = { status: 'abandoned', amount: 180000, currency: 'NGN' };
  assert.strictEqual((await call(c.verifyMyPromotion, { query: { reference: 'TMP-5-1' } })).code, 409);
  assert.strictEqual(calls.confirm.length, 0);
  reset();
  assert.strictEqual((await call(c.verifyMyPromotion, { query: {} })).code, 400);
});

test('verify: a paid promotion goes live and the admin gets one email', async () => {
  reset(); process.env.ADMIN_NOTIFY_EMAIL = 'admin@test.com';
  const r = await call(c.verifyMyPromotion, { query: { reference: 'TMP-5-1' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.outcome, 'activated');
  assert.deepStrictEqual(calls.confirm[0], ['TMP-5-1', 180000, 'NGN']);
  await tick();
  assert.strictEqual(state.mail.length, 1);
  assert.strictEqual(state.mail[0].to, 'admin@test.com');
  assert.match(state.mail[0].subject, /New promotion/);
  assert.match(state.mail[0].text, /14 days/);
});

test('verify: confirming again sends no second email, and a wrong amount is refused', async () => {
  reset(); process.env.ADMIN_NOTIFY_EMAIL = 'admin@test.com'; state.confirm = { outcome: 'already_active', id: 11 };
  const r = await call(c.verifyMyPromotion, { query: { reference: 'TMP-5-1' } });
  assert.strictEqual(r.code, 200);
  await tick();
  assert.strictEqual(state.mail.length, 0);
  reset(); state.confirm = { outcome: 'amount_mismatch', id: 11 };
  const m = await call(c.verifyMyPromotion, { query: { reference: 'TMP-5-1' } });
  assert.strictEqual(m.code, 409);
  await tick();
  assert.strictEqual(state.mail.length, 0);
});

test('a mail failure never breaks a promotion payment', async () => {
  reset(); process.env.ADMIN_NOTIFY_EMAIL = 'admin@test.com';
  require('../src/utils/mailer').sendMail = async () => { throw new Error('mail down'); };
  const r = await quietly(async () => { const x = await call(c.verifyMyPromotion, { query: { reference: 'TMP-5-1' } }); await tick(); return x; });
  assert.strictEqual(r.code, 200);
});

test('the Paystack webhook sends promotion payments to promotions and never touches orders', async () => {
  reset();
  const body = Buffer.from(JSON.stringify({
    event: 'charge.success',
    data: { reference: 'TMP-5-1', amount: 180000, currency: 'NGN', metadata: { type: 'promotion', promotionId: 11 } }
  }));
  const r = await call(pay.paystackWebhook, { headers: { 'x-paystack-signature': 'ok' }, body });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(calls.confirm[0], ['TMP-5-1', 180000, 'NGN']);
  assert.strictEqual(calls.orderConfirm, 0);
});

test('the webhook still handles normal order payments as before', async () => {
  reset();
  const body = Buffer.from(JSON.stringify({
    event: 'charge.success',
    data: { reference: 'TM-7-1-AB', amount: 150000, currency: 'NGN', metadata: { orderId: 7 } }
  }));
  const r = await call(pay.paystackWebhook, { headers: { 'x-paystack-signature': 'ok' }, body });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(calls.orderConfirm, 1);
  assert.strictEqual(calls.confirm.length, 0);
});

test('admin can pause, resume and remove; bad ids and wrong states are refused', async () => {
  reset();
  const admin = { user: { id: 1, role: 'admin' } };
  assert.strictEqual((await call(c.adminPause, { ...admin, params: { id: '11' } })).code, 200);
  assert.strictEqual((await call(c.adminResume, { ...admin, params: { id: '11' } })).code, 200);
  assert.strictEqual((await call(c.adminRemove, { ...admin, params: { id: '11' } })).code, 200);
  assert.deepStrictEqual(calls.changed.map(x => x[1]), ['pause', 'resume', 'remove']);
  assert.strictEqual((await call(c.adminPause, { ...admin, params: { id: 'x' } })).code, 400);
  state.change = { result: 'bad_state' };
  assert.strictEqual((await call(c.adminResume, { ...admin, params: { id: '11' } })).code, 409);
  state.change = { result: 'not_found' };
  assert.strictEqual((await call(c.adminRemove, { ...admin, params: { id: '99' } })).code, 404);
});

test('the admin list returns earnings and the page', async () => {
  reset();
  const r = await call(c.adminList, { user: { id: 1, role: 'admin' }, query: { page: '2', status: 'running' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.page, 2);
  assert.ok('summary' in r.body);
});
