const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The code logs money actions; keep this test's output clean.
console.log = () => {};
console.error = () => {};

function mock(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const rules = require('../src/utils/payoutRules');

/* ---------------- pure rules ---------------- */

test('parseAmount accepts normal naira amounts and rejects everything odd', () => {
  assert.strictEqual(rules.parseAmount(20000), 20000);
  assert.strictEqual(rules.parseAmount('20000'), 20000);
  assert.strictEqual(rules.parseAmount('1500.50'), 1500.5);
  for (const bad of [0, -5, '-5', 'abc', '', '1e3', 20000.555, '20000.555', NaN, Infinity, null, undefined, {}, [], true, '0x10', 1e12]) {
    assert.strictEqual(rules.parseAmount(bad), null, `should reject ${String(bad)}`);
  }
});

test('the platform fee is 10% of the subtotal, rounded to the kobo', () => {
  delete process.env.PLATFORM_FEE_PERCENT;
  assert.strictEqual(rules.feePercent(), 10);
  assert.strictEqual(rules.orderFee(10000, 10), 1000);
  assert.strictEqual(rules.orderFee(100, 10), 10);
  assert.strictEqual(rules.orderFee(12345.67, 10), 1234.57);
});

test('settings fall back to safe defaults when a Fly secret is wrong', () => {
  process.env.PLATFORM_FEE_PERCENT = 'abc';
  process.env.PAYOUT_HOLD_DAYS = '-4';
  process.env.MIN_WITHDRAWAL = '0';
  assert.strictEqual(rules.feePercent(), 10);
  assert.strictEqual(rules.holdDays(), 3);
  assert.strictEqual(rules.minWithdrawal(), 1000);
  process.env.PLATFORM_FEE_PERCENT = '12.5';
  process.env.PAYOUT_HOLD_DAYS = '5';
  process.env.MIN_WITHDRAWAL = '2000';
  assert.strictEqual(rules.feePercent(), 12.5);
  assert.strictEqual(rules.holdDays(), 5);
  assert.strictEqual(rules.minWithdrawal(), 2000);
  delete process.env.PLATFORM_FEE_PERCENT; delete process.env.PAYOUT_HOLD_DAYS; delete process.env.MIN_WITHDRAWAL;
});

test('validateBank enforces a 10-digit account number and cleans the text', () => {
  const ok = rules.validateBank({ bankName: '  GTBank ', accountNumber: '0123456789', accountName: 'Ada   Obi', bankCode: '058' });
  assert.deepStrictEqual(ok, { ok: true, value: { bankName: 'GTBank', bankCode: '058', accountNumber: '0123456789', accountName: 'Ada Obi' } });
  for (const accountNumber of ['12345', '01234567890', '01234abcde', '', null, undefined]) {
    assert.strictEqual(rules.validateBank({ bankName: 'GTBank', accountNumber, accountName: 'Ada Obi' }).ok, false);
  }
  assert.strictEqual(rules.validateBank({ bankName: '', accountNumber: '0123456789', accountName: 'Ada Obi' }).ok, false);
  assert.strictEqual(rules.validateBank({ bankName: 'GTBank', accountNumber: '0123456789', accountName: 'A' }).ok, false);
  assert.strictEqual(rules.validateBank({ bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Ada Obi', bankCode: 'x1' }).ok, false);
  assert.strictEqual(rules.maskAccount('0123456789'), '******6789');
});

/* ---------------- the model, with a fake database (checks the flow, not the SQL) ---------------- */

const scenario = {};
const sqlLog = [];

function answer(sql, params) {
  sqlLog.push({ sql, params });
  const s = sql.replace(/\s+/g, ' ');
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return { rows: [], rowCount: 0 };
  if (s.includes('FOR UPDATE')) return { rows: [{ id: 1 }], rowCount: 1 };
  if (s.includes('FROM seller_bank_accounts')) return scenario.bank ? { rows: [scenario.bank], rowCount: 1 } : { rows: [], rowCount: 0 };
  if (s.includes('SELECT 1 FROM withdrawals')) return { rows: [], rowCount: scenario.open ? 1 : 0 };
  if (s.includes('INSERT INTO order_earnings')) return { rows: [], rowCount: 0 };
  if (s.includes('SUM(e.net)')) return { rows: [{ pending: scenario.pending || '0', released: scenario.released || '0' }], rowCount: 1 };
  if (s.includes('SUM(amount)')) return { rows: [{ withdrawn: scenario.withdrawn || '0', in_review: scenario.inReview || '0' }], rowCount: 1 };
  if (s.includes('INSERT INTO withdrawals (')) {
    if (scenario.insertError) throw scenario.insertError;
    return { rows: [{ id: 9, seller_id: params[0], amount: params[1], status: 'pending', bank_name: params[2], account_number: params[4], account_name: params[5], requested_at: 'now' }], rowCount: 1 };
  }
  if (s.includes('WITH upd AS')) {
    if (scenario.settleError) throw scenario.settleError;
    return { rows: [], rowCount: scenario.settled === false ? 0 : 1 };
  }
  if (s.includes('FROM withdrawals w WHERE w.seller_id')) return { rows: [], rowCount: 0 };
  return { rows: [], rowCount: 0 };
}

const client = { query: async (sql, params) => answer(sql, params), release() { client.released = true; } };
mock('../db', { query: async (sql, params) => answer(sql, params), connect: async () => { client.released = false; return client; } });

const model = require('../src/models/payoutModel');
const R = { feePercent: 10, holdDays: 3, minWithdrawal: 1000 };
const BANK = { bank_name: 'GTBank', bank_code: '058', account_number: '0123456789', account_name: 'Ada Obi' };
const reset = () => { for (const k of Object.keys(scenario)) delete scenario[k]; sqlLog.length = 0; };
const ran = re => sqlLog.some(q => re.test(q.sql.replace(/\s+/g, ' ')));

test('balances: pending, available, total earned and withdrawn add up', async () => {
  reset();
  Object.assign(scenario, { bank: BANK, pending: '10000.00', released: '25000.00', withdrawn: '5000.00', inReview: '0.00' });
  const s = await model.getSummary(1, R);
  assert.strictEqual(s.balances.pendingBalance, 10000);
  assert.strictEqual(s.balances.availableBalance, 20000);
  assert.strictEqual(s.balances.withdrawable, 20000);
  assert.strictEqual(s.balances.totalEarned, 35000);
  assert.strictEqual(s.balances.withdrawn, 5000);
});

test('an open request reduces the available balance straight away', async () => {
  reset();
  Object.assign(scenario, { released: '25000.00', inReview: '20000.00' });
  const s = await model.getSummary(1, R);
  assert.strictEqual(s.balances.availableBalance, 5000);
  assert.strictEqual(s.balances.inReview, 20000);
});

test('the available balance can never go below zero', async () => {
  reset();
  Object.assign(scenario, { released: '1000.00', withdrawn: '5000.00' });
  assert.strictEqual((await model.getSummary(1, R)).balances.availableBalance, 0);
});

test('a withdrawal within the balance is saved with a bank snapshot and committed', async () => {
  reset();
  Object.assign(scenario, { bank: BANK, released: '25000.00' });
  const r = await model.requestWithdrawal(1, 20000, R);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.withdrawal.amount, 20000);
  assert.strictEqual(r.withdrawal.account_number, '0123456789');
  assert.ok(ran(/FOR UPDATE/), 'seller row must be locked');
  assert.ok(ran(/COMMIT/));
  assert.ok(ran(/INSERT INTO withdrawal_events/));
  assert.strictEqual(client.released, true);
});

test('asking for more than the available balance is refused and nothing is saved', async () => {
  reset();
  Object.assign(scenario, { bank: BANK, released: '25000.00' });
  const r = await model.requestWithdrawal(1, 30000, R);
  assert.strictEqual(r.status, 'insufficient');
  assert.strictEqual(r.available, 25000);
  assert.ok(ran(/ROLLBACK/));
  assert.ok(!ran(/INSERT INTO withdrawals \(/));
});

test('the exact available amount is allowed, one kobo more is not', async () => {
  reset();
  Object.assign(scenario, { bank: BANK, released: '25000.00' });
  assert.strictEqual((await model.requestWithdrawal(1, 25000, R)).status, 'ok');
  reset();
  Object.assign(scenario, { bank: BANK, released: '25000.00' });
  assert.strictEqual((await model.requestWithdrawal(1, 25000.01, R)).status, 'insufficient');
});

test('no bank details, or an open request, blocks a new withdrawal', async () => {
  reset();
  Object.assign(scenario, { released: '25000.00' });
  assert.strictEqual((await model.requestWithdrawal(1, 2000, R)).status, 'no_bank');
  reset();
  Object.assign(scenario, { bank: BANK, released: '25000.00', open: true });
  assert.strictEqual((await model.requestWithdrawal(1, 2000, R)).status, 'open_exists');
  assert.ok(!ran(/INSERT INTO withdrawals \(/));
});

test('two requests at the same moment: the database uniqueness rule is reported as open_exists', async () => {
  reset();
  Object.assign(scenario, { bank: BANK, released: '25000.00', insertError: Object.assign(new Error('duplicate key'), { code: '23505' }) });
  assert.strictEqual((await model.requestWithdrawal(1, 2000, R)).status, 'open_exists');
  assert.strictEqual(client.released, true);
});

test('other database errors are rolled back and rethrown', async () => {
  reset();
  Object.assign(scenario, { bank: BANK, released: '25000.00', insertError: new Error('db down') });
  await assert.rejects(() => model.requestWithdrawal(1, 2000, R), /db down/);
  assert.ok(ran(/ROLLBACK/));
  assert.strictEqual(client.released, true);
});

test('bank details cannot change while a withdrawal is open', async () => {
  reset();
  scenario.open = true;
  const r = await model.saveBank(1, { bankName: 'GTBank', bankCode: null, accountNumber: '0123456789', accountName: 'Ada Obi' });
  assert.strictEqual(r.status, 'open_exists');
  assert.ok(!ran(/INSERT INTO seller_bank_accounts/));
  reset();
  assert.strictEqual((await model.saveBank(1, { bankName: 'GTBank', bankCode: null, accountNumber: '0123456789', accountName: 'Ada Obi' })).status, 'ok');
});

test('settling: only open requests can be settled, and a reused reference is caught', async () => {
  reset();
  assert.strictEqual((await model.markPaid(9, 1, 'TRF_abc123', null)).status, 'ok');
  reset(); scenario.settled = false;
  assert.strictEqual((await model.markPaid(9, 1, 'TRF_abc123', null)).status, 'not_open');
  assert.strictEqual((await model.reject(9, 1, 'Wrong account name')).status, 'not_open');
  reset(); scenario.settleError = Object.assign(new Error('dup'), { code: '23505' });
  assert.strictEqual((await model.markPaid(9, 1, 'TRF_abc123', null)).status, 'duplicate_reference');
  const settle = sqlLog.find(q => q.sql.includes('WITH upd AS'));
  assert.ok(/status IN \('pending', 'approved'\)/.test(settle.sql), 'the WHERE clause must only match open requests');
});

/* ---------------- controllers, with a fake model ---------------- */

const bcrypt = require('bcryptjs');
const PASSWORD_HASH = bcrypt.hashSync('Correct-Pass-1', 4);

const calls = { saveBank: null, request: null, paid: null, rejected: null, adminMail: [], sellerMail: [] };
const fake = {
  summary: null, saveBankResult: { status: 'ok' }, requestResult: null, withdrawal: null, paidResult: { status: 'ok' }, rejectResult: { status: 'ok' }
};

mock('../src/models/userModel', { getPasswordHash: async () => PASSWORD_HASH });
mock('../src/utils/payoutAlert', {
  notifyAdminOfWithdrawal: id => calls.adminMail.push(id),
  notifySellerOfSettlement: id => calls.sellerMail.push(id)
});
mock('../src/models/payoutModel', {
  getSummary: async () => fake.summary,
  saveBank: async (id, bank) => { calls.saveBank = { id, bank }; return fake.saveBankResult; },
  requestWithdrawal: async (id, amount, r) => { calls.request = { id, amount, r }; return fake.requestResult; },
  adminListWithdrawals: async q => { calls.list = q; return { withdrawals: [], total: 0, openCount: 2 }; },
  adminGetWithdrawal: async id => fake.withdrawal && fake.withdrawal.id === id ? fake.withdrawal : null,
  markPaid: async (id, admin, ref, note) => { calls.paid = { id, admin, ref, note }; return fake.paidResult; },
  reject: async (id, admin, note) => { calls.rejected = { id, admin, note }; return fake.rejectResult; }
});

const c = require('../src/controllers/payoutController');
const call = (h, req) => new Promise(r => {
  const res = { status(x) { this.code = x; return this; }, json(b) { r({ code: this.code || 200, body: b }); } };
  h({ query: {}, params: {}, body: {}, user: { id: 5 }, ...req }, res);
});

const WITHDRAWAL = {
  id: 9, seller_id: 5, amount: '20000.00', status: 'pending', bank_name: 'GTBank', bank_code: '058', account_number: '0123456789',
  account_name: 'Ada Obi', admin_note: null, payment_reference: null, requested_at: 'now', reviewed_at: null, paid_at: null,
  store_name: 'TM Official Store', first_name: 'Ada', last_name: 'Obi', seller_email: 's@x.com', seller_phone: '08012345678', events: []
};
const resetCalls = () => { Object.assign(calls, { saveBank: null, request: null, paid: null, rejected: null, adminMail: [], sellerMail: [] }); };

test('the seller summary hides the full account number and internal fields', async () => {
  resetCalls();
  fake.summary = {
    balances: { pendingKobo: 1, availableKobo: 2, pendingBalance: 10000, availableBalance: 25000, withdrawable: 25000, totalEarned: 80000, inReview: 0, withdrawn: 45000 },
    bank: BANK, withdrawals: [WITHDRAWAL]
  };
  const r = await call(c.myPayouts);
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.balances.availableBalance, 25000);
  assert.strictEqual(r.body.balances.pendingKobo, undefined);
  assert.strictEqual(r.body.bank.accountNumber, '******6789');
  assert.ok(!JSON.stringify(r.body).includes('0123456789'), 'the full account number must never be sent to the seller page');
  assert.deepStrictEqual(r.body.rules, { feePercent: 10, holdDays: 3, minWithdrawal: 1000 });
});

test('saving bank details needs the correct password (400, never 401)', async () => {
  resetCalls();
  const body = { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Ada Obi' };
  let r = await call(c.saveMyBank, { body });
  assert.strictEqual(r.code, 400);
  r = await call(c.saveMyBank, { body: { ...body, password: 'wrong' } });
  assert.strictEqual(r.code, 400);
  assert.strictEqual(calls.saveBank, null);
  r = await call(c.saveMyBank, { body: { ...body, password: 'Correct-Pass-1' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(calls.saveBank.id, 5);
  assert.strictEqual(r.body.bank.accountNumber, '******6789');
});

test('bad bank details are refused before the password is even checked', async () => {
  resetCalls();
  const r = await call(c.saveMyBank, { body: { bankName: 'GTBank', accountNumber: '123', accountName: 'Ada Obi', password: 'Correct-Pass-1' } });
  assert.strictEqual(r.code, 400);
  assert.strictEqual(calls.saveBank, null);
});

test('changing the bank while a withdrawal is open returns 409', async () => {
  resetCalls();
  fake.saveBankResult = { status: 'open_exists' };
  const r = await call(c.saveMyBank, { body: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Ada Obi', password: 'Correct-Pass-1' } });
  assert.strictEqual(r.code, 409);
  fake.saveBankResult = { status: 'ok' };
});

test('withdrawal amounts that are invalid or below the minimum never reach the database', async () => {
  resetCalls();
  for (const amount of ['abc', -5, 0, '1e3', 20000.555, undefined, null, 999]) {
    const r = await call(c.requestMyWithdrawal, { body: { amount } });
    assert.strictEqual(r.code, 400, `amount ${String(amount)} should be refused`);
  }
  assert.strictEqual(calls.request, null);
});

test('a good request returns 201 and alerts the admin once', async () => {
  resetCalls();
  fake.requestResult = { status: 'ok', withdrawal: WITHDRAWAL };
  const r = await call(c.requestMyWithdrawal, { body: { amount: '20000' } });
  assert.strictEqual(r.code, 201);
  assert.strictEqual(calls.request.amount, 20000);
  assert.strictEqual(calls.request.id, 5, 'the seller id comes from the login, never from the request body');
  assert.deepStrictEqual(calls.adminMail, [9]);
  assert.strictEqual(r.body.withdrawal.bank.accountNumber, '******6789');
});

test('the seller id in the request body is ignored', async () => {
  resetCalls();
  fake.requestResult = { status: 'ok', withdrawal: WITHDRAWAL };
  await call(c.requestMyWithdrawal, { body: { amount: 5000, sellerId: 99, seller_id: 99, userId: 99 } });
  assert.strictEqual(calls.request.id, 5);
});

test('request refusals map to clear messages', async () => {
  resetCalls();
  fake.requestResult = { status: 'no_bank' };
  assert.strictEqual((await call(c.requestMyWithdrawal, { body: { amount: 5000 } })).code, 400);
  fake.requestResult = { status: 'open_exists' };
  assert.strictEqual((await call(c.requestMyWithdrawal, { body: { amount: 5000 } })).code, 409);
  fake.requestResult = { status: 'insufficient', available: 12000 };
  const r = await call(c.requestMyWithdrawal, { body: { amount: 50000 } });
  assert.strictEqual(r.code, 400);
  assert.ok(r.body.message.includes('12,000'));
  assert.deepStrictEqual(calls.adminMail, []);
});

test('admin list: unknown status filters are ignored and the open count is returned', async () => {
  resetCalls();
  const r = await call(c.adminList, { query: { status: 'hacked; DROP TABLE', limit: '500' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(calls.list.status, null);
  assert.strictEqual(calls.list.limit, 50);
  assert.strictEqual(r.body.openCount, 2);
  await call(c.adminList, { query: { status: 'paid' } });
  assert.strictEqual(calls.list.status, 'paid');
});

test('admin sees the full account number', async () => {
  fake.withdrawal = WITHDRAWAL;
  const r = await call(c.adminDetail, { params: { id: '9' } });
  assert.strictEqual(r.body.withdrawal.bank.accountNumber, '0123456789');
  assert.strictEqual(r.body.withdrawal.seller.store, 'TM Official Store');
  assert.strictEqual((await call(c.adminDetail, { params: { id: '404' } })).code, 404);
  assert.strictEqual((await call(c.adminDetail, { params: { id: 'abc' } })).code, 400);
});

test('mark paid needs a sensible reference and an open request', async () => {
  resetCalls();
  fake.withdrawal = WITHDRAWAL;
  for (const reference of [undefined, '', 'ab', 'x'.repeat(121), '<script>alert(1)</script>']) {
    assert.strictEqual((await call(c.adminMarkPaid, { params: { id: '9' }, body: { reference } })).code, 400);
  }
  assert.strictEqual((await call(c.adminMarkPaid, { params: { id: '404' }, body: { reference: 'TRF_abc123' } })).code, 404);
  fake.paidResult = { status: 'not_open' };
  assert.strictEqual((await call(c.adminMarkPaid, { params: { id: '9' }, body: { reference: 'TRF_abc123' } })).code, 409);
  fake.paidResult = { status: 'duplicate_reference' };
  assert.strictEqual((await call(c.adminMarkPaid, { params: { id: '9' }, body: { reference: 'TRF_abc123' } })).code, 409);
  assert.deepStrictEqual(calls.sellerMail, []);
  fake.paidResult = { status: 'ok' };
  const r = await call(c.adminMarkPaid, { params: { id: '9' }, body: { reference: 'TRF_abc123', note: 'Paid from Paystack' }, user: { id: 1 } });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(calls.paid, { id: 9, admin: 1, ref: 'TRF_abc123', note: 'Paid from Paystack' });
  assert.deepStrictEqual(calls.sellerMail, [9]);
});

test('reject needs a reason, and a settled request cannot be rejected again', async () => {
  resetCalls();
  fake.withdrawal = WITHDRAWAL;
  assert.strictEqual((await call(c.adminReject, { params: { id: '9' }, body: {} })).code, 400);
  assert.strictEqual((await call(c.adminReject, { params: { id: '9' }, body: { note: 'no' } })).code, 400);
  fake.rejectResult = { status: 'not_open' };
  assert.strictEqual((await call(c.adminReject, { params: { id: '9' }, body: { note: 'Account name does not match' } })).code, 409);
  fake.rejectResult = { status: 'ok' };
  const r = await call(c.adminReject, { params: { id: '9' }, body: { note: 'Account name does not match' }, user: { id: 1 } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(calls.rejected.note, 'Account name does not match');
  assert.deepStrictEqual(calls.sellerMail, [9]);
});

/* ---------------- routes: every payout route must sit behind the right checks ---------------- */

test('seller payout routes need a login AND the seller role (checked in the database)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/sellerRoutes.js'), 'utf8');
  for (const needle of ["'/me/payouts'", "'/me/bank'", "'/me/withdrawals'"]) {
    const line = src.split(/\r?\n/).find(l => l.includes(needle));
    assert.ok(line, `${needle} route is missing`);
    assert.ok(/authenticateToken,\s*requireSeller/.test(line), `${needle} must use authenticateToken, requireSeller`);
  }
});

test('admin withdrawal routes are registered after the admin-only guard', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/adminRoutes.js'), 'utf8');
  const guard = src.indexOf('router.use(authenticateToken, requireAdmin)');
  assert.ok(guard > -1);
  for (const needle of ["'/withdrawals'", "'/withdrawals/:id'", "'/withdrawals/:id/paid'", "'/withdrawals/:id/reject'"]) {
    const at = src.indexOf(needle);
    assert.ok(at > guard, `${needle} must come after the admin guard`);
  }
});

test('the Paystack secret key is never used by the payout code (manual payouts for now)', () => {
  for (const f of ['../src/controllers/payoutController.js', '../src/models/payoutModel.js', '../src/utils/payoutRules.js', '../src/utils/payoutAlert.js']) {
    assert.ok(!/PAYSTACK_SECRET_KEY|sk_live|sk_test/.test(fs.readFileSync(path.join(__dirname, f), 'utf8')), f);
  }
});
