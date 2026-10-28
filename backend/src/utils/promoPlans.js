// The three promotion plans. Prices come from Fly secrets so they can change without a deploy:
//   fly secrets set PROMO_PRICE_7=1000 PROMO_PRICE_14=1800 PROMO_PRICE_30=3000
// A missing or invalid secret falls back to the placeholder price.
const DEFAULTS = { 7: 1000, 14: 1800, 30: 3000 };

function priceFor(days) {
  const raw = Number(String(process.env[`PROMO_PRICE_${days}`] || '').trim());
  return Number.isInteger(raw) && raw >= 100 && raw <= 1000000 ? raw : DEFAULTS[days];
}

function getPlans() {
  return [7, 14, 30].map(days => ({ days, price: priceFor(days) }));
}

function findPlan(days) {
  const n = Number(days);
  return getPlans().find(p => p.days === n) || null;
}

module.exports = { getPlans, findPlan };
