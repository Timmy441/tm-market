const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'test-secret';
const jwt = require('jsonwebtoken');

function mock(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// In-memory "database": the middleware must trust THIS, never the token.
const db = {
  users: {
    1: { id: 1, first_name: 'Ada', last_name: 'Admin', email: 'ada@x.com', role: 'admin', is_active: true },
    2: { id: 2, first_name: 'Cus', last_name: 'Tomer', email: 'c@x.com', role: 'customer', is_active: true },
    3: { id: 3, first_name: 'Sel', last_name: 'Ler', email: 's@x.com', role: 'seller', is_active: true },
    4: { id: 4, first_name: 'Sus', last_name: 'Pended', email: 'p@x.com', role: 'admin', is_active: false },
    5: { id: 5, first_name: 'Dem', last_name: 'Oted', email: 'd@x.com', role: 'customer', is_active: true }
  }
};
let lastQuery = null;

mock('../src/models/sellerModel', { getAuthState: async id => db.users[id] || null });
mock('../src/models/userModel', { findUserById: async id => db.users[id] || null });
mock('../src/models/productModel', { findProductById: async id => (id === 7 ? { id: 7, name: 'Shoes', status: 'pending', images: [] } : null) });
mock('../src/models/adminModel', {
  getStats: async () => ({ users: { total: 5 }, products: { total: 0 }, recentProducts: [], orders: null }),
  getDailyCounts: async () => [{ date: '2026-09-30', count: 0 }],
  listUsers: async q => { lastQuery = q; return { users: [], total: 0 }; },
  getUserDetail: async id => (db.users[id] ? { user: db.users[id], seller: null, products: { active: 0, pending: 0, sold: 0, removed: 0 } } : null),
  setUserActive: async id => {
    const u = db.users[id];
    if (!u) return { status: 'not_found' };
    if (u.role === 'admin') return { status: 'admin' };
    return { status: 'ok', user: { id, is_active: false } };
  },
  listProducts: async q => { lastQuery = q; return { products: [], total: 0 }; },
  setProductStatus: async (id, status) => (id === 7 ? { id, status } : null)
});

const { authenticateToken, requireAdmin } = require('../src/middleware/authMiddleware');
const c = require('../src/controllers/adminController');

const token = (userId, role, secret = 'test-secret') => jwt.sign({ userId, role }, secret, { expiresIn: '1h' });

// Runs authenticateToken then requireAdmin like the real route does.
function through(authorization) {
  return new Promise(resolve => {
    const req = { headers: authorization ? { authorization } : {} };
    const res = { status(x) { this.code = x; return this; }, json(b) { resolve({ passed: false, code: this.code, body: b }); } };
    authenticateToken(req, res, () => requireAdmin(req, res, () => resolve({ passed: true, req })));
  });
}
const call = (h, req) => new Promise(r => {
  const res = { status(x) { this.code = x; return this; }, json(b) { r({ code: this.code || 200, body: b }); } };
  h({ query: {}, params: {}, body: {}, user: { id: 1 }, ...req }, res);
});

test('no token is rejected with 401', async () => {
  assert.strictEqual((await through()).code, 401);
});

test('a token signed with the wrong secret (forged) is rejected with 401', async () => {
  assert.strictEqual((await through('Bearer ' + token(1, 'admin', 'attacker-secret'))).code, 401);
});

test('a customer and a seller cannot reach admin routes (403)', async () => {
  assert.strictEqual((await through('Bearer ' + token(2, 'customer'))).code, 403);
  assert.strictEqual((await through('Bearer ' + token(3, 'seller'))).code, 403);
});

test('a token that CLAIMS admin but the database says customer is rejected', async () => {
  assert.strictEqual((await through('Bearer ' + token(5, 'admin'))).code, 403);
});

test('a suspended admin is rejected even with a valid token', async () => {
  const r = await through('Bearer ' + token(4, 'admin'));
  assert.strictEqual(r.code, 403);
  assert.strictEqual(r.body.message, 'This account is inactive');
});

test('a token for a deleted user is rejected with 401', async () => {
  assert.strictEqual((await through('Bearer ' + token(999, 'admin'))).code, 401);
});

test('a real admin gets through', async () => {
  const r = await through('Bearer ' + token(1, 'admin'));
  assert.strictEqual(r.passed, true);
  assert.strictEqual(r.req.user.role, 'admin');
});

test('authenticateToken also blocks suspended ordinary users everywhere', async () => {
  db.users[2].is_active = false;
  const r = await new Promise(resolve => {
    const res = { status(x) { this.code = x; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    authenticateToken({ headers: { authorization: 'Bearer ' + token(2, 'customer') } }, res, () => resolve({ code: 200 }));
  });
  db.users[2].is_active = true;
  assert.strictEqual(r.code, 403);
});

test('me returns the admin without any password data', async () => {
  const r = await call(c.me, {});
  assert.strictEqual(r.code, 200);
  assert.ok(!('password_hash' in r.body.admin));
  assert.strictEqual(r.body.admin.email, 'ada@x.com');
});

test('stats passes real numbers through and keeps orders honest (null = not available)', async () => {
  const r = await call(c.stats, {});
  assert.strictEqual(r.body.stats.users.total, 5);
  assert.strictEqual(r.body.stats.orders, null);
});

test('user list: filters validated, page size capped at 50', async () => {
  assert.strictEqual((await call(c.users, { query: { role: 'king' } })).code, 400);
  assert.strictEqual((await call(c.users, { query: { status: 'banned' } })).code, 400);
  await call(c.users, { query: { limit: '999', page: '3', search: '  ada ', status: 'suspended' } });
  assert.strictEqual(lastQuery.limit, 50);
  assert.strictEqual(lastQuery.offset, 100);
  assert.strictEqual(lastQuery.search, 'ada');
});

test('user detail: bad id 400, unknown 404, found 200', async () => {
  assert.strictEqual((await call(c.userDetail, { params: { id: 'abc' } })).code, 400);
  assert.strictEqual((await call(c.userDetail, { params: { id: '404' } })).code, 404);
  assert.strictEqual((await call(c.userDetail, { params: { id: '3' } })).code, 200);
});

test('suspending: customer ok, admin refused, unknown 404, bad id 400', async () => {
  assert.strictEqual((await call(c.suspendUser, { params: { id: '2' } })).code, 200);
  assert.strictEqual((await call(c.suspendUser, { params: { id: '1' } })).code, 403); // an admin cannot suspend themselves or other admins
  assert.strictEqual((await call(c.suspendUser, { params: { id: '404' } })).code, 404);
  assert.strictEqual((await call(c.suspendUser, { params: { id: '0' } })).code, 400);
});

test('product status: only the four real statuses are accepted', async () => {
  assert.strictEqual((await call(c.changeProductStatus, { params: { id: '7' }, body: { status: 'deleted' } })).code, 400);
  assert.strictEqual((await call(c.changeProductStatus, { params: { id: '7' }, body: {} })).code, 400);
  assert.strictEqual((await call(c.changeProductStatus, { params: { id: '7' }, body: { status: 'active' } })).code, 200);
  assert.strictEqual((await call(c.changeProductStatus, { params: { id: '7' }, body: { status: 'removed' } })).code, 200);
  assert.strictEqual((await call(c.changeProductStatus, { params: { id: '8' }, body: { status: 'active' } })).code, 404);
});

test('product list filter validated; admin can open a pending product', async () => {
  assert.strictEqual((await call(c.products, { query: { status: 'weird' } })).code, 400);
  assert.strictEqual((await call(c.products, { query: { status: 'pending' } })).code, 200);
  assert.strictEqual((await call(c.productDetail, { params: { id: '7' } })).body.product.status, 'pending');
  assert.strictEqual((await call(c.productDetail, { params: { id: '8' } })).code, 404);
});
