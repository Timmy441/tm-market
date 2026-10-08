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
  confirmPayment: async () => state.confirm,
  getOrderAlertInfo: async () => ({
    order_number: 'TM-TEST-7', total: '1500.00', shipping_name: 'Ada', shipping_phone: '0801', shipping_address: '1 Road',
    shipping_city: 'Enugu', shipping_state: 'Enugu', buyer_first_name: 'Ada', buyer_last_name: 'O', buyer_email: 'buyer@test.com',
    seller_name: 'Store', seller_email: 'seller@test.com', delivery_window_start: '2026-10-12', delivery_window_end: '2026-10-16', items: [{ name: 'Pencil', quantity: 2 }]
  })
});

const sent = [];
let mailFails = false;
mock('../src/utils/mailer', {
  mailConfigured: () => true,
  sendMail: async m => { if (mailFails) throw new Error('mail down'); sent.push(m); }
});

mock('../src/utils/paystack', {
  paymentsStatus: () => state.paymentMode,
  initializeTransaction: async (payload) => { state.lastPayload = payload; return state.initTx; },
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

test('initialize payment only allows callback URLs on our own site', async () => {
  delete process.env.SITE_URL;
  const good = 'https://tm-market-pi.vercel.app/homepage.html?payreturn=1&orderId=7';
  await call(c.initializePaystackPayment, { user: { id: 1 }, body: { orderId: 7, callbackUrl: good } });
  assert.strictEqual(state.lastPayload.callback_url, good);
  const bad = ['https://evil.example.com/steal', 'http://tm-market-pi.vercel.app.evil.com/x', 'https://tm-market-pi.vercel.app@evil.com/x', 'javascript:alert(1)', 'not a url'];
  for (const b of bad) {
    await call(c.initializePaystackPayment, { user: { id: 1 }, body: { orderId: 7, callbackUrl: b } });
    assert.strictEqual(state.lastPayload.callback_url, 'https://tm-market-pi.vercel.app/homepage.html?payreturn=1&orderId=7', b);
  }
  await call(c.initializePaystackPayment, { user: { id: 1 }, body: { orderId: 7 } });
  assert.match(state.lastPayload.callback_url, /^https:\/\/tm-market-pi\.vercel\.app\//);
});

const tick = () => new Promise(r => setTimeout(r, 30));
const verifyReq = { user: { id: 1 }, query: { orderId: '7', reference: 'TM-7-REF' } };

test('admin gets an email when an order is paid', async () => {
  process.env.ADMIN_NOTIFY_EMAIL = 'admin@test.com';
  sent.length = 0;
  state.confirm = { outcome: 'paid', orderNumber: 'TM-TEST-7' };
  const r = await call(c.verifyPaystackPayment, verifyReq);
  await tick();
  assert.strictEqual(r.code, 200);
  const adminMail = sent.filter(m => m.to === 'admin@test.com');
  assert.strictEqual(adminMail.length, 1);
  assert.strictEqual(sent[0].to, 'admin@test.com');
  assert.match(sent[0].subject, /New paid order: TM-TEST-7/);
  assert.match(sent[0].text, /2 x Pencil/);
});

test('admin email is skipped for already-paid, unset address, and never breaks payment', async () => {
  process.env.ADMIN_NOTIFY_EMAIL = 'admin@test.com';
  sent.length = 0;
  state.confirm = { outcome: 'already_paid', orderNumber: 'TM-TEST-7' };
  await call(c.verifyPaystackPayment, verifyReq);
  await tick();
  assert.strictEqual(sent.length, 0);

  delete process.env.ADMIN_NOTIFY_EMAIL;
  state.confirm = { outcome: 'paid', orderNumber: 'TM-TEST-7' };
  await call(c.verifyPaystackPayment, verifyReq);
  await tick();
  assert.strictEqual(sent.filter(m => m.to === 'admin@test.com').length, 0);
  sent.length = 0;

  process.env.ADMIN_NOTIFY_EMAIL = 'admin@test.com';
  mailFails = true;
  const r = await call(c.verifyPaystackPayment, verifyReq);
  await tick();
  assert.strictEqual(r.code, 200);
  mailFails = false;
  delete process.env.ADMIN_NOTIFY_EMAIL;
  state.confirm = { outcome: 'paid', orderNumber: 'TM-TEST-7' };
});

test('admin email also fires from the webhook, and flags refund cases', async () => {
  process.env.ADMIN_NOTIFY_EMAIL = 'admin@test.com';
  sent.length = 0;
  state.webhookVerified = true;
  state.confirm = { outcome: 'oversold', orderNumber: 'TM-TEST-7' };
  const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'R', amount: 150000, currency: 'NGN', metadata: { orderId: 7 } } }), 'utf8');
  const r = await call(c.paystackWebhook, { headers: { 'x-paystack-signature': 'ok' }, body: raw });
  await tick();
  assert.strictEqual(r.code, 200);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].subject, /ACTION NEEDED/);
  delete process.env.ADMIN_NOTIFY_EMAIL;
  state.confirm = { outcome: 'paid', orderNumber: 'TM-TEST-7' };
});

test('seller gets an email on a paid order only, and it never claims payout', async () => {
  process.env.ADMIN_NOTIFY_EMAIL = 'admin@test.com';
  sent.length = 0;
  state.confirm = { outcome: 'paid', orderNumber: 'TM-TEST-7' };
  await call(c.verifyPaystackPayment, verifyReq);
  await tick();
  const toSeller = sent.filter(m => m.to === 'seller@test.com');
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(toSeller.length, 1);
  assert.match(toSeller[0].subject, /TM-TEST-7/);
  assert.match(toSeller[0].text, /2 x Pencil/);
  assert.match(toSeller[0].text, /1 Road, Enugu, Enugu/);
  assert.doesNotMatch(toSeller[0].text, /you have been paid|payout/i);

  sent.length = 0;
  state.confirm = { outcome: 'oversold', orderNumber: 'TM-TEST-7' };
  await call(c.verifyPaystackPayment, verifyReq);
  await tick();
  assert.strictEqual(sent.filter(m => m.to === 'seller@test.com').length, 0);

  sent.length = 0;
  delete process.env.ADMIN_NOTIFY_EMAIL;
  state.confirm = { outcome: 'paid', orderNumber: 'TM-TEST-7' };
  await call(c.verifyPaystackPayment, verifyReq);
  await tick();
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].to, 'seller@test.com');
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