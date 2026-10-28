const test = require('node:test');
const assert = require('node:assert');

// The REAL promotion model against a fake database that records every query.
// It cannot prove the SQL is valid Postgres (only a real database can), but it catches the common mistakes:
// a placeholder with no value, a value with no placeholder, and text pasted into SQL.
const calls = [];
let script = () => ({ rows: [] });
function mock(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
const run = async (sql, values = []) => { calls.push({ sql, values: values.slice() }); return script(sql, values) || { rows: [] }; };
mock('../db', {
  query: run,
  connect: async () => ({ query: run, release() {} })
});
const m = require('../src/models/promotionModel');

const placeholders = sql => [...new Set([...sql.matchAll(/\$(\d+)/g)].map(x => Number(x[1])))].sort((a, b) => a - b);
function consistent({ sql, values }) {
  const p = placeholders(sql);
  assert.deepStrictEqual(p, values.map((_, i) => i + 1), `placeholders ${p} vs ${values.length} values in: ${sql.slice(0, 80)}`);
}

test('every query uses exactly the placeholders it has values for', async () => {
  calls.length = 0;
  script = sql => (/COUNT\(\*\)::int AS n/.test(sql) ? { rows: [{ n: 0 }] } : { rows: [{ id: 1, start: new Date(), amount: '1800', plan_days: 14, status: 'pending', product_id: 5 }] });
  await m.findPromotableProduct(5, 9);
  await m.findBlockingPromotion(5);
  await m.createPendingPromotion({ productId: 5, sellerId: 9, planDays: 14, amount: 1800, reference: 'TMP-5-1' });
  await m.deletePendingPromotion(1);
  await m.findPromotionByReference('TMP-5-1', 9);
  await m.findPromotionByReference('TMP-5-1', null);
  await m.listSellerPromotions(9);
  await m.adminListPromotions({ state: '', limit: 20, offset: 0 });
  await m.adminListPromotions({ state: 'running', limit: 20, offset: 20 });
  await m.getPromotionAlertInfo(1);
  await m.confirmPromotionPayment('TMP-5-1', 180000, 'NGN');
  for (const a of ['pause', 'resume', 'remove']) await m.adminChangePromotion(1, a);
  assert.ok(calls.length > 20);
  calls.filter(c => !/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(c.sql)).forEach(consistent);
});

test('a state filter from the browser is never pasted into SQL', async () => {
  calls.length = 0;
  script = sql => (/COUNT\(\*\)::int AS n/.test(sql) ? { rows: [{ n: 0 }] } : { rows: [] });
  await m.adminListPromotions({ state: "running'; DROP TABLE users;--", limit: 20, offset: 0 });
  assert.ok(calls.every(c => !/DROP TABLE/.test(c.sql)));
  assert.ok(calls.every(c => !c.values.some(v => /DROP TABLE/.test(String(v)))));
});

test('a wrong amount or currency is refused and nothing is activated', async () => {
  calls.length = 0;
  script = sql => (/FROM sponsored_listings WHERE reference/.test(sql) ? { rows: [{ id: 1, product_id: 5, plan_days: 14, amount: '1800.00', status: 'pending' }] } : { rows: [] });
  assert.strictEqual((await m.confirmPromotionPayment('TMP-5-1', 100, 'NGN')).outcome, 'amount_mismatch');
  assert.strictEqual((await m.confirmPromotionPayment('TMP-5-1', 180000, 'USD')).outcome, 'amount_mismatch');
  assert.ok(!calls.some(c => /SET status = 'active'/.test(c.sql)));
  assert.ok(calls.some(c => /^\s*ROLLBACK/.test(c.sql)));
});

test('an unknown or already-confirmed reference is handled without activating twice', async () => {
  calls.length = 0;
  script = () => ({ rows: [] });
  assert.strictEqual((await m.confirmPromotionPayment('NOPE', 180000, 'NGN')).outcome, 'unknown_reference');
  script = sql => (/FROM sponsored_listings WHERE reference/.test(sql) ? { rows: [{ id: 1, product_id: 5, plan_days: 14, amount: '1800.00', status: 'active' }] } : { rows: [] });
  assert.strictEqual((await m.confirmPromotionPayment('TMP-5-1', 180000, 'NGN')).outcome, 'already_active');
});

test('a correct payment activates once, after locking the product', async () => {
  calls.length = 0;
  script = sql => {
    if (/FROM sponsored_listings WHERE reference/.test(sql)) return { rows: [{ id: 1, product_id: 5, plan_days: 14, amount: '1800.00', status: 'pending' }] };
    if (/AS start/.test(sql)) return { rows: [{ start: new Date('2026-10-28T10:00:00Z') }] };
    if (/SET status = 'active'/.test(sql)) return { rows: [{ id: 1, starts_at: new Date('2026-10-28T10:00:00Z'), ends_at: new Date('2026-11-11T10:00:00Z') }] };
    return { rows: [] };
  };
  const out = await m.confirmPromotionPayment('TMP-5-1', 180000, 'NGN');
  assert.strictEqual(out.outcome, 'activated');
  const order = calls.map(c => c.sql.trim().split(/\s+/).slice(0, 3).join(' '));
  assert.ok(order.findIndex(x => /SELECT id FROM products/.test(x) || x === 'SELECT id FROM') >= 0);
  assert.strictEqual(calls.filter(c => /SET status = 'active'/.test(c.sql)).length, 1);
  assert.ok(calls.some(c => /^\s*COMMIT/.test(c.sql)));
});

test('admin actions refuse the wrong states', async () => {
  script = sql => (/FOR UPDATE/.test(sql) ? { rows: [{ id: 1, status: 'removed', starts_at: new Date(), ends_at: new Date(Date.now() + 1e6), paused_at: null }] } : { rows: [] });
  assert.strictEqual((await m.adminChangePromotion(1, 'pause')).result, 'bad_state');
  assert.strictEqual((await m.adminChangePromotion(1, 'resume')).result, 'bad_state');
  assert.strictEqual((await m.adminChangePromotion(1, 'remove')).result, 'bad_state');
  script = sql => (/FOR UPDATE/.test(sql) ? { rows: [{ id: 1, status: 'pending' }] } : { rows: [] });
  assert.strictEqual((await m.adminChangePromotion(1, 'pause')).result, 'not_found');
});
