const pool = require('../../db');
const { toKobo, fromKobo } = require('../utils/payoutRules');

const OPEN = `('pending', 'approved', 'processing')`;

// Saves the earnings of any paid order that does not have a row yet (the fee rate in force is stored with it).
async function syncEarnings(db, sellerId, percent) {
  await db.query(
    `INSERT INTO order_earnings (order_id, seller_id, gross, fee_percent, fee, net)
     SELECT o.id, o.seller_id, o.total, $2::numeric,
            ROUND(o.subtotal * $2::numeric / 100, 2),
            GREATEST(o.total - ROUND(o.subtotal * $2::numeric / 100, 2), 0)
       FROM orders o
       JOIN payments p ON p.order_id = o.id AND p.status = 'successful'
      WHERE o.seller_id = $1
     ON CONFLICT (order_id) DO NOTHING`,
    [sellerId, percent]
  );
}

// pending   = paid orders not delivered yet, or delivered but still inside the hold period
// released  = delivered and past the hold period
// available = released - already paid out - requests still open
async function readRaw(db, sellerId, hold) {
  const e = (await db.query(
    `SELECT
        COALESCE(SUM(e.net) FILTER (WHERE o.status IN ('confirmed', 'processing', 'shipped')
          OR (o.status = 'delivered' AND (o.delivered_at IS NULL OR o.delivered_at > NOW() - make_interval(days => $2::int)))), 0) AS pending,
        COALESCE(SUM(e.net) FILTER (WHERE o.status = 'delivered'
          AND o.delivered_at <= NOW() - make_interval(days => $2::int)), 0) AS released
       FROM order_earnings e
       JOIN orders o ON o.id = e.order_id
       JOIN payments p ON p.order_id = o.id AND p.status = 'successful'
      WHERE e.seller_id = $1`,
    [sellerId, hold]
  )).rows[0];

  const w = (await db.query(
    `SELECT
        COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS withdrawn,
        COALESCE(SUM(amount) FILTER (WHERE status IN ${OPEN}), 0) AS in_review
       FROM withdrawals WHERE seller_id = $1`,
    [sellerId]
  )).rows[0];

  return { pending: toKobo(e.pending), released: toKobo(e.released), withdrawn: toKobo(w.withdrawn), inReview: toKobo(w.in_review) };
}

async function readBalances(db, sellerId, hold) {
  const { pending, released, withdrawn, inReview } = await readRaw(db, sellerId, hold);
  const available = Math.max(released - withdrawn - inReview, 0);

  return {
    pendingKobo: pending, availableKobo: available,
    pendingBalance: fromKobo(pending),
    availableBalance: fromKobo(available),
    withdrawable: fromKobo(available),
    totalEarned: fromKobo(pending + released),
    inReview: fromKobo(inReview),
    withdrawn: fromKobo(withdrawn)
  };
}

async function getBank(userId) {
  const r = await pool.query(
    `SELECT bank_name, bank_code, account_number, account_name, updated_at FROM seller_bank_accounts WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0] || null;
}

const WITHDRAWAL_COLUMNS = `w.id, w.seller_id, w.amount, w.status, w.bank_name, w.bank_code, w.account_number, w.account_name,
  w.admin_note, w.payment_reference, w.reviewed_at, w.paid_at, w.requested_at`;

async function getSummary(sellerId, rules) {
  await syncEarnings(pool, sellerId, rules.feePercent);
  const balances = await readBalances(pool, sellerId, rules.holdDays);
  const history = await pool.query(
    `SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawals w WHERE w.seller_id = $1 ORDER BY w.requested_at DESC LIMIT 50`,
    [sellerId]
  );
  return { balances, bank: await getBank(sellerId), withdrawals: history.rows };
}

// Saves the bank account. Not allowed while a withdrawal is open (so the destination of money
// already requested can never be swapped).
async function saveBank(userId, bank) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const open = await client.query(`SELECT 1 FROM withdrawals WHERE seller_id = $1 AND status IN ${OPEN}`, [userId]);
    if (open.rowCount > 0) { await client.query('ROLLBACK'); return { status: 'open_exists' }; }
    await client.query(
      `INSERT INTO seller_bank_accounts (user_id, bank_name, bank_code, account_number, account_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE
         SET bank_name = EXCLUDED.bank_name, bank_code = EXCLUDED.bank_code,
             account_number = EXCLUDED.account_number, account_name = EXCLUDED.account_name, updated_at = NOW()`,
      [userId, bank.bankName, bank.bankCode, bank.accountNumber, bank.accountName]
    );
    await client.query('COMMIT');
    return { status: 'ok' };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

// The seller's row is locked while we check the balance, so two requests at the same moment
// can never both pass. The database also allows only one open request per seller.
async function requestWithdrawal(sellerId, amount, rules) {
  const client = await pool.connect();
  const stop = async result => { await client.query('ROLLBACK'); return result; };
  try {
    await client.query('BEGIN');
    const lock = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [sellerId]);
    if (!lock.rows[0]) return await stop({ status: 'not_found' });

    const bank = (await client.query(
      `SELECT bank_name, bank_code, account_number, account_name FROM seller_bank_accounts WHERE user_id = $1`, [sellerId]
    )).rows[0];
    if (!bank) return await stop({ status: 'no_bank' });

    const open = await client.query(`SELECT 1 FROM withdrawals WHERE seller_id = $1 AND status IN ${OPEN}`, [sellerId]);
    if (open.rowCount > 0) return await stop({ status: 'open_exists' });

    await syncEarnings(client, sellerId, rules.feePercent);
    const balances = await readBalances(client, sellerId, rules.holdDays);
    if (toKobo(amount) > balances.availableKobo) return await stop({ status: 'insufficient', available: balances.availableBalance });

    const ins = await client.query(
      `INSERT INTO withdrawals (seller_id, amount, status, bank_name, bank_code, account_number, account_name)
       VALUES ($1, $2, 'pending', $3, $4, $5, $6)
       RETURNING id, seller_id, amount, status, bank_name, account_number, account_name, requested_at`,
      [sellerId, amount, bank.bank_name, bank.bank_code, bank.account_number, bank.account_name]
    );
    const w = ins.rows[0];
    await client.query(
      `INSERT INTO withdrawal_events (withdrawal_id, status, note, actor_id) VALUES ($1, 'pending', 'Requested by seller', $2)`,
      [w.id, sellerId]
    );
    await client.query('COMMIT');
    return { status: 'ok', withdrawal: w };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    if (e && e.code === '23505') return { status: 'open_exists' };
    throw e;
  } finally {
    client.release();
  }
}

/* ---------------- admin ---------------- */

const ADMIN_SELECT = `SELECT ${WITHDRAWAL_COLUMNS},
    sp.store_name, u.first_name, u.last_name, u.email AS seller_email, u.phone AS seller_phone
  FROM withdrawals w
  JOIN users u ON u.id = w.seller_id
  LEFT JOIN seller_profiles sp ON sp.user_id = w.seller_id`;

async function adminListWithdrawals({ status, limit, offset }) {
  const rows = await pool.query(
    `${ADMIN_SELECT}
      WHERE ($1::text IS NULL OR w.status = $1::text)
      ORDER BY (w.status IN ${OPEN}) DESC, w.requested_at DESC
      LIMIT $2 OFFSET $3`,
    [status || null, limit, offset]
  );
  const total = await pool.query(`SELECT COUNT(*)::int AS n FROM withdrawals w WHERE ($1::text IS NULL OR w.status = $1::text)`, [status || null]);
  const open = await pool.query(`SELECT COUNT(*)::int AS n FROM withdrawals WHERE status IN ${OPEN}`);
  return { withdrawals: rows.rows, total: total.rows[0].n, openCount: open.rows[0].n };
}

async function adminGetWithdrawal(id) {
  const r = await pool.query(`${ADMIN_SELECT} WHERE w.id = $1`, [id]);
  if (!r.rows[0]) return null;
  const events = await pool.query(
    `SELECT status, note, created_at FROM withdrawal_events WHERE withdrawal_id = $1 ORDER BY id`, [id]
  );
  return { ...r.rows[0], events: events.rows };
}

// Only an open request can be settled, and only once (the WHERE clause is the guard).
async function settle(id, adminId, newStatus, note, reference) {
  try {
    const r = await pool.query(
      `WITH upd AS (
         UPDATE withdrawals
            SET status = $2::varchar, admin_note = $3, payment_reference = $4, reviewed_by = $5, reviewed_at = NOW(),
                paid_at = CASE WHEN $2::varchar = 'paid' THEN NOW() ELSE NULL END, updated_at = NOW()
          WHERE id = $1 AND status IN ('pending', 'approved')
          RETURNING id, status, admin_note, reviewed_by
       )
       INSERT INTO withdrawal_events (withdrawal_id, status, note, actor_id)
       SELECT id, status, admin_note, reviewed_by FROM upd
       RETURNING withdrawal_id`,
      [id, newStatus, note, reference, adminId]
    );
    return r.rowCount > 0 ? { status: 'ok' } : { status: 'not_open' };
  } catch (e) {
    if (e && e.code === '23505') return { status: 'duplicate_reference' };
    throw e;
  }
}

const markPaid = (id, adminId, reference, note) => settle(id, adminId, 'paid', note, reference);
const reject = (id, adminId, note) => settle(id, adminId, 'rejected', note, null);

module.exports = { readRaw, getSummary, saveBank, requestWithdrawal, adminListWithdrawals, adminGetWithdrawal, markPaid, reject };
