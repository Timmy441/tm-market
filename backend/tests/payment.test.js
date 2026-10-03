const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

function mock(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

mock('../src/models/productModel', {});

let state = {
  paymentMode: 'ok',
  order: { id: 7, order_number: 'TM-TEST-7', status: 'pending', total: '1500.00', email: 'buyer@test.com' },
  savePending: true,
  verifyTx: { status: 'success', amount: 150000, currency: 'NGN' },
  confirm: { outcome: 'paid', orderNumber: 'TM-TEST-7' },
  initTx: { authorization_url: 'https://paystack.test/auth', access_code: 'ACODE123' },
  webhookVerified: true
};

mock('../src/models/paymentModel', {
  findOrderForPayment: async () => state.order,
  savePendingPayment: async () => state.savePending,
  confirmPayment: async () => state.confirm
});

mock('../src/utils/paystack', {
  paymentsStatus: () => state.paymentMode,
  initializeTransaction: async () => state.initTx,
  verifyTransaction: async () => state.verifyTx,
  verifySignature: () => state.webhookVerified
});

const c = require('../src/controllers/paymentController');

const call = (handler, req) => new Promise(resolve => {
  const res = {
    status(x) { this.code = x; return this; },
    json(b) { resolve({ code: this.code, body: b }); }
  };
  handler({ headers: {}, params: {}, query: {}, body: {}, ...req }, res);
});

test('initialize payment rejects when payments are not configured', async () => {
  state.paymentMode = 'missing';
  const r = await call(c.initializePaystackPayment, { user: { id: 1 }, body: { orderId: 7 } });
  assert.strictEqual(r.code, 503);
  assert.match(r.body.message, /not configured/i);
  state.paymentMode = 'ok';
});

test('initialize payment returns Paystack authorization fields', async () => {
  state.order = { id: 7, order_number: 'TM-TEST-7', status: 'pending', total: '1500.00', email: 'buyer@test.com' };
  state.savePending = true;
  const r = await call(c.initializePaystackPayment, {
    user: { id: 1 },
    body: { orderId: 7, callbackUrl: 'https://tm-market-pi.vercel.app/product.html' }
  });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.success, true);
  assert.strictEqual(r.body.payment.orderId, 7);
  assert.ok(r.body.payment.reference.startsWith('TM-7-'));
  assert.strictEqual(r.body.payment.authorizationUrl, 'https://paystack.test/auth');
});

test('verify payment maps paid outcome to success response', async () => {
  state.verifyTx = { status: 'success', amount: 150000, currency: 'NGN' };
  state.confirm = { outcome: 'paid', orderNumber: 'TM-TEST-7' };
  const r = await call(c.verifyPaystackPayment, {
    user: { id: 1 },
    query: { orderId: '7', reference: 'TM-7-REF' }
  });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.success, true);
  assert.strictEqual(r.body.outcome, 'paid');
});

test('verify payment maps amount mismatch to 409', async () => {
  state.confirm = { outcome: 'amount_mismatch', orderNumber: 'TM-TEST-7' };
  const r = await call(c.verifyPaystackPayment, {
    user: { id: 1 },
    query: { orderId: '7', reference: 'TM-7-REF' }
  });
  assert.strictEqual(r.code, 409);
  assert.strictEqual(r.body.success, false);
  assert.strictEqual(r.body.outcome, 'amount_mismatch');
});

test('webhook rejects invalid signature', async () => {
  state.webhookVerified = false;
  const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'A' } }), 'utf8');
  const r = await call(c.paystackWebhook, {
    headers: { 'x-paystack-signature': 'bad' },
    body: raw
  });
  assert.strictEqual(r.code, 401);
  state.webhookVerified = true;
});

test('webhook accepts non-charge events without processing', async () => {
  const raw = Buffer.from(JSON.stringify({ event: 'customeridentification.success', data: {} }), 'utf8');
  const r = await call(c.paystackWebhook, {
    headers: { 'x-paystack-signature': crypto.randomBytes(8).toString('hex') },
    body: raw
  });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.success, true);
});