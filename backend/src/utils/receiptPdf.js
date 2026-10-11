// Builds the buyer's payment receipt as a PDF. No packages and no database: pure code, easy to test.
//
// It uses the two fonts every PDF viewer already has (Helvetica and Helvetica-Bold), so nothing is embedded.
// Those fonts cannot show the naira sign or accented letters, so money is written as "NGN 1,200.00" and
// accents are folded ("Ola" for the accented spelling). Anything else outside plain ASCII becomes "?".

// Character widths (per 1000 units) for ASCII 32..126, from the standard Helvetica font metrics.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

const PAGE_W = 595;   // A4 in points
const PAGE_H = 842;
const M = 48;         // page margin
const CONTENT_W = PAGE_W - 2 * M;
const BOTTOM = PAGE_H - 64;   // nothing but the footer goes below this line

const VIOLET = [0.486, 0.227, 0.929];
const INK = [0.13, 0.10, 0.32];
const GREY = [0.45, 0.43, 0.52];
const LINE = [0.88, 0.87, 0.93];
const TINT = [0.96, 0.95, 0.99];
const GREEN = [0.09, 0.59, 0.41];
const GREEN_TINT = [0.88, 0.96, 0.92];
const RED = [0.86, 0.30, 0.36];
const RED_TINT = [0.99, 0.91, 0.92];

const SMART = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', ' ': ' ' };

// Plain printable ASCII only, on one line.
function clean(value) {
  let s = String(value === null || value === undefined ? '' : value);
  s = s.replace(/[‘’“”–—… ]/g, c => SMART[c]);
  s = s.normalize('NFKD').replace(/\p{M}/gu, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s.replace(/[^\x20-\x7e]/g, '?');
}

function widthOf(text, size, bold) {
  const table = bold ? BOLD : HELV;
  let w = 0;
  for (let i = 0; i < text.length; i++) w += table[text.charCodeAt(i) - 32] || 556;
  return (w * size) / 1000;
}

// Splits text into lines no wider than maxW. A single very long word is broken by letter.
function wrap(text, size, bold, maxW, maxLines) {
  const words = clean(text).split(' ').filter(Boolean);
  const lines = [];
  let cur = '';
  const push = s => { lines.push(s); };
  for (const word of words) {
    let w = word;
    while (widthOf(w, size, bold) > maxW) {
      let cut = w.length - 1;
      while (cut > 1 && widthOf(w.slice(0, cut), size, bold) > maxW) cut--;
      if (cur) { push(cur); cur = ''; }
      push(w.slice(0, cut));
      w = w.slice(cut);
    }
    const next = cur ? `${cur} ${w}` : w;
    if (widthOf(next, size, bold) <= maxW) cur = next;
    else { push(cur); cur = w; }
  }
  if (cur) push(cur);
  if (!lines.length) lines.push('');
  if (maxLines && lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 1 && widthOf(`${last}...`, size, bold) > maxW) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last}...`;
    return kept;
  }
  return lines;
}

// Money in whole kobo so decimals never drift. Written as "NGN 1,200.00".
function ngn(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  const kobo = Math.round(Math.abs(n) * 100);
  const naira = String(Math.floor(kobo / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rest = String(kobo % 100).padStart(2, '0');
  return `${n < 0 ? '-' : ''}NGN ${naira}.${rest}`;
}

// Nigerian time (WAT), e.g. "11 Oct 2026, 2:41 pm".
function when(value) {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return '-';
  return clean(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
  }).format(d));
}

const num = x => String(Math.round(x * 100) / 100);
const esc = s => s.replace(/[\\()]/g, c => `\\${c}`);

// ---- tiny drawing layer: every call appends PDF operators to a page ----
function drawText(page, x, base, str, { size = 10, bold = false, color = INK, align = 'left' } = {}) {
  const t = clean(str);
  const w = widthOf(t, size, bold);
  const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  page.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color.join(' ')} rg ${num(left)} ${num(PAGE_H - base)} Td (${esc(t)}) Tj ET`);
}
function drawRect(page, x, top, w, h, color) {
  page.push(`q ${color.join(' ')} rg ${num(x)} ${num(PAGE_H - top - h)} ${num(w)} ${num(h)} re f Q`);
}
function drawLine(page, x1, x2, y, color, width = 0.7) {
  page.push(`q ${color.join(' ')} RG ${width} w ${num(x1)} ${num(PAGE_H - y)} m ${num(x2)} ${num(PAGE_H - y)} l S Q`);
}

// Turns pages (arrays of operators) into the bytes of a valid PDF 1.4 file.
function assemble(pages, title, createdAt) {
  const parts = [];
  const offsets = [];
  let length = 0;
  const add = str => { const b = Buffer.from(str, 'latin1'); parts.push(b); length += b.length; };
  const startObject = n => { offsets[n] = length; };

  add('%PDF-1.4\n%âãÏÓ\n');

  const pageObj = i => 6 + 2 * i;
  const contentObj = i => 7 + 2 * i;
  const kids = pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ');
  const total = 5 + 2 * pages.length;

  startObject(1); add('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  startObject(2); add(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);
  startObject(3); add('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n');
  startObject(4); add('4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n');
  const stamp = createdAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  startObject(5); add(`5 0 obj\n<< /Title (${esc(clean(title))}) /Producer (TM Market) /CreationDate (D:${stamp}) >>\nendobj\n`);

  pages.forEach((ops, i) => {
    const stream = ops.join('\n');
    startObject(pageObj(i));
    add(`${pageObj(i)} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObj(i)} 0 R >>\nendobj\n`);
    startObject(contentObj(i));
    add(`${contentObj(i)} 0 obj\n<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream\nendobj\n`);
  });

  const xrefAt = length;
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= total; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  add(xref);
  add(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return Buffer.concat(parts);
}

/*
 r = {
   orderNumber, refunded (boolean), paidAt, reference, method,
   buyer: { name, email }, seller, shipTo: { name, phone, address, city, state, country },
   items: [{ name, quantity, unitPrice, totalPrice }], subtotal, shippingFee, discount, total,
   supportEmail, siteUrl, generatedAt
 }
*/
function buildReceiptPdf(r) {
  const generatedAt = r.generatedAt instanceof Date ? r.generatedAt : new Date();
  const pages = [[]];
  let page = pages[0];
  let y = 0;

  const newPage = () => { page = []; pages.push(page); y = M; };
  const ensure = h => { if (y + h > BOTTOM) newPage(); };

  // ---- header ----
  drawText(page, M, 62, 'TM Market', { size: 24, bold: true, color: VIOLET });
  drawText(page, PAGE_W - M, 56, 'PAYMENT RECEIPT', { size: 12, bold: true, color: INK, align: 'right' });
  drawText(page, PAGE_W - M, 72, r.orderNumber, { size: 9, color: GREY, align: 'right' });
  drawLine(page, M, PAGE_W - M, 84, VIOLET, 2);

  // ---- status band ----
  const refunded = !!r.refunded;
  const label = refunded ? 'REFUNDED' : 'PAID';
  const bandColor = refunded ? RED : GREEN;
  drawRect(page, M, 100, CONTENT_W, 30, refunded ? RED_TINT : GREEN_TINT);
  drawText(page, M + 14, 120, label, { size: 12, bold: true, color: bandColor });
  drawText(page, PAGE_W - M - 14, 120, refunded ? 'This payment has been refunded.' : 'Thank you. Your payment was received.', { size: 9.5, color: bandColor, align: 'right' });
  y = 156;

  // ---- who / what (two columns) ----
  const COL_W = 232;
  const RIGHT_X = M + 267;
  const field = (x, top, name, lines) => {
    drawText(page, x, top, name, { size: 7.5, bold: true, color: GREY });
    let base = top + 14;
    lines.forEach(l => { drawText(page, x, base, l, { size: 10 }); base += 13; });
    return base - 13 + 16;       // top of the next field
  };

  const ship = r.shipTo || {};
  const left = [
    ['ORDER NUMBER', wrap(r.orderNumber, 10, false, COL_W, 2)],
    ['DATE PAID', [when(r.paidAt)]],
    ['PAYMENT METHOD', wrap(r.method || 'Online payment', 10, false, COL_W, 2)],
    ['PAYMENT REFERENCE', wrap(r.reference || '-', 10, false, COL_W, 3)]
  ];
  const place = [ship.city, ship.state, ship.country].filter(Boolean).join(', ');
  const right = [
    ['PAID BY', [...wrap((r.buyer && r.buyer.name) || '-', 10, false, COL_W, 2), ...wrap((r.buyer && r.buyer.email) || '', 10, false, COL_W, 2).filter(Boolean)]],
    ['SOLD BY', wrap(r.seller || 'TM Market seller', 10, false, COL_W, 2)],
    ['DELIVERY TO', [
      ...wrap(ship.name || '-', 10, false, COL_W, 2),
      ...wrap(ship.phone || '', 10, false, COL_W, 1).filter(Boolean),
      ...wrap(ship.address || '', 10, false, COL_W, 6),
      ...wrap(place, 10, false, COL_W, 2).filter(Boolean)
    ]]
  ];
  let ly = y, ry = y;
  left.forEach(([n, lines]) => { ly = field(M, ly, n, lines); });
  right.forEach(([n, lines]) => { ry = field(RIGHT_X, ry, n, lines); });
  y = Math.max(ly, ry) + 6;

  // ---- items table ----
  const QTY_R = M + 282, UNIT_R = M + 384, AMT_R = PAGE_W - M, ITEM_W = 238;
  const tableHead = () => {
    drawRect(page, M, y, CONTENT_W, 24, TINT);
    drawText(page, M + 10, y + 16, 'ITEM', { size: 8, bold: true, color: GREY });
    drawText(page, QTY_R, y + 16, 'QTY', { size: 8, bold: true, color: GREY, align: 'right' });
    drawText(page, UNIT_R, y + 16, 'UNIT PRICE', { size: 8, bold: true, color: GREY, align: 'right' });
    drawText(page, AMT_R - 10, y + 16, 'AMOUNT', { size: 8, bold: true, color: GREY, align: 'right' });
    y += 24;
  };
  ensure(24 + 40);
  tableHead();
  (r.items || []).forEach(it => {
    const lines = wrap(it.name || 'Item', 10, false, ITEM_W, 4);
    const h = lines.length * 13 + 12;
    if (y + h > BOTTOM) { newPage(); tableHead(); }
    lines.forEach((l, i) => drawText(page, M + 10, y + 18 + i * 13, l, { size: 10 }));
    drawText(page, QTY_R, y + 18, String(it.quantity), { size: 10, align: 'right' });
    drawText(page, UNIT_R, y + 18, ngn(it.unitPrice), { size: 10, align: 'right' });
    drawText(page, AMT_R - 10, y + 18, ngn(it.totalPrice), { size: 10, align: 'right' });
    y += h;
    drawLine(page, M, PAGE_W - M, y, LINE);
  });

  // ---- totals ----
  const shippingFee = Number(r.shippingFee) || 0;
  const discount = Number(r.discount) || 0;
  const rows = [['Subtotal', ngn(r.subtotal)], ['Shipping', shippingFee > 0 ? ngn(shippingFee) : 'Not charged online']];
  if (discount > 0) rows.push(['Discount', `-${ngn(discount)}`]);
  ensure(rows.length * 18 + 64);
  y += 14;
  const LABEL_X = M + 300;
  rows.forEach(([name, value]) => {
    drawText(page, LABEL_X, y + 4, name, { size: 10, color: GREY });
    drawText(page, AMT_R - 10, y + 4, value, { size: 10, align: 'right' });
    y += 18;
  });
  drawLine(page, LABEL_X, PAGE_W - M, y - 4, LINE);
  y += 12;
  const totalLabel = refunded ? 'TOTAL REFUNDED' : 'TOTAL PAID';
  const totalText = ngn(r.total);
  const room = AMT_R - 10 - (LABEL_X + widthOf(totalLabel, 10, true) + 14);
  let totalSize = 14;
  while (totalSize > 8 && widthOf(totalText, totalSize, true) > room) totalSize -= 0.5;   // never collide with the label
  drawText(page, LABEL_X, y + 6, totalLabel, { size: 10, bold: true });
  drawText(page, AMT_R - 10, y + 6, totalText, { size: totalSize, bold: true, color: refunded ? RED : VIOLET, align: 'right' });
  y += 38;

  // ---- notes ----
  const notes = [
    'Shipping is not charged online. The delivery cost and method are agreed directly between you and the seller.',
    'This is a payment receipt, not a tax invoice.',
    `Keep it as proof of payment. Questions about your order? ${r.supportEmail ? `Email ${r.supportEmail}.` : 'Contact TM Market support.'}`
  ];
  const noteLines = notes.flatMap(n => wrap(n, 9, false, CONTENT_W - 28, 4).concat(['']));
  ensure(noteLines.length * 12 + 28);
  const boxH = noteLines.length * 12 + 12;
  drawRect(page, M, y, CONTENT_W, boxH, TINT);
  noteLines.forEach((l, i) => { if (l) drawText(page, M + 14, y + 18 + i * 12, l, { size: 9, color: GREY }); });

  // ---- footer on every page ----
  const stampText = `Receipt generated ${when(generatedAt)} (Nigerian time)`;
  pages.forEach((ops, i) => {
    drawLine(ops, M, PAGE_W - M, PAGE_H - 46, LINE);
    drawText(ops, M, PAGE_H - 32, `TM Market${r.siteUrl ? `  |  ${String(r.siteUrl).replace(/^https?:\/\//, '')}` : ''}`, { size: 8, color: GREY });
    drawText(ops, PAGE_W - M, PAGE_H - 32, `${stampText}   |   Page ${i + 1} of ${pages.length}`, { size: 8, color: GREY, align: 'right' });
  });

  return assemble(pages, `TM Market receipt ${r.orderNumber}`, generatedAt);
}

module.exports = { buildReceiptPdf, clean, ngn, wrap, widthOf, when };
