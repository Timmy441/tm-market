const crypto = require('crypto');

const BASE_URL = 'https://api.paystack.co';

function getSecretKey() {
  return (process.env.PAYSTACK_SECRET_KEY || '').trim();
}

// Live keys remain blocked until explicitly enabled so real charges are never accidental.
function paymentsStatus() {
  const key = getSecretKey();
  if (!key) return 'missing';
  if (key.startsWith('sk_live_') && process.env.ALLOW_LIVE_PAYMENTS !== 'true') return 'live_blocked';
  return 'ok';
}

// timeoutMs is optional: only the new bank lookups use it, so existing payment calls behave exactly as before.
async function request(method, path, body, timeoutMs) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
  });

  const json = await res.json().catch(() => null);

  if (!res.ok || !json || json.status !== true) {
    const error = new Error('Paystack request failed');
    error.status = res.status;
    throw error;
  }

  return json;
}

async function call(method, path, body) {
  return (await request(method, path, body)).data;
}

const initializeTransaction = payload => call('POST', '/transaction/initialize', payload);
const verifyTransaction = reference => call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);

// Bank directory (Nigeria). Follows Paystack's cursor pages, with a hard cap so it can never loop forever.
async function listBanks() {
  const banks = [];
  let next = null;
  for (let page = 0; page < 10; page++) {
    const qs = `country=nigeria&use_cursor=true&perPage=100${next ? `&next=${encodeURIComponent(next)}` : ''}`;
    const json = await request('GET', `/bank?${qs}`, undefined, 10000);
    if (Array.isArray(json.data)) banks.push(...json.data);
    next = json.meta && typeof json.meta.next === 'string' && json.meta.next ? json.meta.next : null;
    if (!next) break;
  }
  return banks;
}

// Looks up the account holder's name. Returns { account_number, account_name }.
const resolveAccount = (accountNumber, bankCode) =>
  request('GET', `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`, undefined, 10000)
    .then(json => json.data);

// Paystack signs RAW request body with HMAC-SHA512 using the secret key.
function verifySignature(rawBody, signature) {
  const key = getSecretKey();
  if (!key || !signature || typeof signature !== 'string' || !Buffer.isBuffer(rawBody)) return false;

  const expected = crypto.createHmac('sha512', key).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { paymentsStatus, initializeTransaction, verifyTransaction, verifySignature, listBanks, resolveAccount };