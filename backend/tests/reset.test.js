const test = require('node:test');
const assert = require('node:assert');
process.env.JWT_SECRET = 'test-secret';
process.env.BREVO_API_KEY = 'fake-key';
process.env.MAIL_FROM_EMAIL = 'sender@example.com';
process.env.SITE_URL = 'https://site.example/';
const crypto = require('crypto');
function mock(rel, exports) { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; }

const users = { 'ada@x.com': { id: 1, first_name: 'Ada', last_name: 'L', email: 'ada@x.com', is_active: true }, 'off@x.com': { id: 2, first_name: 'Off', last_name: 'U', email: 'off@x.com', is_active: false } };
const tokens = new Map();            // hash -> { userId, used, expires }
let recent = false, sent = [], mailOn = true, mailFails = false;
mock('../src/models/userModel', { findUserByEmail: async e => users[e] || null });
mock('../src/models/resetModel', {
  createResetToken: async (uid, hash) => { for (const t of tokens.values()) if (t.userId === uid) t.used = true; tokens.set(hash, { userId: uid, used: false, expires: Date.now() + 1800000 }); },
  requestedRecently: async () => recent,
  consumeResetToken: async (hash) => { const t = tokens.get(hash); if (!t || t.used || t.expires < Date.now()) return null; t.used = true; return t.userId; }
});
mock('../src/utils/mailer', { mailConfigured: () => mailOn, sendMail: async m => { if (mailFails) throw new Error('boom'); sent.push(m); } });

const { forgotPassword, resetPassword } = require('../src/controllers/resetController');
const call = (h, body) => new Promise(r => { const res = { headersSent: false, status(x) { this.code = x; return this; }, json(b) { this.headersSent = true; r({ code: this.code, body: b }); } }; h({ body }, res); });
const tick = () => new Promise(r => setTimeout(r, 20));

test('existing and unknown accounts get the SAME answer; only the real one gets an email', async () => {
  const a = await call(forgotPassword, { email: 'ADA@x.com' }); await tick();
  const b = await call(forgotPassword, { email: 'nobody@x.com' }); await tick();
  assert.strictEqual(a.code, 200); assert.deepStrictEqual(a.body, b.body);
  assert.strictEqual(sent.length, 1); assert.strictEqual(sent[0].to, 'ada@x.com');
});

test('email carries a one-time link in the #fragment on the configured site', () => {
  const m = sent[0].text.match(/https:\/\/site\.example\/index\.html#reset=([a-f0-9]{64})/);
  assert.ok(m); assert.ok(!sent[0].text.includes('?reset='));
});

test('inactive accounts get no email; cooldown stops repeat sends; invalid email is a 400', async () => {
  const before = sent.length;
  await call(forgotPassword, { email: 'off@x.com' }); await tick();
  recent = true; await call(forgotPassword, { email: 'ada@x.com' }); await tick(); recent = false;
  assert.strictEqual(sent.length, before);
  assert.strictEqual((await call(forgotPassword, { email: 'nope' })).code, 400);
});

test('a mail failure is not shown to the visitor and does not crash', async () => {
  mailFails = true; const r = await call(forgotPassword, { email: 'ada@x.com' }); await tick(); mailFails = false;
  assert.strictEqual(r.code, 200);
});

test('if email is not configured the visitor is told honestly', async () => {
  mailOn = false; const r = await call(forgotPassword, { email: 'ada@x.com' }); mailOn = true;
  assert.strictEqual(r.code, 503);
});

test('reset works once, then the same link is dead; wrong/short input is rejected', async () => {
  recent = false; sent.length = 0;
  await call(forgotPassword, { email: 'ada@x.com' }); await tick();
  const token = sent[0].text.match(/#reset=([a-f0-9]{64})/)[1];
  assert.strictEqual((await call(resetPassword, { token, newPassword: 'short' })).code, 400);
  assert.strictEqual((await call(resetPassword, { token: 'zzz', newPassword: 'longenough1' })).code, 400);
  assert.strictEqual((await call(resetPassword, { token: crypto.randomBytes(32).toString('hex'), newPassword: 'longenough1' })).code, 400);
  assert.strictEqual((await call(resetPassword, { token, newPassword: 'longenough1' })).code, 200);
  assert.strictEqual((await call(resetPassword, { token, newPassword: 'longenough2' })).code, 400);
});

test('requesting a new link kills the older one', async () => {
  sent.length = 0;
  await call(forgotPassword, { email: 'ada@x.com' }); await tick();
  const first = sent[0].text.match(/#reset=([a-f0-9]{64})/)[1];
  await call(forgotPassword, { email: 'ada@x.com' }); await tick();
  const second = sent[1].text.match(/#reset=([a-f0-9]{64})/)[1];
  assert.strictEqual((await call(resetPassword, { token: first, newPassword: 'longenough1' })).code, 400);
  assert.strictEqual((await call(resetPassword, { token: second, newPassword: 'longenough1' })).code, 200);
});
