const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'test-secret';

function mock(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// productController (used for number parsing) needs the product model; it is never queried here.
mock('../src/models/productModel', {});

// ---- in-memory stand-ins for the database layer ----
// products: 1,2 belong to seller 10 ; 3 belongs to seller 11 ; 4 sold ; 5 inactive seller ; 6 out of stock ; 7 sellerless ; 8 own product of buyer 1
const products = {
  1: { id: 1, name: 'Blue Sneakers', sku: null, price: '15000.00', status: 'active', is_active: true, seller_id: 10, seller_active: true, quantity: 5 },
  2: { id: 2, name: 'Phone Case', sku: null, price: '1999.99', status: 'active', is_active: true, seller_id: 10, seller_active: true, quantity: 100 },
  3: { id: 3, name: 'Desk Lamp', sku: null, price: '8000.00', status: 'active', is_active: true, seller_id: 11, seller_active: true, quantity: null },
  4: { id: 4, name: 'Sold Watch', sku: null, price: '20000.00', status: 'sold', is_active: true, seller_id: 10, seller_active: true, quantity: 1 },
  5: { id: 5, name: 'Ghost Item', sku: null, price: '500.00', status: 'active', is_active: true, seller_id: 12, seller_active: false, quantity: 1 },
  6: { id: 6, name: 'Empty Shelf', sku: null, price: '900.00', status: 'active', is_active: true, seller_id: 10, seller_active: true, quantity: 0 },
  7: { id: 7, name: 'Old Demo', sku: null, price: '900.00', status: 'active', is_active: true, seller_id: null, seller_active: null, quantity: 1 },
  8: { id: 8, name: 'My Own Thing', sku: null, price: '700.00', status: 'active', is_active: true, seller_id: 1, seller_active: true, quantity: 3 }
};
const stores = { 10: 'Ada Store', 11: 'Bola Store' };

const orders = [];
let pendingCount = 0;
let lastSellerQuery = null;

function toRow(o) { return { ...o }; }

mock('../src/models/orderModel', {
  getProductsForCheckout: async ids => ids.map(i => products[i]).filter(Boolean),
  countPendingOrders: async () => pendingCount,
  createOrders: async (userId, shipping, groups) => groups.map(g => {
    const o = {
      id: orders.length + 1, order_number: 'TM-TEST-' + (orders.length + 1), status: 'pending', user_id: userId, seller_id: g.sellerId,
      seller_name: stores[g.sellerId], subtotal: g.subtotal, shipping_fee: '0.00', discount: '0.00', total: g.subtotal,
      shipping_name: shipping.name, shipping_phone: shipping.phone, shipping_address: shipping.address,
      shipping_city: shipping.city, shipping_state: shipping.state, shipping_country: 'Nigeria', created_at: new Date(),
      items: g.items.map(i => ({ product_id: i.productId, name: i.name, quantity: i.quantity, unit_price: i.unitPrice, total_price: i.totalPrice }))
    };
    orders.push(o);
    return toRow(o);
  }),
  listMyOrders: async (userId, limit, offset) => { const mine = orders.filter(o => o.user_id === userId); return { orders: mine.slice(offset, offset + limit), total: mine.length }; },
  findMyOrder: async (id, userId) => orders.find(o => o.id === id && o.user_id === userId) || null,
  cancelMyOrder: async (id, userId) => { const o = orders.find(x => x.id === id && x.user_id === userId && x.status === 'pending'); if (!o) return false; o.status = 'cancelled'; return true; },
  listSellerOrders: async (sellerId, limit, offset) => {
    lastSellerQuery = { sellerId, limit, offset };
    const paid = orders.filter(o => o.seller_id === sellerId && ['confirmed', 'processing', 'shipped', 'delivered'].includes(o.status));
    return { orders: paid, total: paid.length };
  }
});

const c = require('../src/controllers/orderController');

const call = (handler, req) => new Promise(resolve => {
  const res = { status(x) { this.code = x; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
  handler({ params: {}, body: {}, query: {}, ...req }, res);
});

const shipping = { name: 'Chidi Okeke', phone: '0803 123 4567', address: '12 Market Road', city: 'Minna', state: 'Niger' };
const buyer = { id: 1 };
const place = (items, extra = {}, user = buyer) => call(c.createOrder, { user, body: { items, shipping, ...extra } });

test('a bag is split into one order per seller, priced from the database (browser prices are ignored)', async () => {
  const r = await place([
    { productId: 1, quantity: 2, price: 1 },          // browser claims the price is 1 naira
    { productId: 3, quantity: 1, price: 1, total: 1 },
    { productId: 2, quantity: 1 }
  ]);
  assert.strictEqual(r.code, 201);
  assert.strictEqual(r.body.orders.length, 2);
  const ada = r.body.orders.find(o => o.seller.id === 10);
  const bola = r.body.orders.find(o => o.seller.id === 11);
  assert.strictEqual(ada.items.length, 2);
  assert.strictEqual(ada.subtotal, 31999.99);   // 2 x 15000 + 1999.99
  assert.strictEqual(ada.total, 31999.99);
  assert.strictEqual(ada.status, 'pending');
  assert.strictEqual(ada.seller.storeName, 'Ada Store');
  assert.strictEqual(bola.total, 8000);
});

test('decimal prices never drift (1999.99 x 3)', async () => {
  const r = await place([{ productId: 2, quantity: 3 }]);
  assert.strictEqual(r.code, 201);
  assert.strictEqual(r.body.orders[0].total, 5999.97);
  assert.strictEqual(r.body.orders[0].items[0].unitPrice, 1999.99);
});

test('the same product listed twice is merged into one line', async () => {
  const r = await place([{ productId: 1, quantity: 1 }, { productId: 1, quantity: 2 }]);
  assert.strictEqual(r.code, 201);
  assert.strictEqual(r.body.orders[0].items.length, 1);
  assert.strictEqual(r.body.orders[0].items[0].quantity, 3);
});

test('the phone number is saved in the standard +234 format', async () => {
  const r = await place([{ productId: 3, quantity: 1 }]);
  assert.strictEqual(r.body.orders[0].shipping.phone, '+2348031234567');
});

test('unavailable items are refused with 409 and a clear reason', async () => {
  const cases = [
    [{ productId: 4, quantity: 1 }, /no longer available/],     // sold
    [{ productId: 5, quantity: 1 }, /no longer available/],     // seller suspended
    [{ productId: 7, quantity: 1 }, /no longer available/],     // no seller
    [{ productId: 999, quantity: 1 }, /no longer available/],   // does not exist
    [{ productId: 6, quantity: 1 }, /out of stock/],
    [{ productId: 1, quantity: 6 }, /Only 5 left/]
  ];
  for (const [item, re] of cases) {
    const r = await place([item]);
    assert.strictEqual(r.code, 409, JSON.stringify(item));
    assert.match(r.body.message, re);
  }
  const before = orders.length;
  const mixed = await place([{ productId: 1, quantity: 1 }, { productId: 4, quantity: 1 }]);
  assert.strictEqual(mixed.code, 409);
  assert.strictEqual(orders.length, before);   // nothing was created for the good item either
});

test('a seller cannot buy their own listing', async () => {
  const r = await place([{ productId: 8, quantity: 1 }]);
  assert.strictEqual(r.code, 409);
  assert.match(r.body.message, /your own listing/);
});

test('bad bags are rejected with 400', async () => {
  const bad = [
    undefined, null, [], 'x', {},
    [{ productId: 1, quantity: 0 }], [{ productId: 1, quantity: -1 }], [{ productId: 1, quantity: 1.5 }],
    [{ productId: 1, quantity: 'abc' }], [{ productId: 'abc', quantity: 1 }], [{ quantity: 1 }], [null],
    [{ productId: 1, quantity: 101 }],
    [{ productId: 1, quantity: 60 }, { productId: 1, quantity: 60 }],
    Array.from({ length: 21 }, (_, i) => ({ productId: i + 1, quantity: 1 }))
  ];
  for (const items of bad) {
    const r = await call(c.createOrder, { user: buyer, body: { items, shipping } });
    assert.strictEqual(r.code, 400, JSON.stringify(items)?.slice(0, 80));
  }
});

test('missing or invalid delivery details are rejected with 400', async () => {
  const items = [{ productId: 1, quantity: 1 }];
  const bad = [
    undefined, {}, { ...shipping, name: '' }, { ...shipping, name: 'A' }, { ...shipping, phone: '123' },
    { ...shipping, phone: undefined }, { ...shipping, address: 'abc' }, { ...shipping, city: '' },
    { ...shipping, state: 'x'.repeat(101) }, { ...shipping, address: 'x'.repeat(501) }
  ];
  for (const s of bad) {
    const r = await call(c.createOrder, { user: buyer, body: { items, shipping: s } });
    assert.strictEqual(r.code, 400, JSON.stringify(s)?.slice(0, 80));
  }
});

test('a buyer with too many unpaid orders is stopped', async () => {
  pendingCount = 20;
  const r = await place([{ productId: 1, quantity: 1 }]);
  assert.strictEqual(r.code, 400);
  assert.match(r.body.message, /too many unpaid orders/);
  pendingCount = 0;
});

test('a buyer sees only their own orders; other accounts get 404', async () => {
  const mineBefore = (await call(c.myOrders, { user: buyer })).body;
  assert.ok(mineBefore.orders.length > 0);
  assert.ok(mineBefore.orders.every(o => o.status));

  const other = { id: 2 };
  assert.strictEqual((await call(c.myOrders, { user: other })).body.orders.length, 0);

  const id = String(mineBefore.orders[0].id);
  assert.strictEqual((await call(c.getOrder, { user: buyer, params: { id } })).code, 200);
  assert.strictEqual((await call(c.getOrder, { user: other, params: { id } })).code, 404);
  assert.strictEqual((await call(c.getOrder, { user: buyer, params: { id: 'abc' } })).code, 404);
});

test('only the buyer can cancel, and only while unpaid', async () => {
  const mine = (await call(c.myOrders, { user: buyer })).body.orders;
  const id = String(mine[0].id);

  assert.strictEqual((await call(c.cancelOrder, { user: { id: 2 }, params: { id } })).code, 404);
  assert.strictEqual(orders[0].status, 'pending');

  assert.strictEqual((await call(c.cancelOrder, { user: buyer, params: { id } })).code, 200);
  assert.strictEqual(orders[0].status, 'cancelled');
  assert.strictEqual((await call(c.cancelOrder, { user: buyer, params: { id } })).code, 409);   // already cancelled

  orders[1].status = 'confirmed';   // pretend this one has been paid
  assert.strictEqual((await call(c.cancelOrder, { user: buyer, params: { id: String(orders[1].id) } })).code, 409);
  assert.strictEqual(orders[1].status, 'confirmed');
});

test('a seller only receives paid orders for their own account', async () => {
  const sellerId = orders[1].seller_id;
  const r = await call(c.sellerOrders, { user: { id: sellerId } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(lastSellerQuery.sellerId, sellerId);          // the controller uses the logged-in seller, nothing else
  assert.ok(r.body.orders.every(o => o.status !== 'pending' && o.status !== 'cancelled'));
  assert.strictEqual(r.body.orders.length, 1);

  const none = await call(c.sellerOrders, { user: { id: 999 } });
  assert.strictEqual(none.body.orders.length, 0);
});
