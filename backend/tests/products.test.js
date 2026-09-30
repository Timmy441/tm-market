const test = require('node:test');
const assert = require('node:assert');
process.env.JWT_SECRET = 'test-secret';

let lastQuery = null;
const modelPath = require.resolve('../src/models/productModel');
require.cache[modelPath] = { id: modelPath, filename: modelPath, loaded: true, exports: {
  listProducts: async q => { lastQuery = q; return { products: [], total: 0 }; },
  findProductById: async id => (id === 1 ? { id: 1, is_active: true, status: 'active' } : id === 2 ? { id: 2, is_active: true, status: 'removed' } : id === 3 ? { id: 3, is_active: true, status: 'active', seller_active: false } : null),
  findProductContact: async id => (id === 1 ? { store_name: 'Ada Store', whatsapp: '+2348012345678' } : null),
  createProduct: async () => 1, updateProduct: async () => true, deactivateProduct: async () => true, listCategories: async () => []
}};
const c = require('../src/controllers/productController');
const call = (h, req) => new Promise(r => { const res = { status(x) { this.code = x; return this; }, json(b) { r({ code: this.code, body: b }); } }; h({ query: {}, params: {}, ...req }, res); });

test('filters are passed to the database layer', async () => {
  const r = await call(c.getProducts, { query: { search: 'shoe', category: 'Fashion, electronics', location: 'Minna', minPrice: '1000', maxPrice: '50000', sort: 'price_asc', page: '2', limit: '12' } });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(lastQuery.categorySlug, ['fashion', 'electronics']);
  assert.strictEqual(lastQuery.location, 'Minna'); assert.strictEqual(lastQuery.maxPrice, 50000);
  assert.strictEqual(lastQuery.sort, 'price_asc'); assert.strictEqual(lastQuery.offset, 12); assert.strictEqual(lastQuery.limit, 12);
});

test('bad price filter is rejected; limit is capped at 50', async () => {
  assert.strictEqual((await call(c.getProducts, { query: { maxPrice: 'abc' } })).code, 400);
  await call(c.getProducts, { query: { limit: '999' } });
  assert.strictEqual(lastQuery.limit, 50);
});

test('removed / missing products are not public', async () => {
  assert.strictEqual((await call(c.getProduct, { params: { id: '1' } })).code, 200);
  assert.strictEqual((await call(c.getProduct, { params: { id: '2' } })).code, 404);
  assert.strictEqual((await call(c.getProduct, { params: { id: '99' } })).code, 404);
  assert.strictEqual((await call(c.getProduct, { params: { id: '3' } })).code, 404); // seller suspended
});

test('seller contact lookup', async () => {
  const ok = await call(c.getProductContact, { params: { id: '1' } });
  assert.strictEqual(ok.body.contact.whatsapp, '+2348012345678');
  assert.strictEqual((await call(c.getProductContact, { params: { id: '5' } })).code, 404);
});
