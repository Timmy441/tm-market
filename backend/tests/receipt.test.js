const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

process.env.JWT_SECRET = 'test-only-value';

function mock(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// ---- in-memory stand-in for the database layer ----
let rows, boom, asked;

function baseRow(over = {}) {
  return {
    id: 1, order_number: 'TM-20261011-2WALDUP5', user_id: 1, status: 'delivered',
    subtotal: '1200.00', shipping_fee: '0.00', discount: '0.00', total: '1200.00',
    shipping_name: 'Ada Okafor', shipping_phone: '+2348031234567', shipping_address: '12 Okpara Avenue',
    shipping_city: 'Enugu', shipping_state: 'Enugu', shipping_country: 'Nigeria',
    seller_name: 'Jay joys', first_name: 'Ada', last_name: 'Okafor', email: 'ada@example.com',
    payment_status: 'successful', provider: 'paystack', transaction_reference: 'TMK_abc123', payment_amount: '1200.00',
    paid_at: new Date('2026-10-11T13:38:00Z'),
    items: [{ product_name: 'Wireless mouse', quantity: 1, unit_price: '1200.00', total_price: '1200.00' }],
    ...over
  };
}
function reset() { rows = { 1: baseRow() }; boom = false; asked = []; }
reset();

mock('../src/models/receiptModel', {
  getReceiptData: async id => {
    asked.push(id);
    if (boom) throw new Error('db down');
    return rows[id] || null;
  }
});

const pdf = require('../src/utils/receiptPdf');
const c = require('../src/controllers/receiptController');

// ---- helpers to look inside a PDF ----
const sample = (over = {}) => ({
  orderNumber: 'TM-20261011-2WALDUP5', refunded: false, paidAt: '2026-10-11T13:38:00Z', reference: 'TMK_abc123',
  method: 'Online payment (Paystack)', buyer: { name: 'Ada Okafor', email: 'ada@example.com' }, seller: 'Jay joys',
  shipTo: { name: 'Ada Okafor', phone: '+2348031234567', address: '12 Okpara Avenue', city: 'Enugu', state: 'Enugu', country: 'Nigeria' },
  items: [{ name: 'Wireless mouse', quantity: 1, unitPrice: 1200, totalPrice: 1200 }],
  subtotal: 1200, shippingFee: 0, discount: 0, total: 1200, supportEmail: 'tmmarketsupport@gmail.com',
  siteUrl: 'https://tm-market-pi.vercel.app', generatedAt: new Date('2026-10-11T14:00:00Z'),
  ...over
});
const text = buf => buf.toString('latin1');
const shown = (buf, str) => text(buf).includes(`(${str.replace(/[\\()]/g, ch => `\\${ch}`)}) Tj`);   // PDF text escapes ( ) and \

const call = (handler, req) => new Promise(resolve => {
  const headers = {};
  const res = {
    status(x) { this.code = x; return this; },
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    json(b) { resolve({ code: this.code, body: b, headers }); },
    end(b) { resolve({ code: this.code, buffer: b, headers }); }
  };
  handler({ params: {}, body: {}, query: {}, user: { id: 1, role: 'customer' }, ...req }, res);
});

const quietly = async fn => {
  const orig = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = orig; }
};

/* ---------------- the PDF itself ---------------- */

test('the file is a valid PDF: header, trailer, page count and every table offset is right', () => {
  const buf = pdf.buildReceiptPdf(sample());
  const s = text(buf);
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.endsWith('%%EOF\n'));

  const at = Number(/startxref\n(\d+)\n%%EOF/.exec(s)[1]);
  assert.ok(s.slice(at).startsWith('xref'), 'startxref points at the table');

  const size = Number(/trailer\n<< \/Size (\d+)/.exec(s)[1]);
  const table = s.slice(at).split('\n').slice(3, 3 + size - 1);   // skip "xref", "0 N", and the free entry
  assert.strictEqual(table.length, size - 1);
  table.forEach((line, i) => {
    const n = i + 1;
    assert.match(line, /^\d{10} 00000 n $/);
    assert.ok(s.slice(Number(line.slice(0, 10))).startsWith(`${n} 0 obj`), `object ${n} sits where the table says`);
  });
  assert.match(s, /\/Count 1 /);
});

test('every content stream declares its true length', () => {
  const s = text(pdf.buildReceiptPdf(sample()));
  const streams = [...s.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)];
  assert.ok(streams.length >= 1);
  streams.forEach(m => assert.strictEqual(Number(m[1]), Buffer.byteLength(m[2], 'latin1')));
});

test('a paid receipt shows the real order, payment and money lines', () => {
  const b = pdf.buildReceiptPdf(sample());
  assert.ok(shown(b, 'PAID'));
  assert.ok(!shown(b, 'REFUNDED'));
  assert.ok(shown(b, 'TM-20261011-2WALDUP5'));
  assert.ok(shown(b, 'TMK_abc123'));
  assert.ok(shown(b, 'Wireless mouse'));
  assert.ok(shown(b, 'Jay joys'));
  assert.ok(shown(b, 'ada@example.com'));
  assert.ok(shown(b, 'NGN 1,200.00'));
  assert.ok(shown(b, 'TOTAL PAID'));
  assert.ok(shown(b, 'Not charged online'), 'shipping is not charged online');
  assert.match(text(b), /\(11 Oct 2026,? (at )?2:38 ?(pm|PM)\) Tj/, 'time is shown in Nigerian time (UTC+1)');
  assert.ok(!/undefined|NaN|null/.test(text(b)));
});

test('a refunded receipt says so and a discount only appears when there is one', () => {
  const refunded = pdf.buildReceiptPdf(sample({ refunded: true }));
  assert.ok(shown(refunded, 'REFUNDED'));
  assert.ok(!shown(refunded, 'PAID'));
  assert.ok(shown(refunded, 'TOTAL REFUNDED'));

  assert.ok(!shown(pdf.buildReceiptPdf(sample()), 'Discount'));
  const discounted = pdf.buildReceiptPdf(sample({ discount: 200, total: 1000 }));
  assert.ok(shown(discounted, 'Discount'));
  assert.ok(shown(discounted, '-NGN 200.00'));
});

test('a shipping fee, if one is ever charged, is shown as money', () => {
  const b = pdf.buildReceiptPdf(sample({ shippingFee: 1500, total: 2700 }));
  assert.ok(shown(b, 'NGN 1,500.00'));
  assert.ok(!shown(b, 'Not charged online'));
});

test('names with accents, brackets and backslashes cannot break the file', () => {
  const b = pdf.buildReceiptPdf(sample({
    buyer: { name: 'Ọlá Ṣadé (Jr) \\ test', email: 'ola@example.com' },
    items: [{ name: 'Café ₦ "special" – item', quantity: 1, unitPrice: 5, totalPrice: 5 }]
  }));
  assert.ok(text(b).includes('(Ola Sade \\(Jr\\) \\\\ test) Tj'), 'accents folded, brackets and backslash escaped');
  assert.ok(shown(b, 'Cafe ? "special" - item'), 'unsupported symbols become ? instead of garbling the page');
  // Only plain ASCII (plus the binary marker comment line) ends up in the page content.
  const content = [...text(b).matchAll(/stream\n([\s\S]*?)\nendstream/g)].map(m => m[1]).join('');
  assert.ok(/^[\x20-\x7e\n]*$/.test(content));
});

test('long names and addresses wrap inside their columns and stay on the page', () => {
  const longWord = 'X'.repeat(300);
  const b = pdf.buildReceiptPdf(sample({
    items: [{ name: `Keyboard ${longWord} and a very long description `.repeat(4), quantity: 1, unitPrice: 5, totalPrice: 5 }],
    shipTo: { name: 'Ada', phone: '1', address: 'Plot 7 '.repeat(200), city: 'Enugu', state: 'Enugu', country: 'Nigeria' }
  }));
  const s = text(b);
  assert.match(s, /\/Count 1 /);
  // Every text operator starts inside the page (x from 0 to 595).
  for (const m of s.matchAll(/ ([\d.]+) ([\d.]+) Td /g)) {
    assert.ok(Number(m[1]) >= 0 && Number(m[1]) <= 595, `x ${m[1]} is on the page`);
    assert.ok(Number(m[2]) >= 0 && Number(m[2]) <= 842, `y ${m[2]} is on the page`);
  }
});

test('a very long order continues on more pages, each with its footer', () => {
  const items = Array.from({ length: 70 }, (_, i) => ({ name: `Item ${i + 1} with a long enough name to wrap onto a second line`, quantity: 1, unitPrice: 100, totalPrice: 100 }));
  const b = pdf.buildReceiptPdf(sample({ items, subtotal: 7000, total: 7000 }));
  const pages = Number(/\/Count (\d+) /.exec(text(b))[1]);
  assert.ok(pages > 1);
  for (let i = 1; i <= pages; i++) assert.ok(text(b).includes(`Page ${i} of ${pages}`));
  assert.ok(text(b).includes('(Item 70 with'), 'the last item is not lost');
  assert.strictEqual((text(b).match(/\(TOTAL PAID\) Tj/g) || []).length, 1, 'the total appears once, at the end');
});

test('money helper: whole kobo, thousands separators, no float drift', () => {
  assert.strictEqual(pdf.ngn(0), 'NGN 0.00');
  assert.strictEqual(pdf.ngn(1234567.5), 'NGN 1,234,567.50');
  assert.strictEqual(pdf.ngn(0.1 + 0.2), 'NGN 0.30');
  assert.strictEqual(pdf.ngn('1200.00'), 'NGN 1,200.00');
  assert.strictEqual(pdf.ngn(-5), '-NGN 5.00');
  assert.strictEqual(pdf.ngn(NaN), '-');
  assert.strictEqual(pdf.ngn(undefined), '-');
});

test('text helper: ASCII only, one line, widths and wrapping are consistent', () => {
  assert.strictEqual(pdf.clean('Ọlá ₦5\n\tok'), 'Ola ?5 ok');
  assert.strictEqual(pdf.clean(null), '');
  assert.ok(pdf.widthOf('WWWW', 10, true) > pdf.widthOf('iiii', 10, true));
  const lines = pdf.wrap('word '.repeat(60) + 'Y'.repeat(200), 10, false, 150);
  lines.forEach(l => assert.ok(pdf.widthOf(l, 10, false) <= 150 + 0.01));
  const cut = pdf.wrap('word '.repeat(60), 10, false, 150, 2);
  assert.strictEqual(cut.length, 2);
  assert.ok(cut[1].endsWith('...'));
  assert.strictEqual(pdf.when('not a date'), '-');
  assert.strictEqual(pdf.when(null), '-');
});

/* ---------------- who can download it ---------------- */

test('the buyer downloads their own paid order as a PDF file', async () => {
  const r = await call(c.buyerReceipt, { params: { id: '1' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.headers['content-type'], 'application/pdf');
  assert.strictEqual(r.headers['content-disposition'], 'attachment; filename="TM-Receipt-TM-20261011-2WALDUP5.pdf"');
  assert.match(r.headers['cache-control'], /no-store/);
  assert.strictEqual(r.headers['content-length'], String(r.buffer.length));
  assert.ok(text(r.buffer).startsWith('%PDF-1.4'));
  assert.ok(shown(r.buffer, 'TM-20261011-2WALDUP5'));
  assert.ok(shown(r.buffer, 'Wireless mouse'));
  assert.ok(shown(r.buffer, 'TMK_abc123'));
  assert.ok(shown(r.buffer, 'Online payment (Paystack)'));
});

test("another buyer cannot read someone else's receipt, and gets the same answer as a missing order", async () => {
  const other = await call(c.buyerReceipt, { params: { id: '1' }, user: { id: 2, role: 'customer' } });
  const missing = await call(c.buyerReceipt, { params: { id: '999' } });
  assert.strictEqual(other.code, 404);
  assert.deepStrictEqual(other.body, missing.body);
  assert.ok(!other.buffer);
});

test('bad order ids are refused without touching the database', async () => {
  asked = [];
  for (const id of ['abc', '0', '-3', '1.5', '', undefined, '1; DROP TABLE orders']) {
    const r = await call(c.buyerReceipt, { params: { id } });
    assert.strictEqual(r.code, 404, String(id));
  }
  assert.deepStrictEqual(asked, []);
});

test('there is no receipt until the money was really received', async () => {
  for (const payment_status of ['pending', 'failed', null, undefined]) {
    rows[1] = baseRow({ payment_status, status: 'pending' });
    const r = await call(c.buyerReceipt, { params: { id: '1' } });
    assert.strictEqual(r.code, 409, String(payment_status));
    assert.ok(!r.buffer);
  }
  reset();
});

test('a refunded payment still has a receipt, marked refunded; a cancelled but paid order too', async () => {
  rows[1] = baseRow({ payment_status: 'refunded' });
  let r = await call(c.buyerReceipt, { params: { id: '1' } });
  assert.strictEqual(r.code, 200);
  assert.ok(shown(r.buffer, 'REFUNDED'));

  rows[1] = baseRow({ status: 'cancelled', payment_status: 'successful' });
  r = await call(c.buyerReceipt, { params: { id: '1' } });
  assert.strictEqual(r.code, 200);
  assert.ok(shown(r.buffer, 'PAID'));
  reset();
});

test('an admin can download the receipt of any order, with the same payment rule', async () => {
  const admin = { id: 99, role: 'admin' };
  const ok = await call(c.adminReceipt, { params: { id: '1' }, user: admin });
  assert.strictEqual(ok.code, 200);
  assert.ok(shown(ok.buffer, 'TM-20261011-2WALDUP5'));

  assert.strictEqual((await call(c.adminReceipt, { params: { id: '999' }, user: admin })).code, 404);
  assert.strictEqual((await call(c.adminReceipt, { params: { id: 'x' }, user: admin })).code, 404);
  rows[1] = baseRow({ payment_status: 'pending' });
  assert.strictEqual((await call(c.adminReceipt, { params: { id: '1' }, user: admin })).code, 409);
  reset();
});

test('a database error gives a plain 500 and leaks nothing', async () => {
  boom = true;
  const r = await quietly(() => call(c.buyerReceipt, { params: { id: '1' } }));
  assert.strictEqual(r.code, 500);
  assert.ok(!JSON.stringify(r.body).includes('db down'));
  boom = false;
});

test('receipt data comes from the stored payment and order, never invented', () => {
  const rec = c.toReceipt(baseRow({ payment_amount: '1150.00', first_name: '', last_name: '', seller_name: null, provider: 'other' }));
  assert.strictEqual(rec.total, 1150, 'the amount that was actually paid is shown');
  assert.strictEqual(rec.buyer.name, 'Ada Okafor', 'falls back to the delivery name');
  assert.strictEqual(rec.seller, 'TM Market seller');
  assert.strictEqual(rec.method, 'Online payment');
  assert.strictEqual(rec.supportEmail, 'tmmarketsupport@gmail.com');
  assert.strictEqual(c.toReceipt(baseRow({ provider: 'PayStack' })).method, 'Online payment (Paystack)');
  assert.strictEqual(c.toReceipt(baseRow({ payment_amount: null })).total, 1200, 'falls back to the order total');
  assert.strictEqual(c.fileName('TM-1/../x y"z'), 'TM-Receipt-TM-1xyz.pdf', 'nothing but letters, digits, - and _ reaches the file name');
  assert.strictEqual(c.fileName(''), 'TM-Receipt-order.pdf');
});

/* ---------------- wiring ---------------- */

test('the receipt routes sit behind a login (buyer) and the admin check (admin)', () => {
  const orders = fs.readFileSync(path.join(__dirname, '../src/routes/orderRoutes.js'), 'utf8');
  assert.ok(orders.indexOf('router.use(authenticateToken)') > -1);
  assert.ok(orders.indexOf('router.use(authenticateToken)') < orders.indexOf("router.get('/:id/receipt'"));

  const admin = fs.readFileSync(path.join(__dirname, '../src/routes/adminRoutes.js'), 'utf8');
  const guard = admin.indexOf('router.use(authenticateToken, requireAdmin)');
  assert.ok(guard > -1);
  assert.ok(admin.indexOf("router.get('/orders/:id/receipt'") > guard);
});

test('the receipt code adds no package and never touches payment secrets', () => {
  for (const f of ['../src/utils/receiptPdf.js', '../src/controllers/receiptController.js', '../src/models/receiptModel.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.ok(!/PAYSTACK_SECRET_KEY|sk_live|sk_test/.test(src), f);
  }
  const pdfSrc = fs.readFileSync(path.join(__dirname, '../src/utils/receiptPdf.js'), 'utf8');
  assert.deepStrictEqual([...pdfSrc.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]), [], 'the PDF builder needs nothing');
});
