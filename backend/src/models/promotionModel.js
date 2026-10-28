const pool = require('../../db');

// What state a paid promotion is in right now. "ended" needs no background job: it is worked out from ends_at.
const STATE_SQL = `(CASE
    WHEN s.status = 'pending' THEN 'pending'
    WHEN s.status = 'paused' THEN 'paused'
    WHEN s.status = 'removed' THEN 'removed'
    WHEN s.ends_at <= NOW() THEN 'ended'
    WHEN s.starts_at > NOW() THEN 'scheduled'
    ELSE 'running' END)`;

const ROW_SELECT = `s.id, s.product_id, s.seller_id, s.plan_days, s.amount, s.reference, s.status,
       s.paid_at, s.starts_at, s.ends_at, s.paused_at, s.created_at, ${STATE_SQL} AS state`;

// The seller's own product, with the email Paystack needs. Null if it is not theirs.
async function findPromotableProduct(productId, sellerId) {
  const r = await pool.query(
    `SELECT p.id, p.name, p.status, p.is_active, i.quantity, u.email
     FROM products p
     JOIN users u ON u.id = p.seller_id
     LEFT JOIN inventory i ON i.product_id = p.id
     WHERE p.id = $1 AND p.seller_id = $2`,
    [productId, sellerId]
  );
  return r.rows[0] || null;
}

// A paid promotion that is still running, waiting to start, or paused. Used to stop a second purchase.
async function findBlockingPromotion(productId) {
  const r = await pool.query(
    `SELECT id, status, ends_at FROM sponsored_listings
     WHERE product_id = $1 AND (status = 'paused' OR (status = 'active' AND ends_at > NOW()))
     ORDER BY ends_at DESC LIMIT 1`,
    [productId]
  );
  return r.rows[0] || null;
}

async function createPendingPromotion({ productId, sellerId, planDays, amount, reference }) {
  const r = await pool.query(
    `INSERT INTO sponsored_listings (product_id, seller_id, plan_days, amount, reference, status)
     VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
    [productId, sellerId, planDays, amount, reference]
  );
  return r.rows[0].id;
}

async function deletePendingPromotion(id) {
  await pool.query(`DELETE FROM sponsored_listings WHERE id = $1 AND status = 'pending'`, [id]);
}

async function findPromotionByReference(reference, sellerId) {
  const r = await pool.query(
    `SELECT s.id FROM sponsored_listings s WHERE s.reference = $1 AND ($2::bigint IS NULL OR s.seller_id = $2)`,
    [reference, sellerId == null ? null : sellerId]
  );
  return r.rows[0] || null;
}

// Outcomes: activated | already_active | amount_mismatch | unknown_reference
// Only the call that actually switches pending -> active returns 'activated', so the admin email is sent once
// even when the webhook and the seller's return page both arrive.
async function confirmPromotionPayment(reference, paidKobo, currency) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(
      `SELECT id, product_id, plan_days, amount, status FROM sponsored_listings WHERE reference = $1 FOR UPDATE`,
      [reference]
    )).rows[0];
    if (!row) { await client.query('ROLLBACK'); return { outcome: 'unknown_reference' }; }
    if (row.status !== 'pending') { await client.query('ROLLBACK'); return { outcome: 'already_active', id: row.id }; }

    const expected = Math.round(Number(row.amount) * 100);
    if (Number(paidKobo) !== expected || currency !== 'NGN') {
      await client.query('ROLLBACK');
      return { outcome: 'amount_mismatch', id: row.id };
    }

    // Serialise payments for the same product. If it already has a promotion running, the new one starts when that ends.
    await client.query(`SELECT id FROM products WHERE id = $1 FOR UPDATE`, [row.product_id]);
    const start = (await client.query(
      `SELECT GREATEST(NOW(), COALESCE(MAX(ends_at), NOW())) AS start
       FROM sponsored_listings WHERE product_id = $1 AND status = 'active' AND ends_at > NOW() AND id <> $2`,
      [row.product_id, row.id]
    )).rows[0].start;

    const done = (await client.query(
      `UPDATE sponsored_listings
       SET status = 'active', paid_at = NOW(), starts_at = $2::timestamptz,
           ends_at = $2::timestamptz + ($3::int * INTERVAL '1 day'), updated_at = NOW()
       WHERE id = $1 RETURNING id, starts_at, ends_at`,
      [row.id, start, row.plan_days]
    )).rows[0];
    await client.query('COMMIT');
    return { outcome: 'activated', id: done.id, startsAt: done.starts_at, endsAt: done.ends_at };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// The seller's paid promotions (unpaid attempts are never shown).
async function listSellerPromotions(sellerId) {
  const r = await pool.query(
    `SELECT ${ROW_SELECT}, p.name AS product_name
     FROM sponsored_listings s LEFT JOIN products p ON p.id = s.product_id
     WHERE s.seller_id = $1 AND s.status <> 'pending'
     ORDER BY s.created_at DESC LIMIT 100`,
    [sellerId]
  );
  return r.rows;
}

const ADMIN_STATES = ['running', 'scheduled', 'paused', 'ended', 'removed'];

async function adminListPromotions({ state, limit, offset }) {
  const values = [];
  let where = `s.status <> 'pending'`;
  if (ADMIN_STATES.includes(state)) { values.push(state); where += ` AND ${STATE_SQL} = $${values.length}`; }

  const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM sponsored_listings s WHERE ${where}`, values)).rows[0].n;
  values.push(limit, offset);
  const rows = (await pool.query(
    `SELECT ${ROW_SELECT}, p.name AS product_name, sp.store_name AS seller_name, u.email AS seller_email
     FROM sponsored_listings s
     LEFT JOIN products p ON p.id = s.product_id
     LEFT JOIN seller_profiles sp ON sp.user_id = s.seller_id
     LEFT JOIN users u ON u.id = s.seller_id
     WHERE ${where} ORDER BY s.created_at DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  )).rows;

  const sum = (await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS total,
            COALESCE(SUM(amount) FILTER (WHERE paid_at > NOW() - INTERVAL '30 days'), 0)::float AS last30,
            COUNT(*)::int AS sold,
            COUNT(*) FILTER (WHERE status = 'active' AND starts_at <= NOW() AND ends_at > NOW())::int AS running
     FROM sponsored_listings WHERE paid_at IS NOT NULL`
  )).rows[0];
  return { promotions: rows, total, summary: sum };
}

// action: pause | resume | remove. Returns { result: 'ok' | 'not_found' | 'bad_state', promotion }.
async function adminChangePromotion(id, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(
      `SELECT id, status, starts_at, ends_at, paused_at FROM sponsored_listings WHERE id = $1 FOR UPDATE`, [id]
    )).rows[0];
    if (!row || row.status === 'pending') { await client.query('ROLLBACK'); return { result: 'not_found' }; }

    if (action === 'pause') {
      const live = row.status === 'active' && new Date(row.ends_at) > new Date();
      if (!live) { await client.query('ROLLBACK'); return { result: 'bad_state' }; }
      await client.query(`UPDATE sponsored_listings SET status = 'paused', paused_at = NOW(), updated_at = NOW() WHERE id = $1`, [id]);
    } else if (action === 'resume') {
      if (row.status !== 'paused') { await client.query('ROLLBACK'); return { result: 'bad_state' }; }
      // The paused time is given back, so the seller does not lose days they paid for.
      await client.query(
        `UPDATE sponsored_listings
         SET status = 'active',
             ends_at = ends_at + (NOW() - paused_at),
             starts_at = CASE WHEN starts_at > paused_at THEN starts_at + (NOW() - paused_at) ELSE starts_at END,
             paused_at = NULL, updated_at = NOW()
         WHERE id = $1`, [id]
      );
    } else {
      if (!['active', 'paused'].includes(row.status)) { await client.query('ROLLBACK'); return { result: 'bad_state' }; }
      await client.query(`UPDATE sponsored_listings SET status = 'removed', removed_at = NOW(), updated_at = NOW() WHERE id = $1`, [id]);
    }
    const promotion = (await client.query(`SELECT ${ROW_SELECT} FROM sponsored_listings s WHERE s.id = $1`, [id])).rows[0];
    await client.query('COMMIT');
    return { result: 'ok', promotion };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Facts for the "seller paid for a promotion" alert email. Read-only.
async function getPromotionAlertInfo(id) {
  const r = await pool.query(
    `SELECT s.plan_days, s.amount, s.reference, s.starts_at, s.ends_at,
            p.name AS product_name, sp.store_name AS seller_name, u.email AS seller_email
     FROM sponsored_listings s
     LEFT JOIN products p ON p.id = s.product_id
     LEFT JOIN seller_profiles sp ON sp.user_id = s.seller_id
     LEFT JOIN users u ON u.id = s.seller_id
     WHERE s.id = $1`, [id]
  );
  return r.rows[0] || null;
}

module.exports = {
  findPromotableProduct, findBlockingPromotion, createPendingPromotion, deletePendingPromotion,
  findPromotionByReference, confirmPromotionPayment, listSellerPromotions,
  adminListPromotions, adminChangePromotion, getPromotionAlertInfo
};
