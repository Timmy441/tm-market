const test = require('node:test');
const assert = require('node:assert');

process.env.CLOUDINARY_CLOUD_NAME = 'democloud';
process.env.CLOUDINARY_API_KEY = 'key123';
process.env.CLOUDINARY_API_SECRET = 'secret456';
process.env.BREVO_API_KEY = 'fake';
process.env.MAIL_FROM_EMAIL = 'sender@example.com';
process.env.ADMIN_NOTIFY_EMAIL = 'boss@example.com';
process.env.ADMIN_URL = 'https://admin.example/';

function mock(rel, exports) { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; }

const rows = []; let counts = { pending: 0, today: 0 }; const statusCalls = []; const mails = []; let mailFails = false;
mock('../src/models/requestModel', {
  createRequest: async (uid, d) => { rows.push({ uid, ...d }); return rows.length; },
  countRecent: async () => counts,
  listMine: async uid => rows.filter(r => r.uid === uid), listPublic: async () => ({ requests: [], total: 0 }),
  listAdmin: async q => ({ requests: [], total: 0, q }), summary: async () => ({ pending: 2 }),
  getAdmin: async id => (id === 1 ? { id: 1 } : null),
  setStatus: async (id, status, note, admin) => { statusCalls.push({ id, status, note, admin }); return id === 1; }
});
mock('../src/models/userModel', { findUserById: async () => ({ first_name: 'Ada', last_name: 'L', email: 'ada@x.com', phone: '08011111111' }) });
mock('../src/utils/mailer', { mailConfigured: () => true, sendMail: async m => { if (mailFails) throw new Error('boom'); mails.push(m); } });

const c = require('../src/controllers/requestController');
const call = (h, req) => new Promise(r => { const res = { headersSent: false, status(x) { this.code = x; return this; }, json(b) { this.headersSent = true; r({ code: this.code, body: b }); } }; h({ body: {}, query: {}, params: {}, ...req }, res); });
const tick = () => new Promise(r => setTimeout(r, 20));
const img = 'https://res.cloudinary.com/democloud/image/upload/v1/tm-market/requests/a.jpg';
const good = { title: 'Samsung Galaxy S24 case', description: 'A clear case for my Galaxy S24, blue edges.', categoryId: 2, budget: '8000', location: 'Minna', images: [img] };

test('a customer request is saved as pending at once and the admin gets an email', async () => {
  const r = await call(c.submitRequest, { user: { id: 1 }, body: good }); await tick();
  assert.strictEqual(r.code, 201); assert.strictEqual(r.body.request.status, 'pending');
  assert.strictEqual(mails.length, 1); assert.strictEqual(mails[0].to, 'boss@example.com');
  assert.match(mails[0].subject, /New product request/); assert.ok(mails[0].text.includes('https://admin.example'));
  assert.ok(mails[0].text.includes('ada@x.com'));
});

test('a failing email never blocks or breaks the customer request', async () => {
  mailFails = true; const r = await call(c.submitRequest, { user: { id: 1 }, body: good }); await tick(); mailFails = false;
  assert.strictEqual(r.code, 201);
});

test('customer text is escaped in the admin email', async () => {
  mails.length = 0;
  await call(c.submitRequest, { user: { id: 1 }, body: { ...good, title: '<script>alert(1)</script> phone' } }); await tick();
  assert.ok(!mails[0].html.includes('<script>')); assert.ok(mails[0].html.includes('&lt;script&gt;'));
});

test('a photo is required, and only our own Cloudinary photos are accepted', async () => {
  for (const images of [undefined, [], ['https://evil.example/a.jpg'], Array(5).fill(img), [img, 'http://x']]) {
    const r = await call(c.submitRequest, { user: { id: 1 }, body: { ...good, images } });
    assert.strictEqual(r.code, 400, JSON.stringify(images));
  }
});

test('bad titles, descriptions, budgets and categories are rejected', async () => {
  for (const patch of [{ title: 'ab' }, { title: 'x'.repeat(121) }, { description: 'short' }, { description: 'x'.repeat(1001) }, { budget: -5 }, { budget: 'abc' }, { categoryId: 'x' }, { location: 'x'.repeat(151) }]) {
    assert.strictEqual((await call(c.submitRequest, { user: { id: 1 }, body: { ...good, ...patch } })).code, 400, JSON.stringify(patch));
  }
});

test('spam limits: too many waiting, or too many today', async () => {
  counts = { pending: 5, today: 1 }; assert.strictEqual((await call(c.submitRequest, { user: { id: 1 }, body: good })).code, 429);
  counts = { pending: 0, today: 10 }; assert.strictEqual((await call(c.submitRequest, { user: { id: 1 }, body: good })).code, 429);
  counts = { pending: 0, today: 0 };
});

test('admin can approve, reject with a note, and mark fulfilled; bad input is refused', async () => {
  const log = console.log; console.log = () => {};
  try {
    assert.strictEqual((await call(c.adminSetStatus, { user: { id: 9 }, params: { id: '1' }, body: { status: 'approved' } })).code, 200);
    assert.strictEqual((await call(c.adminSetStatus, { user: { id: 9 }, params: { id: '1' }, body: { status: 'rejected', note: 'Not allowed on the platform' } })).code, 200);
    assert.strictEqual((await call(c.adminSetStatus, { user: { id: 9 }, params: { id: '1' }, body: { status: 'fulfilled' } })).code, 200);
  } finally { console.log = log; }
  assert.deepStrictEqual(statusCalls.map(s => s.status), ['approved', 'rejected', 'fulfilled']);
  assert.strictEqual(statusCalls[1].note, 'Not allowed on the platform'); assert.strictEqual(statusCalls[0].admin, 9);
  assert.strictEqual((await call(c.adminSetStatus, { user: { id: 9 }, params: { id: '1' }, body: { status: 'deleted' } })).code, 400);
  assert.strictEqual((await call(c.adminSetStatus, { user: { id: 9 }, params: { id: 'x' }, body: { status: 'approved' } })).code, 400);
  assert.strictEqual((await call(c.adminSetStatus, { user: { id: 9 }, params: { id: '5' }, body: { status: 'approved' } })).code, 404);
  assert.strictEqual((await call(c.adminSetStatus, { user: { id: 9 }, params: { id: '1' }, body: { status: 'approved', note: 'x'.repeat(501) } })).code, 400);
});

test('admin list validates the status filter; detail 404 and summary work', async () => {
  assert.strictEqual((await call(c.adminList, { query: { status: 'nope' } })).code, 400);
  assert.strictEqual((await call(c.adminList, { query: { status: 'pending', limit: '999' } })).body.pagination.limit, 50);
  assert.strictEqual((await call(c.adminDetail, { params: { id: '2' } })).code, 404);
  assert.strictEqual((await call(c.adminSummary, {})).body.summary.pending, 2);
});

test('photo upload signature never exposes the secret', async () => {
  const r = await call(c.signRequestUpload, { user: { id: 1 } });
  assert.strictEqual(r.body.folder, 'tm-market/requests'); assert.ok(!JSON.stringify(r.body).includes('secret456'));
});
