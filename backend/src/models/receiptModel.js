const pool = require('../../db');

// Everything a payment receipt shows, read straight from the database. Nothing is stored or invented.
// The caller decides who may see it: the buyer of the order, or an admin.
async function getReceiptData(orderId) {
  const o = await pool.query(
    `SELECT o.id, o.order_number, o.user_id, o.status,
            o.subtotal, o.shipping_fee, o.discount, o.total,
            o.shipping_name, o.shipping_phone, o.shipping_address,
            o.shipping_city, o.shipping_state, o.shipping_country,
            sp.store_name AS seller_name,
            u.first_name, u.last_name, u.email,
            p.status AS payment_status, p.provider, p.transaction_reference,
            p.amount AS payment_amount, p.paid_at
     FROM orders o
     LEFT JOIN seller_profiles sp ON sp.user_id = o.seller_id
     LEFT JOIN users u ON u.id = o.user_id
     LEFT JOIN payments p ON p.order_id = o.id
     WHERE o.id = $1`,
    [orderId]
  );
  if (!o.rows[0]) return null;

  const items = await pool.query(
    `SELECT product_name, quantity, unit_price, total_price
     FROM order_items WHERE order_id = $1 ORDER BY id`,
    [orderId]
  );
  return { ...o.rows[0], items: items.rows };
}

module.exports = { getReceiptData };
