// Bank list and account-name check, powered by Paystack (free, no extra service).
// Nothing here moves money. If Paystack cannot answer, callers are told "unavailable" and fall back safely.
const paystack = require('./paystack');

const CACHE_MS = 6 * 60 * 60 * 1000;   // the bank list rarely changes
let cache = { at: 0, banks: null };

function clean(list) {
  const seen = new Set();
  const out = [];
  for (const b of list) {
    if (!b || b.is_deleted === true || b.active === false) continue;
    const code = typeof b.code === 'string' ? b.code.trim() : '';
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!/^\d{2,10}$/.test(code) || !name || seen.has(code)) continue;
    seen.add(code);
    out.push({ name, code });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Returns [{ name, code }]. Uses the last good list if Paystack is down. Throws only if there never was one.
async function getBanks() {
  const fresh = cache.banks && Date.now() - cache.at < CACHE_MS;
  if (fresh) return cache.banks;
  try {
    const banks = clean(await paystack.listBanks());
    if (!banks.length) throw new Error('empty bank list');
    cache = { at: Date.now(), banks };
    return banks;
  } catch (err) {
    if (cache.banks) return cache.banks;
    throw err;
  }
}

async function findBank(code) {
  try { return (await getBanks()).find(b => b.code === code) || null; } catch { return null; }
}

// { ok: true, accountName } | { ok: false, reason: 'not_found' | 'unavailable' }
async function verifyAccount(accountNumber, bankCode) {
  if (!(process.env.PAYSTACK_SECRET_KEY || '').trim()) return { ok: false, reason: 'unavailable' };
  try {
    const data = await paystack.resolveAccount(accountNumber, bankCode);
    const name = data && typeof data.account_name === 'string' ? data.account_name.replace(/\s+/g, ' ').trim() : '';
    if (name.length < 3) return { ok: false, reason: 'unavailable' };
    return { ok: true, accountName: name.slice(0, 120) };
  } catch (err) {
    // 400/422 = Paystack looked and found no such account. Anything else (timeout, 5xx, 403, 429, no network) = could not check.
    return { ok: false, reason: err && (err.status === 422 || err.status === 400) ? 'not_found' : 'unavailable' };
  }
}

function resetCache() { cache = { at: 0, banks: null }; }

module.exports = { getBanks, findBank, verifyAccount, resetCache };
