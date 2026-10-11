const test = require('node:test');
const assert = require('node:assert');

// The REAL review model against a fake database that records every query it is asked to run.
// This cannot prove the SQL is valid Postgres (only a real database can), but it catches
// the common mistakes: a placeholder with no value, a value with no placeholder, user text pasted into SQL.
const calls = [];
function mock(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
mock('../db', {
  query: async (sql, values = []) => {
    calls.push({ sql, values: values.slice() });   // a copy, as a real driver takes at call time
    if (/COUNT\(\*\)::int AS total/.test(sql)) return { rows: [{ total: 7 }] };
    if (/COUNT\(\*\)::int AS n/.test(sql)) return { rows: [{ n: 2 }] };
    if (/^\s*UPDATE/.test(sql)) return { rows: values[0] === 5 ? [{ id: 5, is_hidden: values[1] }] : [] };
    return { rows: [] };
  }
});
const model = require('../src/models/reviewModel');

const placeholders = sql => [...new Set([...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
const consistent = ({ sql, values }) => {
  const p = placeholders(sql);
  assert.deepStrictEqual(p, values.map((_, i) => i + 1), `every placeholder has a value and every value a placeholder:\n${sql}`);
  assert.strictEqual((sql.match(/\(/g) || []).length, (sql.match(/\)/g) || []).length, 'brackets are balanced');
};

test('the admin list queries are consistent for every filter combination', async () => {
  for (const args of [
    { search: '', visibility: null },
    { search: 'pencil', visibility: null },
    { search: '', visibility: 'hidden' },
    { search: '50%_off', visibility: 'visible' },
    { search: 'x', visibility: 'hidden' }
  ]) {
    calls.length = 0;
    const out = await model.adminListReviews({ ...args, limit: 20, offset: 40 });
    assert.strictEqual(out.total, 7);
    assert.strictEqual(out.hiddenCount, 2);
    assert.ok(calls.length >= 3);
    calls.forEach(consistent);
  }
});

test('search text and paging only ever travel as values, never inside the SQL', async () => {
  calls.length = 0;
  const evil = "'; DROP TABLE product_reviews; --";
  await model.adminListReviews({ search: evil, visibility: null, limit: 20, offset: 0 });
  calls.forEach(c => assert.ok(!c.sql.includes('DROP TABLE') && !c.sql.includes(evil)));
  const withSearch = calls.find(c => c.values.some(v => String(v).includes('DROP TABLE')));
  assert.ok(withSearch, 'the text is passed as a bound value');
  assert.ok(withSearch.values[0].startsWith('%') && withSearch.values[0].endsWith('%'));

  calls.length = 0;
  await model.adminListReviews({ search: '50%_off', visibility: null, limit: 20, offset: 0 });
  assert.ok(calls.some(c => c.values.includes('%50\\%\\_off%')), 'LIKE wildcards in the search are escaped');
});

test('the visibility filter only adds a fixed condition, and the list is newest first', async () => {
  calls.length = 0;
  await model.adminListReviews({ search: '', visibility: 'hidden', limit: 5, offset: 0 });
  assert.ok(calls.some(c => /r\.is_hidden = TRUE/.test(c.sql)));
  assert.ok(calls.some(c => /ORDER BY r\.created_at DESC, r\.id DESC/.test(c.sql)));
  calls.length = 0;
  await model.adminListReviews({ search: '', visibility: 'visible', limit: 5, offset: 0 });
  assert.ok(calls.some(c => /r\.is_hidden = FALSE/.test(c.sql)));
});

test('hiding is an UPDATE of one row by id, never a DELETE', async () => {
  calls.length = 0;
  const hid = await model.adminSetReviewHidden(5, true);
  assert.deepStrictEqual(hid, { id: 5, is_hidden: true });
  assert.strictEqual(await model.adminSetReviewHidden(6, false), null);
  calls.forEach(c => {
    consistent(c);
    assert.ok(/^\s*UPDATE product_reviews SET is_hidden = \$2 WHERE id = \$1/.test(c.sql));
    assert.ok(!/DELETE/i.test(c.sql));
  });
});

test('the admin list never selects anything it should not show', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '../src/models/reviewModel.js'), 'utf8');
  const admin = src.slice(src.indexOf('async function adminListReviews'));
  assert.ok(!/password|phone/i.test(admin), 'no password or phone is read for moderation');
});
