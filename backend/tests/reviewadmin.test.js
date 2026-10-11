const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

process.env.JWT_SECRET = 'test-only-value';

function mock(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

mock('../src/models/productModel', {});

// ---- in-memory stand-in for the database layer ----
let reviews, boom, lastList;

function reset() {
  reviews = [
    { id: 1, rating: 5, comment: 'top notch', is_hidden: false, created_at: new Date('2026-10-11T13:41:00Z'), product_id: 3, order_id: 14, product_name: 'pencil', seller_name: 'Jay joys', first_name: 'Florence', last_name: 'Babalola', email: 'f@example.com' },
    { id: 2, rating: 1, comment: 'abusive words here', is_hidden: false, created_at: new Date('2026-10-10T09:00:00Z'), product_id: 4, order_id: 15, product_name: 'mouse', seller_name: 'Ada Store', first_name: null, last_name: null, email: null },
    { id: 3, rating: 3, comment: null, is_hidden: true, created_at: new Date('2026-10-09T09:00:00Z'), product_id: null, order_id: 16, product_name: null, seller_name: null, first_name: 'Chidi', last_name: '', email: 'c@example.com' }
  ];
  boom = false;
  lastList = null;
}
reset();

mock('../src/models/reviewModel', {
  adminListReviews: async args => {
    if (boom) throw new Error('db down');
    lastList = args;
    let list = reviews.slice();
    if (args.visibility === 'hidden') list = list.filter(r => r.is_hidden);
    if (args.visibility === 'visible') list = list.filter(r => !r.is_hidden);
    return { reviews: list.slice(args.offset, args.offset + args.limit), total: list.length, hiddenCount: reviews.filter(r => r.is_hidden).length };
  },
  adminSetReviewHidden: async (id, hidden) => {
    if (boom) throw new Error('db down');
    const r = reviews.find(x => x.id === id);
    if (!r) return null;
    r.is_hidden = hidden;
    return { id: r.id, is_hidden: r.is_hidden };
  }
});

const c = require('../src/controllers/reviewController');

const call = (handler, req) => new Promise(resolve => {
  const res = { status(x) { this.code = x; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
  handler({ params: {}, body: {}, query: {}, user: { id: 99, role: 'admin' }, ...req }, res);
});

const quietly = async fn => {
  const orig = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = orig; }
};

test('the admin list shows every review with who wrote it, what it is about and whether it is hidden', async () => {
  const r = await call(c.adminList, {});
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.total, 3);
  assert.strictEqual(r.body.hiddenCount, 1);
  assert.strictEqual(r.body.page, 1);
  assert.strictEqual(r.body.limit, 20);

  const [a, b, h] = r.body.reviews;
  assert.deepStrictEqual(a, {
    id: 1, rating: 5, comment: 'top notch', hidden: false, createdAt: reviews[0].created_at,
    product: { id: 3, name: 'pencil' }, seller: 'Jay joys',
    reviewer: { name: 'Florence Babalola', email: 'f@example.com' }, orderId: 14
  });
  assert.strictEqual(b.reviewer.name, null, 'a missing name stays empty, nothing is invented');
  assert.strictEqual(b.reviewer.email, null);
  assert.strictEqual(h.hidden, true);
  assert.strictEqual(h.comment, null);
  assert.strictEqual(h.product.id, null);
  assert.strictEqual(h.reviewer.name, 'Chidi');
});

test('filters, search and paging are passed on safely', async () => {
  let r = await call(c.adminList, { query: { status: 'hidden' } });
  assert.deepStrictEqual(r.body.reviews.map(x => x.id), [3]);
  r = await call(c.adminList, { query: { status: 'visible' } });
  assert.deepStrictEqual(r.body.reviews.map(x => x.id), [1, 2]);

  assert.strictEqual((await call(c.adminList, { query: { status: 'deleted' } })).code, 400);
  assert.strictEqual((await call(c.adminList, { query: { status: ['hidden'] } })).code, 400);

  await call(c.adminList, { query: { limit: '500', page: '3', search: `  ${'x'.repeat(300)}  ` } });
  assert.strictEqual(lastList.limit, 50, 'limit is capped');
  assert.strictEqual(lastList.offset, 100);
  assert.strictEqual(lastList.search.length, 100, 'search text is trimmed and capped');

  await call(c.adminList, { query: { limit: 'abc', page: '-2', search: { $ne: 1 } } });
  assert.strictEqual(lastList.limit, 20);
  assert.strictEqual(lastList.offset, 0);
  assert.strictEqual(lastList.search, '', 'a non-text search is ignored');
});

test('hiding sets the hidden flag (never deletes), showing it again clears it, and both are logged with the admin', async () => {
  const logs = [];
  const orig = console.log;
  console.log = line => logs.push(line);
  try {
    let r = await call(c.adminHide, { params: { id: '2' } });
    assert.strictEqual(r.code, 200);
    assert.deepStrictEqual(r.body, { success: true, review: { id: 2, hidden: true } });
    assert.strictEqual(reviews[1].is_hidden, true);

    r = await call(c.adminUnhide, { params: { id: '2' } });
    assert.strictEqual(r.code, 200);
    assert.deepStrictEqual(r.body.review, { id: 2, hidden: false });
    assert.strictEqual(reviews[1].is_hidden, false);
  } finally {
    console.log = orig;
  }

  // Both actions leave a trail in the server log, naming the admin.
  const entries = logs.map(l => JSON.parse(l));
  assert.deepStrictEqual(entries.map(e => e.action), ['review.hide', 'review.unhide']);
  entries.forEach(e => {
    assert.strictEqual(e.audit, true);
    assert.strictEqual(e.adminId, 99);
    assert.strictEqual(e.targetType, 'review');
    assert.strictEqual(e.targetId, 2);
  });
  reset();
});

test('bad ids and unknown reviews are refused, and nothing is deleted', async () => {
  for (const id of ['abc', '0', '-1', '1.5', '', undefined]) {
    assert.strictEqual((await call(c.adminHide, { params: { id } })).code, 400, String(id));
    assert.strictEqual((await call(c.adminUnhide, { params: { id } })).code, 400, String(id));
  }
  assert.strictEqual((await call(c.adminHide, { params: { id: '999' } })).code, 404);
  assert.strictEqual((await call(c.adminUnhide, { params: { id: '999' } })).code, 404);
  assert.strictEqual(reviews.length, 3, 'hiding never deletes a review');
});

test('database errors give a plain 500 and leak nothing', async () => {
  boom = true;
  for (const [fn, req] of [[c.adminList, {}], [c.adminHide, { params: { id: '1' } }], [c.adminUnhide, { params: { id: '1' } }]]) {
    const r = await quietly(() => call(fn, req));
    assert.strictEqual(r.code, 500);
    assert.ok(!JSON.stringify(r.body).includes('db down'));
  }
  boom = false;
});

/* ---------------- wiring ---------------- */

test('the review moderation routes sit behind the admin check', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/adminRoutes.js'), 'utf8');
  const guard = src.indexOf('router.use(authenticateToken, requireAdmin)');
  assert.ok(guard > -1, 'the shared admin guard exists');
  for (const route of ["router.get('/reviews'", "router.post('/reviews/:id/hide'", "router.post('/reviews/:id/unhide'"]) {
    const at = src.indexOf(route);
    assert.ok(at > guard, `${route} is registered after the admin guard`);
  }
});

test('the public review lists and ratings still ignore hidden reviews', () => {
  const model = fs.readFileSync(path.join(__dirname, '../src/models/reviewModel.js'), 'utf8');
  const seller = fs.readFileSync(path.join(__dirname, '../src/models/sellerModel.js'), 'utf8');
  assert.ok(/WHERE r\.product_id = \$1 AND r\.is_hidden = FALSE/.test(model));
  assert.ok(/product_id = \$1 AND is_hidden = FALSE/.test(model));
  assert.ok(/seller_id = \$1 AND is_hidden = FALSE/.test(seller));
});
