const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'test-only-value';

function mock(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

mock('../src/models/sellerModel', { getAuthState: async () => null });
mock('../src/models/userModel', { findUserById: async () => null });
mock('../src/models/productModel', { findProductById: async () => null });

const day = n => new Date(Date.now() + 3600000 + n * 86400000).toISOString().slice(0, 10);
let orders = [];
let lastList = null;
const audits = [];

const baseRow = over => ({
  id: 1, order_number: 'TM-A-1', status: 'confirmed', subtotal: '100.00', shipping_fee: '0', discount: '0', total: '100.00',
  shipping_name: 'Buyer', shipping_phone: '+2348031234567', shipping_address: '1 Road', shipping_city: 'Minna', shipping_state: 'Niger', shipping_country: 'Nigeria',
  created_at: new Date(), shipped_at: null, delivered_at: null, delivery_window_start: day(3), delivery_window_end: day(7),
  buyer_first_name: 'Chidi', buyer_last_name: 'Okeke', buyer_email: 'c@x.com', buyer_phone: '+2348031234567',
  seller_id: 10, seller_name: 'Ada Store', seller_email: 'ada@x.com',
  payment_status: 'successful', payment_reference: 'TM-1-REF', paid_at: new Date(),
  items: [{ name: 'Lamp', quantity: 2, unit_price: '50.00', total_price: '100.00' }], events: [], ...over
});
function reset() {
  orders = [baseRow({}), baseRow({ id: 2, status: 'shipped' }), baseRow({ id: 3, status: 'cancelled' }), baseRow({ id: 4, status: 'delivered' })];
}
reset();

mock('../src/models/adminModel', {
  listOrders: async q => { lastList = q; return { orders: orders.map(o => ({ ...o })), total: orders.length }; },
  getOrderDetail: async id => orders.find(o => o.id === id) || null,
  adminAdvanceOrder: async (id, status, from, note) => {
    const o = orders.find(x => x.id === id && from.includes(x.status));
    if (!o) return false;
    o.status = status; o.events.push({ status, note, at: new Date() });
    return true;
  },
  adminSetDeliveryWindow: async (id, a, b) => {
    const o = orders.find(x => x.id === id && ['confirmed', 'processing', 'shipped'].includes(x.status));
    if (!o) return false;
    o.delivery_window_start = a; o.delivery_window_end = b;
    return true;
  }
});

const c = require('../src/controllers/adminController');

// Capture the audit lines the controller prints (and keep them out of the test output).
const origLog = console.log;
console.log = line => {
  try { const j = JSON.parse(line); if (j && j.audit) { audits.push(j); return; } } catch { /* not JSON */ }
  origLog(line);
};

const call = (handler, req) => new Promise(resolve => {
  const res = { status(x) { this.code = x; return this; }, json(b) { resolve({ code: this.code || 200, body: b }); } };
  handler({ params: {}, body: {}, query: {}, user: { id: 1 }, ...req }, res);
});

test('the order list is formatted and filters are passed to the database layer', async () => {
  const r = await call(c.orders, { query: { status: 'overdue', search: ' TM-A ', page: '2', limit: '500' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.orders[0].orderNumber, 'TM-A-1');
  assert.strictEqual(r.body.orders[0].buyer.email, 'c@x.com');
  assert.strictEqual(lastList.status, 'overdue');
  assert.strictEqual(lastList.search, 'TM-A');
  assert.strictEqual(lastList.limit, 50);       // capped
  assert.strictEqual(lastList.offset, 50);
});

test('an invalid order filter is rejected with 400', async () => {
  assert.strictEqual((await call(c.orders, { query: { status: 'hacked' } })).code, 400);
});

test('order detail returns buyer, seller, payment, items and history; bad ids are handled', async () => {
  const r = await call(c.orderDetail, { params: { id: '1' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.order.payment.status, 'successful');
  assert.strictEqual(r.body.order.seller.storeName, 'Ada Store');
  assert.strictEqual(r.body.order.items[0].totalPrice, 100);
  assert.deepStrictEqual(r.body.order.deliveryWindow, { from: day(3), to: day(7) });
  assert.strictEqual((await call(c.orderDetail, { params: { id: 'x' } })).code, 400);
  assert.strictEqual((await call(c.orderDetail, { params: { id: '99' } })).code, 404);
});

test('admin can move an order forward and it is written to the audit log', async () => {
  reset(); audits.length = 0;
  let r = await call(c.changeOrderStatus, { params: { id: '1' }, body: { status: 'processing', note: 'Packing' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.order.status, 'processing');
  assert.strictEqual(r.body.order.events[0].note, 'TM Market support: Packing');

  r = await call(c.changeOrderStatus, { params: { id: '1' }, body: { status: 'shipped' } });
  assert.strictEqual(r.code, 200);

  r = await call(c.changeOrderStatus, { params: { id: '1' }, body: { status: 'delivered' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.order.events.at(-1).note, 'Marked as delivered by TM Market support');

  assert.deepStrictEqual(audits.map(a => a.action), ['order.status', 'order.status', 'order.status']);
  assert.strictEqual(audits[0].adminId, 1);
});

test('admin cannot skip steps, go backwards, cancel, or touch unpaid / cancelled orders', async () => {
  reset();
  const step = (id, status) => call(c.changeOrderStatus, { params: { id: String(id) }, body: { status } });
  assert.strictEqual((await step(1, 'delivered')).code, 409);   // paid but not shipped yet
  assert.strictEqual((await step(2, 'processing')).code, 409);  // already shipped
  assert.strictEqual((await step(3, 'shipped')).code, 409);     // cancelled
  assert.strictEqual((await step(4, 'shipped')).code, 409);     // delivered
  for (const s of ['cancelled', 'pending', 'confirmed', 'refunded', 7, undefined]) {
    assert.strictEqual((await step(1, s)).code, 400, String(s));
  }
  assert.strictEqual((await step(99, 'shipped')).code, 404);
  assert.strictEqual((await call(c.changeOrderStatus, { params: { id: '1' }, body: { status: 'processing', note: 'x'.repeat(201) } })).code, 400);
});

test('admin can set a valid delivery window; bad or late changes are refused', async () => {
  reset(); audits.length = 0;
  const ok = await call(c.changeOrderWindow, { params: { id: '1' }, body: { from: day(1), to: day(4) } });
  assert.strictEqual(ok.code, 200);
  assert.deepStrictEqual(ok.body.order.deliveryWindow, { from: day(1), to: day(4) });
  assert.strictEqual(audits[0].action, 'order.window');

  for (const body of [{ from: day(-2), to: day(3) }, { from: day(5), to: day(2) }, { from: day(1), to: day(60) }, { from: 'a', to: 'b' }, {}]) {
    assert.strictEqual((await call(c.changeOrderWindow, { params: { id: '1' }, body })).code, 400, JSON.stringify(body));
  }
  assert.strictEqual((await call(c.changeOrderWindow, { params: { id: '4' }, body: { from: day(1), to: day(3) } })).code, 409); // delivered
  assert.strictEqual((await call(c.changeOrderWindow, { params: { id: '99' }, body: { from: day(1), to: day(3) } })).code, 404);
});

test('the admin order routes sit behind the admin check', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/routes/adminRoutes.js'), 'utf8');
  const guard = src.indexOf('router.use(authenticateToken, requireAdmin)');
  assert.ok(guard > -1, 'the shared admin guard exists');
  for (const route of ["router.get('/orders'", "router.get('/orders/:id'", "router.post('/orders/:id/status'", "router.put('/orders/:id/delivery-window'"]) {
    const at = src.indexOf(route);
    assert.ok(at > guard, `${route} is registered after the admin guard`);
  }
});
