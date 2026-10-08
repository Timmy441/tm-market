// Records a refund that the admin has ALREADY sent from the Paystack dashboard.
// It never moves money. It marks the payment refunded, cancels the order, and (because seller earnings only count
// orders with a successful payment) removes that order's earnings from the seller's balance.
// If the seller has already withdrawn (or requested) money that includes this order, nothing is changed.
const pool = require('../../db');
const { readRaw } = require('./payoutModel');

// Outcomes: ok | not_found | not_paid | already_refunded | duplicate_reference | already_withdrawn
async function recordRefund(orderId, adminId, reference, note, holdDays) {
  const client = await pool.connect();
  const stop = async result => { await client.query('ROLLBACK'); return result; };
  try {
    await client.query('BEGIN');

    // Lock order, then payment, then the seller row (the same row a withdrawal request locks), so nothing can slip in between.
    const order = (await client.query(
      `SELECT id, order_number, status, seller_id FROM orders WHERE id = $1 FOR UPDATE`, [orderId]
    )).rows[0];
    if (!order) return await stop({ status: 'not_found' });

    const payment = (await client.query(
      `SELECT id, status FROM payments WHERE order_id = $1 FOR UPDATE`, [orderId]
    )).rows[0];
    if (!payment) return await stop({ status: 'not_paid' });
    if (payment.status === 'refunded') return await stop({ status: 'already_refunded' });
    if (payment.status !== 'successful') return await stop({ status: 'not_paid' });

    if (order.seller_id != null) await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [order.seller_id]);

    // The WHERE clause is the guard: only a successful payment can become refunded, and only once.
    const upd = await client.query(
      `UPDATE payments
          SET status = 'refunded', refund_reference = $2, refund_note = $3, refunded_at = NOW(), refunded_by = $4, updated_at = NOW()
        WHERE order_id = $1 AND status = 'successful'
        RETURNING id`,
      [orderId, reference, note, adminId]
    );
    if (upd.rowCount === 0) return await stop({ status: 'already_refunded' });

    // Would this refund push the seller below what they have already taken or requested? Then undo everything.
    if (order.seller_id != null) {
      const raw = await readRaw(client, order.seller_id, holdDays);
      if (raw.released < raw.withdrawn + raw.inReview) return await stop({ status: 'already_withdrawn' });
    }

    await client.query(`UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND status <> 'cancelled'`, [orderId]);
    await client.query(
      `INSERT INTO order_events (order_id, status, note) VALUES ($1, 'cancelled', 'Payment refunded by TM Market support')`, [orderId]
    );
    await client.query('COMMIT');
    return { status: 'ok', orderNumber: order.order_number };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    if (e && e.code === '23505') return { status: 'duplicate_reference' };
    throw e;
  } finally {
    client.release();
  }
}

// Facts for the emails and the log. Read-only.
async function getRefundInfo(orderId) {
  const r = await pool.query(
    `SELECT o.id, o.order_number, pay.amount, pay.status AS payment_status, pay.refund_reference,
            bu.first_name AS buyer_first_name, bu.email AS buyer_email,
            sp.store_name AS seller_name, su.email AS seller_email
       FROM orders o
       LEFT JOIN payments pay ON pay.order_id = o.id
       LEFT JOIN users bu ON bu.id = o.user_id
       LEFT JOIN users su ON su.id = o.seller_id
       LEFT JOIN seller_profiles sp ON sp.user_id = o.seller_id
      WHERE o.id = $1`,
    [orderId]
  );
  return r.rows[0] || null;
}

module.exports = { recordRefund, getRefundInfo };
