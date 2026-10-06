const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'test-secret';
process.env.CLOUDINARY_CLOUD_NAME = 'democloud';
process.env.CLOUDINARY_API_KEY = 'key123';
process.env.CLOUDINARY_API_SECRET = 'secret456';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
function mock(rel, exports) { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; }

const users = {
  1: { id: 1, first_name: 'Ada', last_name: 'Seller', email: 'a@x.com', phone: '08011111111', phone_normalized: '+2348011111111', role: 'customer', is_active: true, password_hash: bcrypt.hashSync('oldpassword', 4), password_changed_at: null },
  2: { id: 2, first_name: 'Bob', last_name: 'Other', email: 'b@x.com', phone: '08022222222', phone_normalized: '+2348022222222', role: 'customer', is_active: true, password_hash: 'x', password_changed_at: null },
  3: { id: 3, first_name: 'Old', last_name: 'User', email: 'c@x.com', phone: null, phone_normalized: null, role: 'customer', is_active: true, password_hash: 'x', password_changed_at: null }
};
let raceOnce = false;
mock('../src/models/userModel', {
  findUserById: async id => users[id] || null,
  findUserByEmail: async () => null,
  createUser: async () => ({}),
  findUserByPhone: async (p, except) => Object.values(users).find(u => u.phone_normalized === p && u.id !== except) || null,
  updateProfile: async (id, f) => {
    if (raceOnce) { raceOnce = false; const e = new Error('dup'); e.code = '23505'; throw e; }
    const u = users[id]; const m = { firstName: 'first_name', lastName: 'last_name', phone: 'phone', phoneNormalized: 'phone_normalized', address: 'address', location: 'location', bio: 'bio', avatarUrl: 'avatar_url' };
    for (const [k, col] of Object.entries(m)) if (f[k] !== undefined) u[col] = f[k];
    return u;
  },
  getPasswordHash: async id => users[id].password_hash,
  setPassword: async (id, hash) => { users[id].password_hash = hash; users[id].password_changed_at = new Date(); }
});
mock('../src/models/sellerModel', { getAuthState: async id => (users[id] ? { id, role: users[id].role, is_active: users[id].is_active, password_changed_at: users[id].password_changed_at } : null) });

const c = require('../src/controllers/profileController');
const { authenticateToken } = require('../src/middleware/authMiddleware');
const call = (h, req) => new Promise(r => { const res = { status(x) { this.code = x; return this; }, json(b) { r({ code: this.code, body: b }); } }; h({ body: {}, ...req }, res); });
const cloud = 'https://res.cloudinary.com/democloud/image/upload/v1/tm-market/avatars/a.jpg';

test('profile saves name, phone, address; phone is normalised', async () => {
  const r = await call(c.saveProfile, { user: { id: 1 }, body: { name: 'Ada Lovelace', phone: '+234 802 333 4444', address: '12 Main St, Minna' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(users[1].first_name, 'Ada'); assert.strictEqual(users[1].last_name, 'Lovelace');
  assert.strictEqual(users[1].phone_normalized, '+2348023334444'); assert.strictEqual(r.body.user.address, '12 Main St, Minna');
});

test("another user's phone is refused in any format; own number is fine", async () => {
  for (const phone of ['08022222222', '+2348022222222', '2348022222222']) {
    const r = await call(c.saveProfile, { user: { id: 1 }, body: { phone } });
    assert.strictEqual(r.code, 409); assert.strictEqual(r.body.message, 'This phone number is already registered.');
  }
  assert.strictEqual((await call(c.saveProfile, { user: { id: 2 }, body: { phone: '0802 222 2222' } })).code, 200);
});

test('database race on phone becomes a friendly 409', async () => {
  raceOnce = true;
  const r = await call(c.saveProfile, { user: { id: 1 }, body: { phone: '09055555555' } });
  assert.strictEqual(r.code, 409);
});

test('invalid input is rejected; phone cannot be removed once set; legacy users can leave it empty', async () => {
  for (const body of [{ phone: '123' }, { name: 'Madonna' }, { address: 'x'.repeat(501) }, { avatarUrl: 'https://evil.example/a.jpg' }])
    assert.strictEqual((await call(c.saveProfile, { user: { id: 1 }, body })).code, 400, JSON.stringify(body).slice(0, 40));
  assert.strictEqual((await call(c.saveProfile, { user: { id: 1 }, body: { phone: '' } })).code, 400);
  assert.strictEqual((await call(c.saveProfile, { user: { id: 3 }, body: { phone: '' } })).code, 200);
});

test('only our Cloudinary avatar URLs are accepted', async () => {
  const r = await call(c.saveProfile, { user: { id: 1 }, body: { avatarUrl: cloud } });
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.user.avatarUrl, cloud);
});

test('change password: wrong current, weak new and same password are refused', async () => {
  assert.strictEqual((await call(c.changePassword, { user: { id: 1 }, body: { currentPassword: 'nope', newPassword: 'newpassword1' } })).code, 400);
  assert.strictEqual((await call(c.changePassword, { user: { id: 1 }, body: { currentPassword: 'oldpassword', newPassword: 'short' } })).code, 400);
  assert.strictEqual((await call(c.changePassword, { user: { id: 1 }, body: { currentPassword: 'oldpassword', newPassword: 'oldpassword' } })).code, 400);
});

test('change password works, and older tokens stop working but the new one does', async () => {
  const oldToken = jwt.sign({ userId: 1, role: 'customer' }, 'test-secret', { expiresIn: '7d' });
  const oldIat = Math.floor(Date.now() / 1000) - 120;
  const staleToken = jwt.sign({ userId: 1, role: 'customer', iat: oldIat }, 'test-secret', { expiresIn: '7d' });
  const run = token => new Promise(r => { const res = { status(x) { this.code = x; return this; }, json() { r(this.code); } };
    authenticateToken({ headers: { authorization: `Bearer ${token}` } }, res, () => r('next')); });
  assert.strictEqual(await run(oldToken), 'next');

  const r = await call(c.changePassword, { user: { id: 1 }, body: { currentPassword: 'oldpassword', newPassword: 'brandnewpass1' } });
  assert.strictEqual(r.code, 200); assert.ok(await bcrypt.compare('brandnewpass1', users[1].password_hash));
  assert.strictEqual(await run(staleToken), 401);       // a session from before the change
  assert.strictEqual(await run(r.body.token), 'next');  // the fresh token returned to this device
});

test('avatar upload signature never exposes the secret', async () => {
  const r = await call(c.signAvatarUpload, { user: { id: 1 } });
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.folder, 'tm-market/avatars');
  assert.ok(!JSON.stringify(r.body).includes('secret456')); assert.match(r.body.signature, /^[a-f0-9]{40}$/);
});
