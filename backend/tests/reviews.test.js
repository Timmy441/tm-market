const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'test-only-value';

function mock(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

mock('../src/models/productModel', {});

// ---- in-memory stand-ins for the database layer ----
const users = {
  1: { first_name: 'ada', last_name: 'Okafor', email: 'ada@example.com', phone: '+2348031234567' },
  2: { first_name: 'Chidi', last_name: '', email: 'chidi@example.com', phone: '+2348039999999' },
  3: { first_name: 'Bola', last_name: 'Ade', email: 'bola@example.com', phone: '+2348030000000' }
};
let orders, order_items, product_reviews, nextId, boom;

function reset() {
  orders = [
    { id: 1, user_id: 1, seller_id: 10, status: 'delivered' },
    { id: 2, user_id: 1, seller_id: 10, status: 'shipped' },
    { id: 3, user_id: 1, seller_id: 10, status: 'pending' },
    { id: 4, user_id: 1, seller_id: 10, status: 'confirmed' },
    { id: 5, user_id: 1, seller_id: 11, status: 'delivered' },
    { id: 6, user_id: 3, seller_id: 10, status: 'delivered' }
  ];
  order_items = [
    { order_id: 1, product_id: 100 }, { order_id: 1, product_id: 101 },
    { order_id: 2, product_id: 100 }, { order_id: 3, product_id: 100 }, { order_id: 4, product_id: 100 },
    { order_id: 5, product_id: 100 },   // same product bought again in a second delivered order
    { order_id: 6, product_id: 100 }
  ];
  product_reviews = [];
  nextId = 1;
  boom = false;
}
reset();

mock('../src/models/reviewModel', {
  // Same contract as the real model: only the buyer's own order line is found.
  findOrderItemForBuyer: async (orderId, userId, productId) => {
    if (boom) throw new Error('db down');
    const o = orders.find(x => x.id === orderId && x.user_id === userId);
    const it = o && order_items.find(i => i.order_id === orderId && i.product_id === productId);
    return it ? { order_id: o.id, status: o.status, seller_id: o.seller_id, product_id: productId } : null;
  },
  // UNIQUE (order_id, product_id): a second review comes back as null.
  createReview: async ({ orderId, productId, sellerId, buyerId, rating, comment }) => {
    if (product_reviews.some(r => r.order_id === orderId && r.product_id === productId)) return null;
    const row = { id: nextId++, order_id: orderId, product_id: productId, seller_id: sellerId, buyer_id: buyerId, rating, comment, is_hidden: false, created_at: new Date() };
    product_reviews.push(row);
    return row;
  },
  listProductReviews: async (productId, limit, offset) => {
    const all = product_reviews.filter(r => r.product_id === productId && !r.is_hidden).sort((a, b) => b.id - a.id);
    const avg = all.length ? (all.reduce((t, r) => t + r.rating, 0) / all.length).toFixed(1) : null;
    return {
      reviews: all.slice(offset, offset + limit).map(r => ({ id: r.id, rating: r.rating, comment: r.comment, created_at: r.created_at, first_name: users[r.buyer_id].first_name, last_name: users[r.buyer_id].last_name })),
      count: all.length,
      average: avg
    };
  },
  listMyReviews: async userId => product_reviews.filter(r => r.buyer_id === userId).map(r => ({ order_id: r.order_id, product_id: r.product_id, rating: r.rating }))
});

const c = require('../src/controllers/reviewController');

const call = (handler, req) => new Promise(resolve => {
  const res = { status(x) { this.code = x; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
  handler({ params: {}, body: {}, query: {}, ...req }, res);
});

const ada = { id: 1 };
const bola = { id: 3 };
const send = (user, body) => call(c.submitReview, { user, body });

test('a buyer can review an item from their delivered order', async () => {
  reset();
  const r = await send(ada, { orderId: 1, productId: 100, rating: 5, comment: '  Fast delivery, great quality.  ' });
  assert.strictEqual(r.code, 201);
  assert.strictEqual(r.body.review.rating, 5);
  assert.strictEqual(r.body.review.comment, 'Fast delivery, great quality.');
  assert.strictEqual(product_reviews.length, 1);
  assert.strictEqual(product_reviews[0].buyer_id, 1);
  assert.strictEqual(product_reviews[0].seller_id, 10);   // taken from the order, never from the browser
});

test('only the buyer can review: someone else, or a missing order, gets 404 and nothing is saved', async () => {
  reset();
  assert.strictEqual((await send(bola, { orderId: 1, productId: 100, rating: 5 })).code, 404);   // order 1 belongs to Ada
  assert.strictEqual((await send(ada, { orderId: 999, productId: 100, rating: 5 })).code, 404);
  assert.strictEqual(product_reviews.length, 0);
});

test('the item must really be in that order', async () => {
  reset();
  assert.strictEqual((await send(ada, { orderId: 1, productId: 555, rating: 4 })).code, 404);
  assert.strictEqual((await send(ada, { orderId: 5, productId: 101, rating: 4 })).code, 404);
  assert.strictEqual(product_reviews.length, 0);
});

test('only delivered orders can be reviewed (pending, confirmed and shipped give 409)', async () => {
  reset();
  for (const id of [2, 3, 4]) {
    const r = await send(ada, { orderId: id, productId: 100, rating: 5 });
    assert.strictEqual(r.code, 409, `order ${id}`);
    assert.match(r.body.message, /delivered/);
  }
  assert.strictEqual(product_reviews.length, 0);
});

test('one review per item per order: a repeat gets 409 and the first review stays', async () => {
  reset();
  assert.strictEqual((await send(ada, { orderId: 1, productId: 100, rating: 5, comment: 'first' })).code, 201);
  const again = await send(ada, { orderId: 1, productId: 100, rating: 1, comment: 'changed my mind' });
  assert.strictEqual(again.code, 409);
  assert.strictEqual(product_reviews.length, 1);
  assert.strictEqual(product_reviews[0].rating, 5);
  assert.strictEqual(product_reviews[0].comment, 'first');
});

test('another item in the same order, or the same product bought again, can be reviewed', async () => {
  reset();
  assert.strictEqual((await send(ada, { orderId: 1, productId: 100, rating: 5 })).code, 201);
  assert.strictEqual((await send(ada, { orderId: 1, productId: 101, rating: 3 })).code, 201);
  assert.strictEqual((await send(ada, { orderId: 5, productId: 100, rating: 4 })).code, 201);   // second purchase, new review
  assert.strictEqual(product_reviews.length, 3);
});

test('bad ratings are rejected with 400', async () => {
  reset();
  for (const rating of [0, 6, -1, 2.5, 'abc', '', null, true, [], {}, undefined, 10, '55']) {
    const r = await send(ada, { orderId: 1, productId: 100, rating });
    assert.strictEqual(r.code, 400, JSON.stringify(rating));
  }
  assert.strictEqual(product_reviews.length, 0);
});

test('bad ids are rejected with 400', async () => {
  reset();
  for (const body of [{}, { orderId: 1 }, { productId: 100 }, { orderId: 'x', productId: 100 }, { orderId: 1, productId: -3 }, { orderId: 1.5, productId: 100 }]) {
    const r = await send(ada, { ...body, rating: 5 });
    assert.strictEqual(r.code, 400, JSON.stringify(body));
  }
});

test('comments: optional, trimmed, 1000 characters at most, text only', async () => {
  reset();
  assert.strictEqual((await send(ada, { orderId: 1, productId: 100, rating: 5, comment: 'x'.repeat(1001) })).code, 400);
  assert.strictEqual((await send(ada, { orderId: 1, productId: 100, rating: 5, comment: 12345 })).code, 400);
  assert.strictEqual((await send(ada, { orderId: 1, productId: 100, rating: 5, comment: { a: 1 } })).code, 400);
  assert.strictEqual(product_reviews.length, 0);

  const blank = await send(ada, { orderId: 1, productId: 100, rating: 4, comment: '   ' });
  assert.strictEqual(blank.code, 201);
  assert.strictEqual(blank.body.review.comment, null);

  const max = await send(ada, { orderId: 1, productId: 101, rating: 4, comment: 'y'.repeat(1000) });
  assert.strictEqual(max.code, 201);
});

test('a rating sent as a one-digit string is accepted', async () => {
  reset();
  assert.strictEqual((await send(ada, { orderId: 1, productId: 100, rating: '4' })).code, 201);
  assert.strictEqual(product_reviews[0].rating, 4);
});

test('the browser cannot choose the buyer, the seller or the hidden flag', async () => {
  reset();
  await send(ada, { orderId: 1, productId: 100, rating: 5, buyerId: 3, buyer_id: 3, sellerId: 99, seller_id: 99, isHidden: true, is_hidden: true });
  assert.strictEqual(product_reviews[0].buyer_id, 1);
  assert.strictEqual(product_reviews[0].seller_id, 10);
  assert.strictEqual(product_reviews[0].is_hidden, false);
});

test('reviewers show as "Ada O." and nothing else about them is public', async () => {
  reset();
  await send(ada, { orderId: 1, productId: 100, rating: 5, comment: 'Lovely' });
  await send(bola, { orderId: 6, productId: 100, rating: 3 });
  const r = await call(c.getProductReviews, { params: { id: '100' } });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(r.body.reviews.map(x => x.reviewer), ['Bola A.', 'Ada O.']);
  const raw = JSON.stringify(r.body);
  for (const secret of ['ada@example.com', 'bola@example.com', '+234', 'Okafor', 'buyer', 'email', 'phone', 'order_id', 'orderId', 'seller']) {
    assert.ok(!raw.includes(secret), `leaked: ${secret}`);
  }
  assert.deepStrictEqual(Object.keys(r.body.reviews[0]).sort(), ['comment', 'createdAt', 'id', 'rating', 'reviewer']);
});

test('reviewer names: capital letters, a single initial, no last name, no name at all', () => {
  assert.strictEqual(c.reviewerName('ada', 'okafor'), 'Ada O.');
  assert.strictEqual(c.reviewerName('  Ada ', ' Okafor '), 'Ada O.');
  assert.strictEqual(c.reviewerName('Chidi', ''), 'Chidi');
  assert.strictEqual(c.reviewerName('Chidi', null), 'Chidi');
  assert.strictEqual(c.reviewerName('', 'Okafor'), 'TM customer');
  assert.strictEqual(c.reviewerName(null, null), 'TM customer');
});

test('the product summary has the real average and count; no reviews means null, never an invented rating', async () => {
  reset();
  const none = await call(c.getProductReviews, { params: { id: '100' } });
  assert.deepStrictEqual(none.body.summary, { count: 0, average: null });
  assert.deepStrictEqual(none.body.reviews, []);

  await send(ada, { orderId: 1, productId: 100, rating: 5 });
  await send(ada, { orderId: 5, productId: 100, rating: 4 });
  await send(bola, { orderId: 6, productId: 100, rating: 4 });
  const r = await call(c.getProductReviews, { params: { id: '100' } });
  assert.deepStrictEqual(r.body.summary, { count: 3, average: 4.3 });
});

test('hidden reviews are left out of the list and the average', async () => {
  reset();
  await send(ada, { orderId: 1, productId: 100, rating: 1, comment: 'abusive text' });
  await send(bola, { orderId: 6, productId: 100, rating: 5 });
  product_reviews[0].is_hidden = true;
  const r = await call(c.getProductReviews, { params: { id: '100' } });
  assert.deepStrictEqual(r.body.summary, { count: 1, average: 5 });
  assert.ok(!JSON.stringify(r.body).includes('abusive'));
});

test('the review list is paged and capped at 20', async () => {
  reset();
  await send(ada, { orderId: 1, productId: 100, rating: 5 });
  await send(ada, { orderId: 5, productId: 100, rating: 4 });
  await send(bola, { orderId: 6, productId: 100, rating: 3 });
  const p1 = await call(c.getProductReviews, { params: { id: '100' }, query: { limit: '2' } });
  const p2 = await call(c.getProductReviews, { params: { id: '100' }, query: { limit: '2', page: '2' } });
  assert.strictEqual(p1.body.reviews.length, 2);
  assert.strictEqual(p2.body.reviews.length, 1);
  assert.strictEqual(p1.body.summary.count, 3);
  assert.strictEqual((await call(c.getProductReviews, { params: { id: '100' }, query: { limit: '999' } })).body.limit, 20);
});

test('a bad product id gives 404', async () => {
  assert.strictEqual((await call(c.getProductReviews, { params: { id: 'abc' } })).code, 404);
  assert.strictEqual((await call(c.getProductReviews, { params: { id: '-1' } })).code, 404);
});

test('"my reviews" lists only the logged-in buyer\'s own reviews', async () => {
  reset();
  await send(ada, { orderId: 1, productId: 100, rating: 5 });
  await send(bola, { orderId: 6, productId: 100, rating: 2 });
  const r = await call(c.myReviews, { user: ada });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(r.body.reviews, [{ orderId: 1, productId: 100, rating: 5 }]);
});

test('a database failure gives a plain 500 with no details', async () => {
  reset();
  boom = true;
  const r = await send(ada, { orderId: 1, productId: 100, rating: 5 });
  assert.strictEqual(r.code, 500);
  assert.ok(!JSON.stringify(r.body).includes('db down'));
  boom = false;
});

test('routes: reading reviews is public, writing and "mine" need a login', () => {
  const routes = [];
  const router = {};
  for (const m of ['get', 'post']) router[m] = (path, ...handlers) => routes.push({ method: m, path, handlers });
  const guard = () => {};
  mock('../src/middleware/authMiddleware', { authenticateToken: guard });
  // A tiny stand-in for express, so this test does not depend on the real package.
  const Module = require('module');
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'express' ? { Router: () => router } : realLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[require.resolve('../src/routes/reviewRoutes')];
    require('../src/routes/reviewRoutes');
  } finally {
    Module._load = realLoad;
  }

  const find = (m, p) => routes.find(r => r.method === m && r.path === p);
  assert.ok(!find('get', '/product/:id').handlers.includes(guard));
  assert.strictEqual(find('get', '/mine').handlers[0], guard);
  assert.strictEqual(find('post', '/').handlers[0], guard);
});

/* ---- store rating: the real sellerModel against a fake database ---- */

function loadSellerModel(query) {
  mock('../db', { query });
  delete require.cache[require.resolve('../src/models/sellerModel')];
  return require('../src/models/sellerModel');
}

test('the store page shows the real rating from visible reviews', async () => {
  const sm = loadSellerModel(async sql => {
    if (/FROM seller_profiles/.test(sql)) return { rows: [{ id: 1, user_id: 10, store_name: 'Ada Store' }] };
    if (/FROM products p/.test(sql)) return { rows: [] };
    if (/product_reviews/.test(sql)) {
      assert.match(sql, /is_hidden = FALSE/);
      return { rows: [{ count: 12, average: '4.6' }] };
    }
    throw new Error('unexpected query: ' + sql);
  });
  const store = await sm.getPublicSellerStore(10);
  assert.deepStrictEqual(store.rating, { average: 4.6, count: 12 });
});

test('a store with no reviews has no rating (count 0, average null)', async () => {
  const sm = loadSellerModel(async sql => {
    if (/FROM seller_profiles/.test(sql)) return { rows: [{ id: 1, user_id: 10, store_name: 'Ada Store' }] };
    if (/FROM products p/.test(sql)) return { rows: [] };
    return { rows: [{ count: 0, average: null }] };
  });
  assert.deepStrictEqual((await sm.getPublicSellerStore(10)).rating, { average: null, count: 0 });
});

test('the store page still loads if the reviews table does not exist yet', async () => {
  const sm = loadSellerModel(async sql => {
    if (/FROM seller_profiles/.test(sql)) return { rows: [{ id: 1, user_id: 10, store_name: 'Ada Store' }] };
    if (/FROM products p/.test(sql)) return { rows: [{ id: 7 }] };
    throw Object.assign(new Error('relation "product_reviews" does not exist'), { code: '42P01' });
  });
  const store = await sm.getPublicSellerStore(10);
  assert.strictEqual(store.seller.store_name, 'Ada Store');
  assert.strictEqual(store.products.length, 1);
  assert.deepStrictEqual(store.rating, { average: null, count: 0 });
});
