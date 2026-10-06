const test = require('node:test');
const assert = require('node:assert');

function mock(rel, exports) { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; }

// Fake database: user 1 owns two orders, user 2 owns one. Every lookup is by user id, as in the real model.
const ORDERS = [
  { id: 1, user_id: 1, order_number: 'TM-20261001-AAAAAAAA', status: 'pending', total: '15000.00', seller_name: 'Ada Store', delivery_window_start: null, delivery_window_end: null },
  { id: 2, user_id: 1, order_number: 'TM-20261002-BBBBBBBB', status: 'shipped', total: '2500.50', seller_name: 'Bola Shop', delivery_window_start: '2026-10-10', delivery_window_end: '2026-10-14' },
  { id: 3, user_id: 2, order_number: 'TM-20261003-CCCCCCCC', status: 'confirmed', total: '999.00', seller_name: 'Other', delivery_window_start: null, delivery_window_end: null },
  { id: 4, user_id: 1, order_number: 'TM-20261004-DDDDDDDD', status: 'cancelled', total: '100.00', seller_name: null, delivery_window_start: null, delivery_window_end: null }
];
let dbFails = false;
mock('../src/models/chatModel', {
  recentOrdersForUser: async (uid, limit) => { if (dbFails) throw new Error('db down'); return ORDERS.filter(o => o.user_id === uid).slice().reverse().slice(0, limit); },
  orderByNumberForUser: async (uid, n) => { if (dbFails) throw new Error('db down'); return ORDERS.find(o => o.user_id === uid && o.order_number === n) || null; }
});

// Route test helper: pretend the real auth middleware accepts only the token "good".
let authCalls = 0;
mock('../src/middleware/authMiddleware', {
  authenticateToken: (req, res, next) => {
    authCalls++;
    if (req.headers.authorization === 'Bearer good') { req.user = { id: 1, role: 'customer' }; return next(); }
    return res.status(401).json({ success: false, message: 'Invalid authentication token' });
  }
});

const { start, message } = require('../src/controllers/chatController');
const { matchIntent, normalise, SUPPORT } = require('../src/utils/chatFaq');
const router = require('../src/routes/chatRoutes');

const ask = (text, user = null) => new Promise(resolve => {
  const res = { status(x) { this.code = x; return this; }, json(b) { resolve({ code: this.code || 200, body: b }); } };
  message({ body: { message: text }, user }, res);
});
const id = text => { const i = matchIntent(text); return i ? i.id : null; };

test('support channels are exactly the real ones: two emails and one WhatsApp number', () => {
  assert.deepStrictEqual(SUPPORT.emails, ['tmmarketsupport@gmail.com', 'support@gmail.com']);
  assert.strictEqual(SUPPORT.whatsapp.link, 'https://wa.me/2347086049886');
});

test('start returns a greeting that says it is automated, quick replies and support', () => {
  let out;
  start({}, { json: b => { out = b; } });
  assert.ok(/automated/i.test(out.greeting));
  assert.ok(out.suggestions.length >= 3);
  assert.deepStrictEqual(out.support, SUPPORT);
});

test('common questions reach the right answer', () => {
  const cases = {
    'How do I create an account?': 'create_account',
    "i forgot my password": 'reset_password',
    'how can I change my password': 'change_password',
    'how do i buy something': 'buy',
    'how do I pay': 'checkout',
    'how do I sell on here': 'sell',
    'how to add a product': 'add_product',
    'how do I mark my item as sold': 'edit_listing',
    'change my phone number': 'change_phone',
    'update my delivery address': 'address',
    'where can I find my orders': 'find_orders',
    'where is my order': 'order_status',
    'track my order': 'order_status',
    'I want a refund': 'refund',
    'cancel my order': 'cancel',
    'how can I contact the seller': 'contact_seller',
    'my money was deducted but order is pending': 'payment_failed',
    'my account is suspended': 'suspended',
    'I want to report a scam': 'report_problem',
    'can I talk to a real person': 'human',
    'hello': 'greeting',
    'thanks a lot': 'thanks',
    'how do i change my email': 'change_email',
    'is my item shipped': 'order_status',
    'i did not receive my order': 'order_status',
    'who are you': 'about',
    'i need help': 'help',
    'my payment is not going through': 'payment_failed',
    'forgot my pasword': 'reset_password'
  };
  for (const [q, want] of Object.entries(cases)) assert.strictEqual(id(q), want, `"${q}" matched ${id(q)}, expected ${want}`);
});

test('normalise ignores capitals, apostrophes and punctuation', () => {
  assert.strictEqual(normalise("Can't  LOG-in!!"), 'cant log in');
});

test('unknown questions get the honest fallback and the support channels', async () => {
  const r = await ask('what is the meaning of life');
  assert.strictEqual(r.body.reply, "I'm not sure about that. Please contact support.");
  assert.deepStrictEqual(r.body.support, SUPPORT);
});

test('empty, non-text and very long messages are rejected with 400', async () => {
  assert.strictEqual((await ask('   ')).code, 400);
  assert.strictEqual((await ask(undefined)).code, 400);
  assert.strictEqual((await ask('a'.repeat(501))).code, 400);
});

test('refund, cancel and payment-problem answers never claim an action was done', async () => {
  for (const q of ['I want a refund', 'cancel my order', 'refund me now please', 'my payment failed']) {
    const r = await ask(q, { id: 1 });
    assert.ok(!/(has been|have been|is now|i have|i ve|successfully) (refunded|cancelled|canceled)/i.test(r.body.reply), q);
    assert.ok(r.body.support, `${q} should offer support`);
  }
  const refund = (await ask('I want a refund')).body.reply;
  assert.ok(/cannot (start|approve|confirm)/i.test(refund));
});

test('logged-out visitors never see order data and are asked to log in', async () => {
  const r = await ask('where is my order');
  assert.ok(/log in/i.test(r.body.reply));
  assert.ok(!r.body.reply.includes('TM-2026'));
  const r2 = await ask('status of TM-20261003-CCCCCCCC');
  assert.ok(!r2.body.reply.includes('999'));
});

test('logged-in users get their OWN real orders with honest wording per status', async () => {
  const r = await ask('where is my order', { id: 1 });
  const t = r.body.reply;
  assert.ok(t.includes('TM-20261002-BBBBBBBB') && t.includes('shipped'));
  assert.ok(t.includes('10 Oct 2026') && t.includes('14 Oct 2026'));
  assert.ok(/waiting for payment, it has NOT been paid/.test(t));
  assert.ok(!t.includes('TM-20261003-CCCCCCCC'));        // another buyer's order
  assert.ok(!t.includes('Other'));
});

test('a specific order number is looked up only inside the asker\'s own orders', async () => {
  const mine = await ask('track TM-20261002-BBBBBBBB please', { id: 1 });
  assert.ok(mine.body.reply.includes('shipped'));
  const theirs = await ask('track TM-20261003-CCCCCCCC', { id: 1 });
  assert.ok(/could not find an order/i.test(theirs.body.reply));
  assert.ok(!theirs.body.reply.includes('999'));
  const bare = await ask('tm-20261004-dddddddd', { id: 1 });         // bare number, lower case
  assert.ok(/cancelled/.test(bare.body.reply));
  assert.ok(/cannot see or confirm refunds/.test(bare.body.reply));  // never claims a refund
});

test('a user with no orders gets an honest empty answer; a database error is admitted', async () => {
  const none = await ask('track my order', { id: 99 });
  assert.ok(/no orders yet/i.test(none.body.reply));
  dbFails = true;
  const bad = await ask('track my order', { id: 1 });
  dbFails = false;
  assert.ok(/could not load your orders/i.test(bad.body.reply));
  assert.ok(bad.body.support);
});

test('test-mode note only appears when the Paystack key really is a test key', async () => {
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_x';
  assert.ok(/TEST mode/.test((await ask('how do I pay')).body.reply));
  process.env.PAYSTACK_SECRET_KEY = 'sk_live_x';
  assert.ok(!/TEST mode/.test((await ask('how do I pay')).body.reply));
  delete process.env.PAYSTACK_SECRET_KEY;
});

test('optional login: a bad or expired token never blocks the chat, a good one unlocks orders', async () => {
  const layer = router.stack.find(l => l.route && l.route.path === '/' && l.route.methods.post);
  const [optionalAuth] = layer.route.stack.map(s => s.handle);
  const run = authorization => new Promise(resolve => {
    const req = { headers: authorization ? { authorization } : {} };
    optionalAuth(req, { status() { return this; }, json() {} }, () => resolve(req));
  });
  assert.strictEqual((await run(undefined)).user, undefined);
  assert.strictEqual((await run('Bearer bad')).user, undefined);   // continues anonymously
  assert.strictEqual((await run('Bearer good')).user.id, 1);
});

test('vague or off-topic questions fall back instead of guessing', () => {
  for (const q of ['which seller is best', 'price of iphone', 'do you deliver to abuja', 'what is the weather']) {
    assert.strictEqual(id(q), null, q);
  }
});
