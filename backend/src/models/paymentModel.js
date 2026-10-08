const pool = require('../../db');
const { defaultWindowDays } = require('../utils/delivery');

// The buyer's own order plus buyer email for Paystack initialization.
async function findOrderForPayment(orderId, userId) {
  const r = await pool.query(
    `SELECT o.id, o.order_number, o.status, o.total, o.user_id, u.email
     FROM orders o
     JOIN users u ON u.id = o.user_id
     WHERE o.id = $1 AND o.user_id = $2`,
    [orderId, userId]
  );
  return r.rows[0] || null;
}

// One payment row per order; pending attempts can replace each other until successful.
async function savePendingPayment(orderId, reference, amount) {
  const r = await pool.query(
    `INSERT INTO payments (order_id, provider, transaction_reference, amount, status)
     VALUES ($1, 'paystack', $2, $3, 'pending')
     ON CONFLICT (order_id) DO UPDATE
       SET provider = 'paystack',
           transaction_reference = EXCLUDED.transaction_reference,
           amount = EXCLUDED.amount,
           status = 'pending',
           updated_at = NOW()
     WHERE payments.status <> 'successful'
     RETURNING id`,
    [orderId, reference, amount]
  );
  return r.rowCount > 0;
}

// Outcomes: paid | already_paid | duplicate_payment | amount_mismatch | no_payment_record |
//           unknown_order | paid_but_cancelled | oversold | unexpected_status
async function confirmPayment(orderId, reference, paidKobo, currency) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const order = (await client.query(
      `SELECT id, order_number, status, total FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId]
    )).rows[0];

    if (!order) {
      await client.query('ROLLBACK');
      return { outcome: 'unknown_order' };
    }

    const payment = (await client.query(
      `SELECT id, status, transaction_reference FROM payments WHERE order_id = $1 FOR UPDATE`,
      [orderId]
    )).rows[0];

    if (!payment) {
      await client.query('ROLLBACK');
      return { outcome: 'no_payment_record', orderNumber: order.order_number };
    }

    if (payment.status === 'successful') {
      await client.query('ROLLBACK');
      return {
        outcome: payment.transaction_reference === reference ? 'already_paid' : 'duplicate_payment',
        orderNumber: order.order_number
      };
    }

    const expectedKobo = Math.round(Number(order.total) * 100);
    if (paidKobo !== expectedKobo || currency !== 'NGN') {
      await client.query('ROLLBACK');
      return { outcome: 'amount_mismatch', orderNumber: order.order_number };
    }

    const markPaid = () => client.query(
      `UPDATE payments
       SET status = 'successful', transaction_reference = $2, paid_at = NOW(), updated_at = NOW()
       WHERE order_id = $1`,
      [orderId, reference]
    );

    if (order.status === 'cancelled') {
      await markPaid();
      await client.query('COMMIT');
      return { outcome: 'paid_but_cancelled', orderNumber: order.order_number };
    }

    if (order.status !== 'pending') {
      await client.query('ROLLBACK');
      return { outcome: 'unexpected_status', orderNumber: order.order_number };
    }

    // Lock inventory rows in a fixed order to avoid deadlocks on concurrent confirms.
    const items = (await client.query(
      `SELECT product_id, quantity FROM order_items
       WHERE order_id = $1 AND product_id IS NOT NULL ORDER BY product_id`,
      [orderId]
    )).rows;

    let oversold = false;
    const stock = [];

    for (const item of items) {
      const inv = (await client.query(
        `SELECT quantity FROM inventory WHERE product_id = $1 FOR UPDATE`,
        [item.product_id]
      )).rows[0];

      if (!inv) continue;

      if (Number(inv.quantity) < item.quantity) {
        oversold = true;
        break;
      }
      stock.push(item);
    }

    if (oversold) {
      await markPaid();
      await client.query(`UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [orderId]);
      await client.query('COMMIT');
      return { outcome: 'oversold', orderNumber: order.order_number };
    }

    for (const item of stock) {
      await client.query(
        `UPDATE inventory SET quantity = quantity - $2, updated_at = NOW() WHERE product_id = $1`,
        [item.product_id, item.quantity]
      );
    }

    await markPaid();
    // Paid: confirm the order and give the buyer an expected delivery date range (Nigeria time).
    // The seller can adjust the range later.
    const days = defaultWindowDays();
    await client.query(
      `UPDATE orders
       SET status = 'confirmed',
           delivery_window_start = (NOW() AT TIME ZONE 'Africa/Lagos')::date + $2::int,
           delivery_window_end = (NOW() AT TIME ZONE 'Africa/Lagos')::date + $3::int,
           updated_at = NOW()
       WHERE id = $1`,
      [orderId, days.min, days.max]
    );
    await client.query(
      `INSERT INTO order_events (order_id, status, note) VALUES ($1, 'confirmed', 'Payment received')`,
      [orderId]
    );
    await client.query('COMMIT');

    return { outcome: 'paid', orderNumber: order.order_number };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Facts for the "new order" alert email to the admin. Read-only.
async function getOrderAlertInfo(orderId) {
  const r = await pool.query(
    `SELECT o.order_number, o.total, o.shipping_name, o.shipping_phone, o.shipping_address, o.shipping_city, o.shipping_state,
            bu.first_name AS buyer_first_name, bu.last_name AS buyer_last_name, bu.email AS buyer_email,
            sp.store_name AS seller_name, su.email AS seller_email,
            to_char(o.delivery_window_start, 'YYYY-MM-DD') AS delivery_window_start,
            to_char(o.delivery_window_end, 'YYYY-MM-DD') AS delivery_window_end,
            COALESCE((SELECT json_agg(json_build_object('name', oi.product_name, 'quantity', oi.quantity) ORDER BY oi.id)
                      FROM order_items oi WHERE oi.order_id = o.id), '[]'::json) AS items
     FROM orders o
     LEFT JOIN users bu ON bu.id = o.user_id
     LEFT JOIN seller_profiles sp ON sp.user_id = o.seller_id
     LEFT JOIN users su ON su.id = o.seller_id
     WHERE o.id = $1`,
    [orderId]
  );
  return r.rows[0] || null;
}

module.exports = { findOrderForPayment, savePendingPayment, confirmPayment, getOrderAlertInfo };