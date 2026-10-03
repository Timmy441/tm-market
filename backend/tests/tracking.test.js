const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'test-only-value';

function mock(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

mock('../src/models/productModel', {});

// ---- in-memory stand-ins for the database layer ----
const PAID = ['confirmed', 'processing', 'shipped', 'delivered'];
let orders = [];

const day = offset => new Date(Date.now() + 3600000 + offset * 86400000).toISOString().slice(0, 10);

function reset() {
  orders = [
    { id: 1, order_number: 'TM-T-1', status: 'confirmed', user_id: 1, seller_id: 10, subtotal: '100.00', shipping_fee: '0', discount: '0', total: '100.00',
      shipping_name: 'B', shipping_phone: '+2348031234567', shipping_address: 'x', shipping_city: 'y', shipping_country: 'Nigeria',
      created_at: new Date(), items: [], events: [{ status: 'confirmed', note: 'Payment received', at: new Date() }],
      delivery_window_start: day(3), delivery_window_end: day(7) },
    { id: 2, order_number: 'TM-T-2', status: 'shipped', user_id: 1, seller_id: 10, subtotal: '5.00', shipping_fee: '0', discount: '0', total: '5.00',
      shipping_name: 'B', shipping_phone: '+2348031234567', shipping_address: 'x', shipping_city: 'y', shipping_country: 'Nigeria',
      created_at: new Date(), items: [], events: [] },
    { id: 3, order_number: 'TM-T-3', status: 'pending', user_id: 1, seller_id: 10, subtotal: '5.00', shipping_fee: '0', discount: '0', total: '5.00',
      shipping_name: 'B', shipping_phone: '+2348031234567', shipping_address: 'x', shipping_city: 'y', shipping_country: 'Nigeria',
      created_at: new Date(), items: [], events: [] }
  ];
}
reset();

mock('../src/models/orderModel', {
  getProductsForCheckout: async () => [],
  countPendingOrders: async () => 0,
  createOrders: async () => [],
  listMyOrders: async () => ({ orders: [], total: 0 }),
  listSellerOrders: async () => ({ orders: [], total: 0 }),
  cancelMyOrder: async () => false,
  findMyOrder: async (id, userId) => orders.find(o => o.id === id && o.user_id === userId) || null,
  findSellerOrder: async (id, sellerId) => orders.find(o => o.id === id && o.seller_id === sellerId && PAID.includes(o.status)) || null,
  advanceSellerOrder: async (id, sellerId, status, from, note) => {
    const o = orders.find(x => x.id === id && x.seller_id === sellerId && from.includes(x.status));
    if (!o) return false;
    o.status = status;
    o.events.push({ status, note, at: new Date() });
    return true;
  },
  setDeliveryWindow: async (id, sellerId, a, b) => {
    const o = orders.find(x => x.id === id && x.seller_id === sellerId && ['confirmed', 'processing', 'shipped'].includes(x.status));
    if (!o) return false;
    o.delivery_window_start = a; o.delivery_window_end = b;
    return true;
  },
  confirmDeliveredByBuyer: async (id, userId) => {
    const o = orders.find(x => x.id === id && x.user_id === userId && x.status === 'shipped');
    if (!o) return false;
    o.status = 'delivered'; o.delivered_at = new Date();
    return true;
  }
});

const c = require('../src/controllers/orderController');
const delivery = require('../src/utils/delivery');

const call = (handler, req) => new Promise(resolve => {
  const res = { status(x) { this.code = x; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
  handler({ params: {}, body: {}, query: {}, ...req }, res);
});

const buyer = { id: 1 };
const seller = { id: 10 };
const otherSeller = { id: 11 };

test('an order shows its delivery date range and history to the buyer', async () => {
  reset();
  const r = await call(c.getOrder, { user: buyer, params: { id: '1' } });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(r.body.order.deliveryWindow, { from: day(3), to: day(7) });
  assert.strictEqual(r.body.order.events[0].status, 'confirmed');
});

test('an order with no window yet reports null (never an invented date)', async () => {
  reset();
  const r = await call(c.getOrder, { user: buyer, params: { id: '2' } });
  assert.strictEqual(r.body.order.deliveryWindow, null);
  assert.deepStrictEqual(r.body.order.events, []);
});

test('a seller can set a valid delivery window on their own paid order', async () => {
  reset();
  const r = await call(c.sellerSetDeliveryWindow, { user: seller, params: { id: '1' }, body: { from: day(2), to: day(5) } });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(r.body.order.deliveryWindow, { from: day(2), to: day(5) });
});

test('bad delivery windows are rejected with 400', async () => {
  reset();
  const bad = [
    { from: day(-1), to: day(3) },            // starts in the past
    { from: day(5), to: day(2) },             // ends before it starts
    { from: day(1), to: day(40) },            // wider than 30 days
    { from: day(1), to: day(200) },           // too far ahead
    { from: '2026-02-31', to: '2026-03-03' }, // not a real date
    { from: 'soon', to: 'later' },
    {}
  ];
  for (const body of bad) {
    const r = await call(c.sellerSetDeliveryWindow, { user: seller, params: { id: '1' }, body });
    assert.strictEqual(r.code, 400, JSON.stringify(body));
  }
});

test('another seller, an unpaid order or a missing order gives 404 for the window', async () => {
  reset();
  const body = { from: day(1), to: day(3) };
  assert.strictEqual((await call(c.sellerSetDeliveryWindow, { user: otherSeller, params: { id: '1' }, body })).code, 404);
  assert.strictEqual((await call(c.sellerSetDeliveryWindow, { user: seller, params: { id: '3' }, body })).code, 404);
  assert.strictEqual((await call(c.sellerSetDeliveryWindow, { user: seller, params: { id: '99' }, body })).code, 404);
});

test('a seller moves an order confirmed -> processing -> shipped, and cannot go backwards', async () => {
  reset();
  let r = await call(c.sellerUpdateStatus, { user: seller, params: { id: '1' }, body: { status: 'processing', note: 'Packing now' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.order.status, 'processing');

  r = await call(c.sellerUpdateStatus, { user: seller, params: { id: '1' }, body: { status: 'shipped' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.order.status, 'shipped');

  r = await call(c.sellerUpdateStatus, { user: seller, params: { id: '1' }, body: { status: 'processing' } });
  assert.strictEqual(r.code, 409);
});

test('sellers cannot set delivered/cancelled/anything else, or touch other sellers\' orders', async () => {
  reset();
  for (const status of ['delivered', 'cancelled', 'pending', 'confirmed', 'hacked', 5, undefined]) {
    const r = await call(c.sellerUpdateStatus, { user: seller, params: { id: '1' }, body: { status } });
    assert.strictEqual(r.code, 400, String(status));
  }
  assert.strictEqual((await call(c.sellerUpdateStatus, { user: otherSeller, params: { id: '1' }, body: { status: 'shipped' } })).code, 404);
  assert.strictEqual((await call(c.sellerUpdateStatus, { user: seller, params: { id: '3' }, body: { status: 'shipped' } })).code, 404);
});

test('an over-long seller note is refused', async () => {
  reset();
  const r = await call(c.sellerUpdateStatus, { user: seller, params: { id: '1' }, body: { status: 'processing', note: 'x'.repeat(201) } });
  assert.strictEqual(r.code, 400);
});

test('only the buyer can confirm delivery, and only once the order is shipped', async () => {
  reset();
  assert.strictEqual((await call(c.confirmDelivered, { user: buyer, params: { id: '1' } })).code, 409);   // still confirmed
  assert.strictEqual((await call(c.confirmDelivered, { user: { id: 2 }, params: { id: '2' } })).code, 404); // someone else's order
  assert.strictEqual((await call(c.confirmDelivered, { user: seller, params: { id: '2' } })).code, 404);    // the seller cannot do it

  const ok = await call(c.confirmDelivered, { user: buyer, params: { id: '2' } });
  assert.strictEqual(ok.code, 200);
  assert.strictEqual(ok.body.order.status, 'delivered');
  assert.strictEqual((await call(c.confirmDelivered, { user: buyer, params: { id: '2' } })).code, 409);     // not twice
});

/* ---------------- date rules ---------------- */

test('default delivery window is 3-7 days and can be changed safely with env values', () => {
  delete process.env.DELIVERY_MIN_DAYS; delete process.env.DELIVERY_MAX_DAYS;
  assert.deepStrictEqual(delivery.defaultWindowDays(), { min: 3, max: 7 });

  process.env.DELIVERY_MIN_DAYS = '1'; process.env.DELIVERY_MAX_DAYS = '4';
  assert.deepStrictEqual(delivery.defaultWindowDays(), { min: 1, max: 4 });

  process.env.DELIVERY_MIN_DAYS = 'abc'; process.env.DELIVERY_MAX_DAYS = '-3';   // garbage falls back to defaults
  assert.deepStrictEqual(delivery.defaultWindowDays(), { min: 3, max: 7 });

  process.env.DELIVERY_MIN_DAYS = '9'; process.env.DELIVERY_MAX_DAYS = '2';      // max can never be below min
  assert.deepStrictEqual(delivery.defaultWindowDays(), { min: 9, max: 9 });

  delete process.env.DELIVERY_MIN_DAYS; delete process.env.DELIVERY_MAX_DAYS;
});

test('"today" follows Nigeria time (UTC+1)', () => {
  const lateEvening = Date.parse('2026-10-03T23:30:00Z');   // already 4 Oct in Lagos
  assert.strictEqual(delivery.lagosToday(lateEvening), '2026-10-04');
  assert.strictEqual(delivery.validateWindow('2026-10-04', '2026-10-06', lateEvening).ok, true);
  assert.strictEqual(delivery.validateWindow('2026-10-03', '2026-10-06', lateEvening).ok, false);
});

/* ---------------- payment confirmation sets the default window ---------------- */

test('a confirmed payment sets the delivery window and the first history step in the same transaction', async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params });
      if (/FROM orders WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: [{ id: 5, order_number: 'TM-X', status: 'pending', total: '100.00' }] };
      if (/FROM payments WHERE order_id/.test(sql)) return { rows: [{ id: 1, status: 'pending', transaction_reference: 'R' }] };
      if (/FROM order_items/.test(sql)) return { rows: [] };
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  mock('../db', { connect: async () => client, query: async () => ({ rows: [] }) });
  delete require.cache[require.resolve('../src/models/paymentModel')];
  const { confirmPayment } = require('../src/models/paymentModel');

  const out = await confirmPayment(5, 'R', 10000, 'NGN');
  assert.strictEqual(out.outcome, 'paid');

  const upd = queries.find(q => /SET status = 'confirmed'/.test(q.sql));
  assert.ok(upd, 'order is confirmed');
  assert.match(upd.sql, /delivery_window_start/);
  assert.deepStrictEqual(upd.params, [5, 3, 7]);

  const evt = queries.find(q => /INSERT INTO order_events/.test(q.sql));
  assert.ok(evt, 'history step recorded');
  assert.ok(queries.indexOf(evt) < queries.findIndex(q => q.sql === 'COMMIT'), 'recorded before COMMIT');
  assert.ok(!queries.some(q => q.sql === 'ROLLBACK'));
});

test('a wrong amount still marks nothing as paid and sets no window', async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params });
      if (/FROM orders WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: [{ id: 5, order_number: 'TM-X', status: 'pending', total: '100.00' }] };
      if (/FROM payments WHERE order_id/.test(sql)) return { rows: [{ id: 1, status: 'pending', transaction_reference: 'R' }] };
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  mock('../db', { connect: async () => client, query: async () => ({ rows: [] }) });
  delete require.cache[require.resolve('../src/models/paymentModel')];
  const { confirmPayment } = require('../src/models/paymentModel');

  const out = await confirmPayment(5, 'R', 9999, 'NGN');
  assert.strictEqual(out.outcome, 'amount_mismatch');
  assert.ok(!queries.some(q => /delivery_window_start/.test(q.sql)));
  assert.ok(!queries.some(q => /INSERT INTO order_events/.test(q.sql)));
});
