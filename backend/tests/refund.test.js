const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

console.log = () => {};
console.error = () => {};

function mock(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

/* ---------------- a fake database (checks the flow, not the SQL itself) ---------------- */

const scenario = {};
const sqlLog = [];

function answer(sql, params) {
  sqlLog.push({ sql, params });
  const s = sql.replace(/\s+/g, ' ');
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return { rows: [], rowCount: 0 };
  if (s.includes('FROM orders WHERE id = $1 FOR UPDATE')) {
    return scenario.noOrder ? { rows: [], rowCount: 0 } : { rows: [{ id: 5, order_number: 'TM-1001', status: scenario.orderStatus || 'confirmed', seller_id: 7, total: '5000.00' }], rowCount: 1 };
  }
  if (s.includes('FROM payments WHERE order_id = $1 FOR UPDATE')) {
    if (scenario.noPayment) return { rows: [], rowCount: 0 };
    return { rows: [{ id: 3, status: scenario.paymentStatus || 'successful', transaction_reference: scenario.txRef || 'TM-5-REF' }], rowCount: 1 };
  }
  if (s.includes('FROM users WHERE id = $1 FOR UPDATE')) return { rows: [{ id: 7 }], rowCount: 1 };
  if (s.startsWith('UPDATE payments')) {
    if (scenario.refundError) throw scenario.refundError;
    return { rows: [{ id: 3 }], rowCount: scenario.paymentUpdateCount === 0 ? 0 : 1 };
  }
  if (s.includes('SUM(e.net)')) return { rows: [{ pending: scenario.pending || '0', released: scenario.released || '0' }], rowCount: 1 };
  if (s.includes('SUM(amount)')) return { rows: [{ withdrawn: scenario.withdrawn || '0', in_review: scenario.inReview || '0' }], rowCount: 1 };
  if (s.includes('FROM order_items')) return { rows: [], rowCount: 0 };
  return { rows: [], rowCount: 1 };
}

const client = { query: async (sql, params) => answer(sql, params), release() { client.released = true; } };
mock('../db', { query: async (sql, params) => answer(sql, params), connect: async () => { client.released = false; return client; } });

const model = require('../src/models/refundModel');
const paymentModel = require('../src/models/paymentModel');
const reset = () => { for (const k of Object.keys(scenario)) delete scenario[k]; sqlLog.length = 0; };
const ran = re => sqlLog.some(q => re.test(q.sql.replace(/\s+/g, ' ')));

/* ---------------- recording a refund ---------------- */

test('a paid order is refunded: payment refunded, order cancelled, history written, committed', async () => {
  reset();
  Object.assign(scenario, { released: '0', pending: '4500.00' });
  const r = await model.recordRefund(5, 1, 'RF-123456', 'Item out of stock', 3);
  assert.deepStrictEqual(r, { status: 'ok', orderNumber: 'TM-1001' });
  assert.ok(ran(/UPDATE payments SET status = 'refunded'/));
  assert.ok(ran(/UPDATE orders SET status = 'cancelled'/));
  assert.ok(ran(/INSERT INTO order_events/));
  assert.ok(ran(/COMMIT/));
  assert.ok(!ran(/ROLLBACK/));
  assert.strictEqual(client.released, true);
  const upd = sqlLog.find(q => /UPDATE payments/.test(q.sql));
  assert.deepStrictEqual(upd.params, [5, 'RF-123456', 'Item out of stock', 1]);
});

test('the order, payment and seller rows are locked while it happens', async () => {
  reset();
  await model.recordRefund(5, 1, 'RF-123456', 'Reason', 3);
  const locks = sqlLog.filter(q => /FOR UPDATE/.test(q.sql)).map(q => q.sql.replace(/\s+/g, ' ').match(/FROM (\w+)/)[1]);
  assert.deepStrictEqual(locks, ['orders', 'payments', 'users']);
});

test('the buyer-facing history note never contains the admin reason', async () => {
  reset();
  await model.recordRefund(5, 1, 'RF-123456', 'Secret internal reason', 3);
  const ev = sqlLog.find(q => /INSERT INTO order_events/.test(q.sql));
  assert.ok(!/Secret internal reason/.test(JSON.stringify(ev)));
});

test('an order that does not exist changes nothing', async () => {
  reset(); scenario.noOrder = true;
  assert.deepStrictEqual(await model.recordRefund(5, 1, 'RF-123456', 'Reason', 3), { status: 'not_found' });
  assert.ok(ran(/ROLLBACK/)); assert.ok(!ran(/COMMIT/)); assert.ok(!ran(/UPDATE payments/));
});

test('an unpaid order cannot be refunded', async () => {
  for (const status of ['pending', 'failed']) {
    reset(); scenario.paymentStatus = status;
    assert.strictEqual((await model.recordRefund(5, 1, 'RF-123456', 'Reason', 3)).status, 'not_paid');
    assert.ok(!ran(/UPDATE payments/)); assert.ok(!ran(/COMMIT/));
  }
  reset(); scenario.noPayment = true;
  assert.strictEqual((await model.recordRefund(5, 1, 'RF-123456', 'Reason', 3)).status, 'not_paid');
});

test('an order that was already refunded cannot be refunded twice', async () => {
  reset(); scenario.paymentStatus = 'refunded';
  assert.strictEqual((await model.recordRefund(5, 1, 'RF-123456', 'Reason', 3)).status, 'already_refunded');
  assert.ok(!ran(/UPDATE payments/)); assert.ok(!ran(/COMMIT/));
});

test('if another request refunds it first, the second one changes nothing', async () => {
  reset(); scenario.paymentUpdateCount = 0;
  assert.strictEqual((await model.recordRefund(5, 1, 'RF-123456', 'Reason', 3)).status, 'already_refunded');
  assert.ok(ran(/ROLLBACK/)); assert.ok(!ran(/COMMIT/)); assert.ok(!ran(/UPDATE orders/));
});

test('a refund reference that is already used is refused and rolled back', async () => {
  reset(); scenario.refundError = Object.assign(new Error('dup'), { code: '23505' });
  assert.strictEqual((await model.recordRefund(5, 1, 'RF-123456', 'Reason', 3)).status, 'duplicate_reference');
  assert.ok(ran(/ROLLBACK/)); assert.ok(!ran(/COMMIT/)); assert.strictEqual(client.released, true);
});

test('other database errors are thrown, rolled back, and the connection is released', async () => {
  reset(); scenario.refundError = new Error('db down');
  await assert.rejects(() => model.recordRefund(5, 1, 'RF-123456', 'Reason', 3), /db down/);
  assert.ok(ran(/ROLLBACK/)); assert.ok(!ran(/COMMIT/)); assert.strictEqual(client.released, true);
});

test('NEVER below zero: if the seller already withdrew this money the refund is undone', async () => {
  reset();
  // released 20,000, already paid out 18,000, and 2,000 more is waiting: this order's earnings are part of it.
  Object.assign(scenario, { released: '15000.00', withdrawn: '18000.00', inReview: '0' });
  const r = await model.recordRefund(5, 1, 'RF-123456', 'Reason', 3);
  assert.strictEqual(r.status, 'already_withdrawn');
  assert.ok(ran(/ROLLBACK/)); assert.ok(!ran(/COMMIT/));
  assert.ok(!ran(/UPDATE orders/), 'the order must not be cancelled');
  assert.ok(!ran(/INSERT INTO order_events/));
});

test('NEVER below zero: money in an open withdrawal request counts too', async () => {
  reset();
  Object.assign(scenario, { released: '9000.00', withdrawn: '0', inReview: '10000.00' });
  assert.strictEqual((await model.recordRefund(5, 1, 'RF-123456', 'Reason', 3)).status, 'already_withdrawn');
  assert.ok(!ran(/COMMIT/));
});

test('a refund that still leaves enough money for what was withdrawn is allowed', async () => {
  reset();
  Object.assign(scenario, { released: '18000.00', withdrawn: '18000.00', inReview: '0' });
  assert.strictEqual((await model.recordRefund(5, 1, 'RF-123456', 'Reason', 3)).status, 'ok');
  assert.ok(ran(/COMMIT/));
});

test('the guard uses the hold days it is given', async () => {
  reset();
  await model.recordRefund(5, 1, 'RF-123456', 'Reason', 3);
  const q = sqlLog.find(q => /SUM\(e\.net\)/.test(q.sql));
  assert.strictEqual(q.params[1], 3);
});

/* ---------------- a late Paystack message must never undo a refund ---------------- */

test('a payment confirmation arriving after a refund is ignored and cannot make it successful again', async () => {
  reset(); scenario.paymentStatus = 'refunded'; scenario.orderStatus = 'cancelled';
  const r = await paymentModel.confirmPayment(5, 'TM-5-REF', 500000, 'NGN');
  assert.deepStrictEqual(r, { outcome: 'already_refunded', orderNumber: 'TM-1001' });
  assert.ok(!ran(/UPDATE payments/));
  assert.ok(!ran(/COMMIT/));
});

test('a new payment attempt can never overwrite a refunded payment', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/models/paymentModel.js'), 'utf8');
  assert.ok(/payments\.status NOT IN \('successful', 'refunded'\)/.test(src));
});

/* ---------------- the admin endpoint ---------------- */

const stub = { info: null, result: { status: 'ok', orderNumber: 'TM-1001' }, calls: [], emails: [] };
mock('../src/models/refundModel', {
  getRefundInfo: async () => stub.info,
  recordRefund: async (...args) => { stub.calls.push(args); return stub.result; }
});
mock('../src/utils/refundAlert', { notifyOfRefund: async id => { stub.emails.push(id); } });
const c = require('../src/controllers/refundController');

async function call(fn, req) {
  return new Promise(resolve => {
    const res = { code: 200, status(n) { this.code = n; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    fn({ params: {}, body: {}, user: { id: 1 }, ...req }, res);
  });
}
const resetStub = () => { stub.info = { id: 5, amount: '5000.00' }; stub.result = { status: 'ok', orderNumber: 'TM-1001' }; stub.calls.length = 0; stub.emails.length = 0; };
const good = { params: { id: '5' }, body: { reference: 'RF-123456', note: 'Item not available' } };

test('endpoint: a good request records the refund, sends the emails once, and uses the admin id from the login', async () => {
  resetStub();
  const r = await call(c.adminRefund, { ...good, user: { id: 42 } });
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.success, true);
  assert.strictEqual(stub.calls.length, 1);
  assert.deepStrictEqual(stub.calls[0].slice(0, 4), [5, 42, 'RF-123456', 'Item not available']);
  assert.deepStrictEqual(stub.emails, [5]);
});

test('endpoint: bad ids, references and reasons are refused before anything is recorded', async () => {
  resetStub();
  for (const id of ['abc', '0', '-1', '1.5', '']) assert.strictEqual((await call(c.adminRefund, { ...good, params: { id } })).code, 400);
  for (const reference of ['', 'abc', 'x'.repeat(121), 'bad<script>', null, 123, undefined]) {
    assert.strictEqual((await call(c.adminRefund, { ...good, body: { reference, note: 'Reason here' } })).code, 400, String(reference));
  }
  for (const note of ['', 'ab', 'x'.repeat(201), null, undefined, 5]) {
    assert.strictEqual((await call(c.adminRefund, { ...good, body: { reference: 'RF-123456', note } })).code, 400, String(note));
  }
  assert.strictEqual(stub.calls.length, 0); assert.strictEqual(stub.emails.length, 0);
});

test('endpoint: an unknown order is a 404', async () => {
  resetStub(); stub.info = null;
  assert.strictEqual((await call(c.adminRefund, good)).code, 404);
  assert.strictEqual(stub.calls.length, 0);
});

test('endpoint: every refused outcome is a 409 with a clear message and sends no email', async () => {
  for (const status of ['not_paid', 'already_refunded', 'duplicate_reference', 'already_withdrawn']) {
    resetStub(); stub.result = { status };
    const r = await call(c.adminRefund, good);
    assert.strictEqual(r.code, 409, status); assert.strictEqual(r.body.success, false);
    assert.ok(r.body.message.length > 20);
    assert.strictEqual(stub.emails.length, 0, status);
  }
  resetStub(); stub.result = { status: 'already_withdrawn' };
  assert.match((await call(c.adminRefund, good)).body.message, /Nothing was changed/);
});

test('endpoint: an unexpected outcome or error never says success', async () => {
  resetStub(); stub.result = { status: 'weird' };
  assert.strictEqual((await call(c.adminRefund, good)).code, 500);
  resetStub(); stub.result = null;
  assert.strictEqual((await call(c.adminRefund, good)).code, 500);
  assert.strictEqual(stub.emails.length, 0);
});

/* ---------------- wiring ---------------- */

test('the refund route sits behind the admin check, and the migration file exists', () => {
  const routes = fs.readFileSync(path.join(__dirname, '../src/routes/adminRoutes.js'), 'utf8');
  assert.ok(routes.indexOf('router.use(authenticateToken, requireAdmin)') < routes.indexOf("router.post('/orders/:id/refund'"));
  const mig = fs.readFileSync(path.join(__dirname, '../migrations/010_refunds.sql'), 'utf8');
  assert.ok(/refund_reference/.test(mig) && /uq_payments_refund_reference/.test(mig));
});
