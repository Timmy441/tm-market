// Mixes paid (sponsored) products into the first page of the shop.
// At most 2 sponsored items per 8 products, at positions 2, 6, 10, 14... of the page.
const MAX_SPONSORED = 6;

function sponsoredSlots(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 8) return 0;
  return Math.min(MAX_SPONSORED, Math.floor(n / 8) * 2);
}

function mergeSponsored(organic, sponsored) {
  const base = Array.isArray(organic) ? organic : [];
  if (!Array.isArray(sponsored) || !sponsored.length) return base.map(p => ({ ...p, is_sponsored: false }));
  const ids = new Set(sponsored.map(p => String(p.id)));
  const out = base.filter(p => !ids.has(String(p.id))).map(p => ({ ...p, is_sponsored: false }));
  sponsored.forEach((p, k) => out.splice(Math.min(1 + 4 * k, out.length), 0, { ...p, is_sponsored: true }));
  return out;
}

module.exports = { sponsoredSlots, mergeSponsored, MAX_SPONSORED };
