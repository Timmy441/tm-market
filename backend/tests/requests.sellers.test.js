const test = require('node:test');
const assert = require('node:assert');

process.env.CLOUDINARY_CLOUD_NAME = 'democloud';

function mock(rel, exports) { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; }

/* ---- the real requestModel against a fake database: check the SQL it sends ---- */
const sent = [];
mock('../db', { query: async (sql, params) => { sent.push({ sql, params }); return { rows: [{ n: 3 }], rowCount: 1 }; } });
const model = require('../src/models/requestModel');

test('sellers only get approved requests, and the query never touches customer columns', async () => {
  sent.length = 0;
  await model.listForSellers({ limit: 20, offset: 0 });
  const all = sent.map(s => s.sql).join('\n');
  assert.match(all, /r\.status = 'approved'/);
  assert.doesNotMatch(all, /\busers\b|\bu\./i);          // no join to users at all
  assert.doesNotMatch(all, /email|phone|user_id|first_name|last_name/i);
  assert.doesNotMatch(all, /'pending'|'rejected'|'fulfilled'/);
});

test('removing a request deletes that one row and reports whether it existed', async () => {
  sent.length = 0;
  assert.strictEqual(await model.deleteRequest(7), true);
  assert.match(sent[0].sql, /DELETE FROM product_requests WHERE id = \$1/);
  assert.deepStrictEqual(sent[0].params, [7]);
});

/* ---- the controller with a stand-in model ---- */
let rowsForSellers = [{ id: 1, title: 'Blue case', description: 'for S24', status: 'approved', reviewed_at: '2026-10-20T10:00:00Z', images: ['https://res.cloudinary.com/democloud/x.jpg'] }];
let deleteResult = true, boom = false;
const deleted = [];
mock('../src/models/requestModel', {
  createRequest: async () => 1, countRecent: async () => ({ pending: 0, today: 0 }), listMine: async () => [], listPublic: async () => ({ requests: [], total: 0 }),
  listForSellers: async q => { if (boom) throw new Error('db down'); return { requests: rowsForSellers, total: rowsForSellers.length, q }; },
  listAdmin: async () => ({ requests: [], total: 0 }), summary: async () => ({ pending: 0 }), getAdmin: async () => null, setStatus: async () => true,
  deleteRequest: async id => { if (boom) throw new Error('db down'); deleted.push(id); return deleteResult; }
});
mock('../src/models/userModel', { findUserById: async () => ({}) });
mock('../src/utils/mailer', { mailConfigured: () => false, sendMail: async () => {} });
delete require.cache[require.resolve('../src/controllers/requestController')];
const c = require('../src/controllers/requestController');

const call = (h, req) => new Promise(r => { const res = { headersSent: false, status(x) { this.code = x; return this; }, json(b) { this.headersSent = true; r({ code: this.code, body: b }); } }; h({ body: {}, query: {}, params: {}, user: { id: 9 }, ...req }, res); });

test('the seller list returns requests with paging and no customer details', async () => {
  const r = await call(c.sellerRequests, {});
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.requests.length, 1);
  assert.deepStrictEqual(r.body.pagination, { page: 1, limit: 20, total: 1 });
  const raw = JSON.stringify(r.body);
  for (const k of ['email', 'phone', 'customer', 'user_id']) assert.ok(!raw.includes(k), k);
});

test('the seller list is paged and capped at 50', async () => {
  assert.strictEqual((await call(c.sellerRequests, { query: { limit: '999' } })).body.pagination.limit, 50);
  const p2 = await call(c.sellerRequests, { query: { limit: '10', page: '3' } });
  assert.strictEqual(p2.body.pagination.page, 3);
});

test('a database failure gives a plain 500', async () => {
  boom = true;
  const r = await call(c.sellerRequests, {});
  assert.strictEqual(r.code, 500);
  assert.ok(!JSON.stringify(r.body).includes('db down'));
  const d = await call(c.adminDelete, { params: { id: '3' } });
  assert.strictEqual(d.code, 500);
  boom = false;
});

test('admin can remove a request; bad or missing ids are refused', async () => {
  const log = console.log; console.log = () => {};
  try {
    assert.strictEqual((await call(c.adminDelete, { params: { id: '5' } })).code, 200);
    assert.deepStrictEqual(deleted, [5]);
    assert.strictEqual((await call(c.adminDelete, { params: { id: 'x' } })).code, 400);
    assert.strictEqual((await call(c.adminDelete, { params: { id: '0' } })).code, 400);
    deleteResult = false;
    assert.strictEqual((await call(c.adminDelete, { params: { id: '6' } })).code, 404);
  } finally { console.log = log; deleteResult = true; }
});

/* ---- routes ---- */
function loadRoutes(file, guards) {
  const routes = [];
  const router = { used: [] };
  for (const m of ['get', 'post', 'delete', 'put']) router[m] = (path, ...handlers) => routes.push({ method: m, path, handlers });
  router.use = (...h) => router.used.push(...h);
  mock('../src/middleware/authMiddleware', guards);
  const Module = require('module');
  const realLoad = Module._load;
  Module._load = function (request, ...rest) { return request === 'express' ? { Router: () => router } : realLoad.call(this, request, ...rest); };
  try { delete require.cache[require.resolve(file)]; require(file); } finally { Module._load = realLoad; }
  return { routes, router };
}

test('customer routes: sellers get the list, nobody gets a public list', () => {
  const authenticateToken = () => {}, requireSeller = () => {};
  const { routes } = loadRoutes('../src/routes/requestRoutes', { authenticateToken, requireSeller });
  const find = (m, p) => routes.find(r => r.method === m && r.path === p);
  assert.deepStrictEqual(find('get', '/seller').handlers.slice(0, 2), [authenticateToken, requireSeller]);
  assert.strictEqual(find('get', '/'), undefined);                               // the old public list is gone
  assert.strictEqual(find('get', '/mine').handlers[0], authenticateToken);
  assert.strictEqual(find('post', '/').handlers[0], authenticateToken);
});

test('admin routes: every route, including Remove, needs login and admin', () => {
  const authenticateToken = () => {}, requireAdmin = () => {};
  const { routes, router } = loadRoutes('../src/routes/requestAdminRoutes', { authenticateToken, requireAdmin });
  assert.deepStrictEqual(router.used, [authenticateToken, requireAdmin]);        // router.use runs before every route below
  const del = routes.find(r => r.method === 'delete' && r.path === '/:id');
  assert.ok(del, 'DELETE /:id exists');
  assert.strictEqual(del.handlers[0], c.adminDelete);
});
