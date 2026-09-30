const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.JWT_SECRET = 'test-secret';

// In-memory stand-in for the user model (the real one only runs SQL).
const users = [];
let raceOnce = null;
const modelPath = require.resolve('../src/models/userModel');
require.cache[modelPath] = { id: modelPath, filename: modelPath, loaded: true, exports: {
  findUserByEmail: async e => users.find(u => u.email.toLowerCase() === e.toLowerCase()) || null,
  findUserById: async id => users.find(u => u.id === id) || null,
  findUserByPhone: async p => users.find(u => u.phone_normalized === p) || null,
  createUser: async u => {
    if (raceOnce) { const e = new Error('dup'); e.code = '23505'; e.constraint = raceOnce; raceOnce = null; throw e; }
    const row = { id: users.length + 1, first_name: u.firstName, last_name: u.lastName, email: u.email,
      phone: u.phone, phone_normalized: u.phoneNormalized, role: 'customer', is_active: true,
      password_hash: u.passwordHash, created_at: new Date(), updated_at: new Date() };
    users.push(row); return row;
  }
}};

const { register, login } = require('../src/controllers/authController');
const { normalizeNigerianPhone } = require('../src/utils/phone');

function call(handler, body) {
  return new Promise(resolve => {
    const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    handler({ body }, res);
  });
}
const base = { name: 'John Doe', email: 'Example@gmail.com', phone: '08012345678', password: 'password123' };

test('phone formats normalise to the same number', () => {
  for (const p of ['08012345678', '+2348012345678', '2348012345678', '0801 234 5678', '0801-234-5678', '8012345678', '+234 0801 234 5678', '002348012345678'])
    assert.strictEqual(normalizeNigerianPhone(p), '+2348012345678', p);
  for (const p of ['0123456789', '0801234567', '080123456789', 'abc', '', null, '+15551234567'])
    assert.strictEqual(normalizeNigerianPhone(p), null, String(p));
});

test('new registration succeeds and returns a token', async () => {
  const r = await call(register, base);
  assert.strictEqual(r.code, 201); assert.ok(r.body.token); assert.strictEqual(r.body.user.name, 'John Doe');
  assert.strictEqual(users[0].email, 'example@gmail.com');
});

test('same email with different capitalisation is rejected', async () => {
  for (const email of ['example@gmail.com', 'EXAMPLE@gmail.com', '  Example@Gmail.com ']) {
    const r = await call(register, { ...base, email, phone: '09011111111' });
    assert.strictEqual(r.code, 409); assert.strictEqual(r.body.message, 'An account with this email already exists.');
  }
});

test('same phone in a different format is rejected', async () => {
  for (const phone of ['+2348012345678', '2348012345678', '0801 234 5678']) {
    const r = await call(register, { ...base, email: 'other@gmail.com', phone });
    assert.strictEqual(r.code, 409); assert.strictEqual(r.body.message, 'This phone number is already registered.');
  }
});

test('database-level race is turned into a friendly message', async () => {
  raceOnce = 'users_phone_normalized_key';
  let r = await call(register, { ...base, email: 'race@gmail.com', phone: '09022222222' });
  assert.strictEqual(r.code, 409); assert.strictEqual(r.body.message, 'This phone number is already registered.');
  raceOnce = 'users_email_lower_key';
  r = await call(register, { ...base, email: 'race2@gmail.com', phone: '09033333333' });
  assert.strictEqual(r.body.message, 'An account with this email already exists.');
});

test('invalid input is rejected with friendly messages', async () => {
  assert.strictEqual((await call(register, { ...base, phone: undefined })).code, 400);
  assert.strictEqual((await call(register, { ...base, phone: '12345' })).code, 400);
  assert.strictEqual((await call(register, { ...base, email: 'nope' })).code, 400);
  assert.strictEqual((await call(register, { ...base, password: 'short' })).code, 400);
  assert.strictEqual((await call(register, { ...base, name: 'Madonna' })).code, 400);
});

test('login works with any email capitalisation and rejects bad passwords', async () => {
  let r = await call(login, { email: 'EXAMPLE@GMAIL.COM', password: 'password123' });
  assert.strictEqual(r.code, 200); assert.ok(r.body.token);
  r = await call(login, { email: 'example@gmail.com', password: 'wrongpass' });
  assert.strictEqual(r.code, 401);
});
