const crypto = require('crypto');

const BASE_URL = 'https://api.paystack.co';

function getSecretKey() {
  return process.env.PAYSTACK_SECRET_KEY || '';
}

// Live keys remain blocked until explicitly enabled so real charges are never accidental.
function paymentsStatus() {
  const key = getSecretKey();
  if (!key) return 'missing';
  if (key.startsWith('sk_live_') && process.env.ALLOW_LIVE_PAYMENTS !== 'true') return 'live_blocked';
  return 'ok';
}

async function call(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const json = await res.json().catch(() => null);

  if (!res.ok || !json || json.status !== true) {
    const error = new Error('Paystack request failed');
    error.status = res.status;
    throw error;
  }

  return json.data;
}

const initializeTransaction = payload => call('POST', '/transaction/initialize', payload);
const verifyTransaction = reference => call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);

// Paystack signs RAW request body with HMAC-SHA512 using the secret key.
function verifySignature(rawBody, signature) {
  const key = getSecretKey();
  if (!key || !signature || typeof signature !== 'string' || !Buffer.isBuffer(rawBody)) return false;

  const expected = crypto.createHmac('sha512', key).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { paymentsStatus, initializeTransaction, verifyTransaction, verifySignature };