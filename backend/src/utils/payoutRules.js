// Pure helpers for seller payouts (no database, easy to test).
// Settings can be changed with optional Fly secrets; invalid values fall back to the defaults.
//   PLATFORM_FEE_PERCENT (default 10)  PAYOUT_HOLD_DAYS (default 3)  MIN_WITHDRAWAL (default 1000, naira)

function numberSetting(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

const feePercent = () => numberSetting('PLATFORM_FEE_PERCENT', 10, { min: 0, max: 50 });
const holdDays = () => Math.floor(numberSetting('PAYOUT_HOLD_DAYS', 3, { min: 0, max: 30 }));
const minWithdrawal = () => numberSetting('MIN_WITHDRAWAL', 1000, { min: 100, max: 1000000 });

const toKobo = naira => Math.round(Number(naira) * 100);
const fromKobo = kobo => kobo / 100;

// The fee on one order: a percentage of the item subtotal, rounded to the kobo.
function orderFee(subtotal, percent) {
  return fromKobo(Math.round(toKobo(subtotal) * percent / 100));
}

// Accepts 20000, "20000" or "20000.50". Rejects anything else (negative, 3 decimals, text, NaN).
function parseAmount(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
  } else if (typeof value === 'string') {
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(value.trim())) return null;
  } else return null;
  const n = Number(value);
  if (!(n > 0) || n > 100000000) return null;
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return null;
  return fromKobo(Math.round(n * 100));
}

// Returns { ok: true, value } or { ok: false, message }.
function validateBank(body) {
  const b = body || {};
  const clean = v => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
  const bankName = clean(b.bankName);
  const accountName = clean(b.accountName);
  const accountNumber = typeof b.accountNumber === 'string' ? b.accountNumber.trim() : (typeof b.accountNumber === 'number' ? String(b.accountNumber) : '');
  const bankCode = typeof b.bankCode === 'string' && b.bankCode.trim() ? b.bankCode.trim() : null;

  if (bankName.length < 2 || bankName.length > 80) return { ok: false, message: 'Please enter your bank name.' };
  if (!/^\d{10}$/.test(accountNumber)) return { ok: false, message: 'Account number must be exactly 10 digits.' };
  if (accountName.length < 3 || accountName.length > 120) return { ok: false, message: 'Please enter the account name exactly as your bank shows it.' };
  if (bankCode && !/^\d{2,10}$/.test(bankCode)) return { ok: false, message: 'Bank code must be digits only.' };
  return { ok: true, value: { bankName, bankCode, accountNumber, accountName } };
}

const maskAccount = n => (n ? '******' + String(n).slice(-4) : null);

module.exports = { feePercent, holdDays, minWithdrawal, toKobo, fromKobo, orderFee, parseAmount, validateBank, maskAccount };
