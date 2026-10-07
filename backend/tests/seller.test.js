const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'test-secret';
process.env.CLOUDINARY_CLOUD_NAME = 'democloud';
process.env.CLOUDINARY_API_KEY = 'key123';
process.env.CLOUDINARY_API_SECRET = 'secret456';

function mock(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// In-memory stand-ins for the DB layer (they enforce the same seller_id scoping the SQL does).
const products = [];
const users = { 1: { id: 1, first_name: 'Ada', last_name: 'Seller', email: 'a@x.com', role: 'seller', is_active: true },
                2: { id: 2, first_name: 'Bob', last_name: 'Other', email: 'b@x.com', role: 'seller', is_active: true } };
mock('../src/models/userModel', { findUserById: async id => users[id], findUserByEmail: async () => null, findUserByPhone: async () => null, createUser: async () => ({}) });
mock('../src/models/sellerModel', {
  findSellerByUserId: async () => null, updateSeller: async () => null,
  createSellerAndPromote: async () => ({ error: 'admin' }),
  getAuthState: async id => users[id] || null
});
mock('../src/models/productModel', {
  listProducts: async () => ({ products: [], total: 0 }), findProductById: async id => products.find(p => p.id === id) || null,
  createProduct: async () => 1, updateProduct: async () => true, deactivateProduct: async () => true, listCategories: async () => [],
  listSellerProducts: async sid => products.filter(p => p.seller_id === sid && p.status !== 'removed'),
  findSellerProduct: async (id, sid) => products.find(p => p.id === id && p.seller_id === sid) || null,
  createSellerProduct: async (sid, d) => { const p = { id: products.length + 1, seller_id: sid, status: d.status, ...d }; products.push(p); return p.id; },
  updateSellerProduct: async (id, sid, d) => { const p = products.find(x => x.id === id && x.seller_id === sid && x.status !== 'removed'); if (!p) return false; Object.assign(p, d); return true; },
  removeSellerProduct: async (id, sid) => { const p = products.find(x => x.id === id && x.seller_id === sid && x.status !== 'removed'); if (!p) return false; p.status = 'removed'; return true; }
});

const c = require('../src/controllers/sellerController');
const { requireSeller } = require('../src/middleware/authMiddleware');

const call = (handler, req) => new Promise(resolve => {
  const res = { status(x) { this.code = x; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
  handler({ params: {}, body: {}, ...req }, res);
});
const img = `https://res.cloudinary.com/democloud/image/upload/v1/tm-market/products/a.jpg`;
const good = { name: 'Blue Sneakers', price: '15000', categoryId: 2, itemCondition: 'new', location: 'Minna', quantity: 3, description: 'Nice', images: [{ imageUrl: img }] };

test('seller can create a listing; it is ACTIVE by default', async () => {
  const r = await call(c.createMyProduct, { user: { id: 1 }, body: good });
  assert.strictEqual(r.code, 201); assert.strictEqual(r.body.product.status, 'active');
  assert.strictEqual(r.body.product.seller_id, 1);
});

test('NEW_LISTING_STATUS=pending switches on approval with no code change', async () => {
  process.env.NEW_LISTING_STATUS = 'pending';
  const r = await call(c.createMyProduct, { user: { id: 1 }, body: good });
  assert.strictEqual(r.body.product.status, 'pending'); delete process.env.NEW_LISTING_STATUS;
});

test('validation rejects bad listings, including images from other hosts', async () => {
  for (const bad of [{ ...good, name: '' }, { ...good, price: 0 }, { ...good, price: 'abc' }, { ...good, categoryId: null },
    { ...good, itemCondition: undefined }, { ...good, itemCondition: 'broken' }, { ...good, itemCondition: 5 },
    { ...good, quantity: -1 }, { ...good, quantity: 1.5 }, { ...good, location: '' }, { ...good, images: [] },
    { ...good, images: [{ imageUrl: 'https://evil.example/x.jpg' }] }, { ...good, images: Array(6).fill({ imageUrl: img }) }]) {
    const r = await call(c.createMyProduct, { user: { id: 1 }, body: bad });
    assert.strictEqual(r.code, 400, JSON.stringify(bad).slice(0, 80));
  }
});

test('condition is saved (case-insensitive) and can be changed on update; a bad value is refused', async () => {
  let r = await call(c.createMyProduct, { user: { id: 1 }, body: { ...good, itemCondition: ' Repaired ' } });
  assert.strictEqual(r.code, 201); assert.strictEqual(r.body.product.itemCondition, 'repaired');
  const id = String(r.body.product.id);
  r = await call(c.updateMyProduct, { user: { id: 1 }, params: { id }, body: { itemCondition: 'used' } });
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.product.itemCondition, 'used');
  r = await call(c.updateMyProduct, { user: { id: 1 }, params: { id }, body: { itemCondition: 'mint' } });
  assert.strictEqual(r.code, 400);
  r = await call(c.updateMyProduct, { user: { id: 1 }, params: { id }, body: { price: 123 } });   // other edits do not need it
  assert.strictEqual(r.code, 200);
});

test("a seller cannot edit or delete another seller's product (404, unchanged)", async () => {
  const id = products[0].id;
  let r = await call(c.updateMyProduct, { user: { id: 2 }, params: { id: String(id) }, body: { price: 1 } });
  assert.strictEqual(r.code, 404); assert.strictEqual(products[0].price, 15000);
  r = await call(c.deleteMyProduct, { user: { id: 2 }, params: { id: String(id) } });
  assert.strictEqual(r.code, 404); assert.notStrictEqual(products[0].status, 'removed');
});

test('owner can update, mark sold, then delete; status cannot be forced to pending/removed', async () => {
  const id = String(products[0].id);
  let r = await call(c.updateMyProduct, { user: { id: 1 }, params: { id }, body: { price: 20000, status: 'sold' } });
  assert.strictEqual(r.code, 200); assert.strictEqual(products[0].status, 'sold');
  r = await call(c.updateMyProduct, { user: { id: 1 }, params: { id }, body: { status: 'pending' } });
  assert.strictEqual(r.code, 400);
  r = await call(c.updateMyProduct, { user: { id: 1 }, params: { id }, body: { seller_id: 2 } });
  assert.strictEqual(r.code, 400); assert.strictEqual(products[0].seller_id, 1);
  r = await call(c.deleteMyProduct, { user: { id: 1 }, params: { id } });
  assert.strictEqual(r.code, 200);
});

test('requireSeller checks the DATABASE role, not the token', async () => {
  users[3] = { id: 3, role: 'customer', is_active: true }; users[4] = { id: 4, role: 'seller', is_active: false };
  const run = id => new Promise(resolve => {
    const res = { status(x) { this.code = x; return this; }, json() { resolve(this.code); } };
    requireSeller({ user: { id, role: 'seller' } }, res, () => resolve('next'));   // token CLAIMS seller
  });
  assert.strictEqual(await run(3), 403);      // customer with a forged/stale seller token
  assert.strictEqual(await run(4), 403);      // suspended seller
  assert.strictEqual(await run(1), 'next');
  assert.strictEqual(await run(99), 403);     // unknown user
});

test('admins cannot become sellers', async () => {
  const r = await call(c.becomeSeller, { user: { id: 1 }, body: { storeName: 'Shop', location: 'Minna' } });
  assert.strictEqual(r.code, 400);
});

test('upload signature is a Cloudinary-style SHA1 and never exposes the secret', async () => {
  const r = await call(c.signUpload, { user: { id: 1 } });
  assert.strictEqual(r.code, 200); assert.match(r.body.signature, /^[a-f0-9]{40}$/);
  assert.ok(!JSON.stringify(r.body).includes('secret456'));
  const expected = require('crypto').createHash('sha1').update(`folder=${r.body.folder}&timestamp=${r.body.timestamp}secret456`).digest('hex');
  assert.strictEqual(r.body.signature, expected);
});
