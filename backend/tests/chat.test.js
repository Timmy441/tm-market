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

// ---------- Payout, fee and shipping answers (Task D) ----------
const { INTENTS } = require('../src/utils/chatFaq');
const SETTINGS = ['PLATFORM_FEE_PERCENT', 'PAYOUT_HOLD_DAYS', 'MIN_WITHDRAWAL'];
async function withSettings(values, fn) {
  const saved = {};
  for (const k of SETTINGS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, values);
  try { return await fn(); }
  finally { for (const k of SETTINGS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
const reply = async q => (await ask(q, { id: 1 })).body.reply;

test('payout questions reach the new payout answers', () => {
  const cases = {
    'how do I get paid': 'get_paid',
    'how do I withdraw my money': 'get_paid',
    'how do I request a withdrawal': 'get_paid',
    'where are my earnings': 'get_paid',
    'what is the platform fee': 'payout_fee',
    'how much commission do you take': 'payout_fee',
    'what percentage do you charge sellers': 'payout_fee',
    'when is my money available': 'payout_timing',
    'why is my balance pending': 'payout_timing',
    'when will I get paid': 'payout_timing',
    'how long does a payout take': 'payout_timing',
    'how do I add my bank details': 'payout_bank',
    'where do I put my account number': 'payout_bank',
    'who pays for shipping': 'shipping_cost',
    'is there a delivery fee': 'shipping_cost',
    'how much is delivery': 'shipping_cost',
    'can I pay the seller directly': 'pay_outside',
    'is there cash on delivery': 'pay_outside',
    'the seller asked me to send money to his account': 'pay_outside'
  };
  for (const [q, want] of Object.entries(cases)) assert.strictEqual(id(q), want, `"${q}" matched ${id(q)}, expected ${want}`);
});

test('older questions still go where they went before the payout intents were added', () => {
  const cases = { 'how do I pay': 'checkout', 'update my delivery address': 'address', 'how do I get paid?': 'get_paid',
    'when will my order arrive': 'delivery_time', 'I want a refund': 'refund', 'how can I contact the seller': 'contact_seller', 'change my phone number': 'change_phone' };
  for (const [q, want] of Object.entries(cases)) assert.strictEqual(id(q), want, `"${q}" matched ${id(q)}, expected ${want}`);
});

test('every quick-reply button on the payout answers leads to the answer it promises', () => {
  const want = { 'Platform fee': 'payout_fee', 'When is my money available?': 'payout_timing', 'Add bank details': 'payout_bank',
    'How do I get paid?': 'get_paid', 'Shipping fees': 'shipping_cost', 'How do I pay?': 'checkout', 'Track my order': 'order_status', 'Report a problem': 'report_problem' };
  for (const intentId of ['get_paid', 'payout_fee', 'payout_timing', 'payout_bank', 'shipping_cost', 'pay_outside']) {
    for (const s of INTENTS.find(i => i.id === intentId).suggestions) {
      assert.ok(want[s], `unexpected suggestion "${s}"`);
      assert.strictEqual(id(s), want[s], `button "${s}" matched ${id(s)}`);
    }
  }
});

test('the payout answer states the real current rules and the old "no payout button" text is gone', async () => {
  await withSettings({ PLATFORM_FEE_PERCENT: '5' }, async () => {
    const r = await ask('how do I get paid', { id: 1 });
    const t = r.body.reply;
    assert.ok(!/no automatic payout button/i.test(t));
    assert.ok(t.includes('5%'), 'fee');
    assert.ok(/PENDING/.test(t) && /received this order/.test(t) && /marks the order as delivered/.test(t), 'pending until delivery');
    assert.ok(t.includes('3 days after delivery'), 'hold days');
    assert.ok(t.includes('\u20A61,000'), 'minimum');
    assert.ok(/only one withdrawal request/.test(t), 'one at a time');
    assert.ok(/password/.test(t), 'bank needs password');
    assert.ok(/manually, not automatically/.test(t) && /email/.test(t), 'manual payment + email');
    assert.ok(/Shipping is not charged online/.test(t) && /outside TM Market/.test(t));
    assert.ok(r.body.support, 'support button shown');
  });
});

test('payout answers follow the real settings, and invalid settings fall back like the payout code does', async () => {
  await withSettings({ PLATFORM_FEE_PERCENT: '7.5', PAYOUT_HOLD_DAYS: '7', MIN_WITHDRAWAL: '2000' }, async () => {
    const t = await reply('how do I get paid');
    assert.ok(t.includes('7.5%') && t.includes('7 days after delivery') && t.includes('\u20A62,000'));
    assert.ok(!t.includes('5%.') && !t.includes('\u20A61,000'));
    assert.ok((await reply('what is the platform fee')).includes('keeps \u20A6750 and you receive \u20A69,250'));
  });
  await withSettings({ PAYOUT_HOLD_DAYS: '1' }, async () => assert.ok((await reply('when is my money available')).includes('1 day after delivery')));
  await withSettings({ PAYOUT_HOLD_DAYS: '0' }, async () => assert.ok((await reply('when is my money available')).includes('as soon as delivery is confirmed')));
  await withSettings({ PLATFORM_FEE_PERCENT: 'abc', PAYOUT_HOLD_DAYS: '99', MIN_WITHDRAWAL: '-5' }, async () => {
    const t = await reply('how do I get paid');
    assert.ok(t.includes('10%') && t.includes('3 days') && t.includes('\u20A61,000'));   // code defaults
  });
});

test('payout, fee, bank and shipping answers never claim an action was done and never ask for secrets', async () => {
  for (const q of ['how do I get paid', 'what is the platform fee', 'when is my money available', 'how do I add my bank details', 'who pays for shipping', 'can I pay the seller directly']) {
    const t = await reply(q);
    assert.ok(!/(has|have|had) been (paid|sent|approved|released|saved)|i (have|ve) (paid|sent|approved|released|saved)/i.test(t), q);
    assert.ok(!/within \d+ (hour|day|minute)/i.test(t), `${q} promises a time`);
    assert.ok(!/(?<!never )(send|share|type|enter) (me )?your (password|pin|otp)/i.test(t), q);   // a warning ("never share...") is fine, a request is not
    assert.ok(!/sk_(live|test)_/.test(t), q);
  }
  assert.ok(/cannot give an exact time/.test(await reply('when is my money available')));
  assert.ok(/Never share your password in this chat/.test(await reply('how do I add my bank details')));
});

test('shipping and outside-payment answers match the checkout notice', async () => {
  const ship = await reply('who pays for shipping');
  assert.ok(/not included/.test(ship) && /not charged online/.test(ship));
  assert.ok(/agree the delivery cost and the delivery method directly with the seller/.test(ship));
  assert.ok(/only after the item has really arrived/.test(ship));
  const out = await ask('can I pay the seller directly', { id: 1 });
  assert.ok(/only through TM Market/.test(out.body.reply) && /no pay on delivery/.test(out.body.reply));
  assert.ok(out.body.support);
});

test('payout answers work for logged-out visitors too and expose no order data', async () => {
  const r = await ask('how do I get paid');
  assert.ok(r.body.reply.includes('PENDING'));
  assert.ok(!r.body.reply.includes('TM-2026'));
});

test('confirming delivery is explained honestly', async () => {
  assert.ok(/only once your parcel has really arrived/.test(await reply('how do I confirm delivery')));
});
