const crypto = require('crypto');
const pool = require('../../db');

// One query shape for every order read. Items are collected into a JSON array.
const ORDER_SELECT = `
  SELECT
    o.id, o.order_number, o.status, o.user_id, o.seller_id,
    o.subtotal, o.shipping_fee, o.discount, o.total,
    o.shipping_name, o.shipping_phone, o.shipping_address,
    o.shipping_city, o.shipping_state, o.shipping_country,
    o.created_at, o.updated_at,
    to_char(o.delivery_window_start, 'YYYY-MM-DD') AS delivery_window_start,
    to_char(o.delivery_window_end, 'YYYY-MM-DD') AS delivery_window_end,
    o.shipped_at, o.delivered_at,
    sp.store_name AS seller_name,
    COALESCE((
      SELECT json_agg(json_build_object(
        'status', oe.status,
        'note', oe.note,
        'at', oe.created_at
      ) ORDER BY oe.created_at, oe.id)
      FROM order_events oe WHERE oe.order_id = o.id
    ), '[]'::json) AS events,
    COALESCE((
      SELECT json_agg(json_build_object(
        'product_id', oi.product_id,
        'name', oi.product_name,
        'quantity', oi.quantity,
        'unit_price', oi.unit_price,
        'total_price', oi.total_price
      ) ORDER BY oi.id)
      FROM order_items oi WHERE oi.order_id = o.id
    ), '[]'::json) AS items
  FROM orders o
  LEFT JOIN seller_profiles sp ON sp.user_id = o.seller_id`;

// Readable, hard-to-guess order numbers, e.g. TM-20261003-K7Q2M9XA
function newOrderNumber() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `TM-${d}-${code}`;
}

// Everything the checkout needs to know about the products in a bag, read fresh from the database.
async function getProductsForCheckout(ids) {
  const r = await pool.query(
    `SELECT p.id, p.name, p.sku, p.price, p.status, p.is_active, p.seller_id,
            su.is_active AS seller_active, i.quantity
     FROM products p
     LEFT JOIN users su ON su.id = p.seller_id
     LEFT JOIN inventory i ON i.product_id = p.id
     WHERE p.id = ANY($1::bigint[])`,
    [ids]
  );
  return r.rows;
}

async function countPendingOrders(userId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM orders WHERE user_id = $1 AND status = 'pending'`,
    [userId]
  );
  return r.rows[0].n;
}

// groups: [{ sellerId, subtotal, items: [{ productId, name, sku, quantity, unitPrice, totalPrice }] }]
// All orders for one checkout are saved together or not at all.
async function createOrders(userId, shipping, groups) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = [];

    for (const g of groups) {
      let orderId = null;

      for (let attempt = 0; attempt < 5 && !orderId; attempt++) {
        const r = await client.query(
          `INSERT INTO orders (
             user_id, seller_id, order_number, status, subtotal, shipping_fee, discount, total,
             shipping_name, shipping_phone, shipping_address, shipping_city, shipping_state
           )
           VALUES ($1, $2, $3, 'pending', $4, 0, 0, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (order_number) DO NOTHING
           RETURNING id`,
          [userId, g.sellerId, newOrderNumber(), g.subtotal,
           shipping.name, shipping.phone, shipping.address, shipping.city, shipping.state]
        );
        if (r.rows[0]) orderId = r.rows[0].id;
      }
      if (!orderId) throw new Error('Could not generate a unique order number');

      for (const it of g.items) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, product_name, product_sku, quantity, unit_price, total_price)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [orderId, it.productId, it.name, it.sku || null, it.quantity, it.unitPrice, it.totalPrice]
        );
      }
      ids.push(orderId);
    }

    await client.query('COMMIT');

    const out = await pool.query(`${ORDER_SELECT} WHERE o.id = ANY($1::bigint[]) ORDER BY o.id`, [ids]);
    return out.rows;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function listMyOrders(userId, limit, offset) {
  const rows = (await pool.query(
    `${ORDER_SELECT} WHERE o.user_id = $1 ORDER BY o.created_at DESC, o.id DESC LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  )).rows;
  const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM orders WHERE user_id = $1`, [userId])).rows[0].n;
  return { orders: rows, total };
}

// Only the buyer's own order is ever returned.
async function findMyOrder(id, userId) {
  const r = await pool.query(`${ORDER_SELECT} WHERE o.id = $1 AND o.user_id = $2`, [id, userId]);
  return r.rows[0] || null;
}

// Succeeds only while the order is still unpaid ('pending') and belongs to this buyer.
async function cancelMyOrder(id, userId) {
  const r = await pool.query(
    `UPDATE orders SET status = 'cancelled', updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'pending'
     RETURNING id`,
    [id, userId]
  );
  return r.rowCount > 0;
}

// Sellers only see orders that are paid (confirmed or later). Unpaid orders stay invisible to them.
async function listSellerOrders(sellerId, limit, offset) {
  const statuses = `('confirmed', 'processing', 'shipped', 'delivered')`;
  const rows = (await pool.query(
    `${ORDER_SELECT} WHERE o.seller_id = $1 AND o.status IN ${statuses}
     ORDER BY o.created_at DESC, o.id DESC LIMIT $2 OFFSET $3`,
    [sellerId, limit, offset]
  )).rows;
  const total = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM orders WHERE seller_id = $1 AND status IN ${statuses}`,
    [sellerId]
  )).rows[0].n;
  return { orders: rows, total };
}

// ---- tracking ----

// A paid order that belongs to this seller (never an unpaid one).
async function findSellerOrder(id, sellerId) {
  const r = await pool.query(
    `${ORDER_SELECT} WHERE o.id = $1 AND o.seller_id = $2
       AND o.status IN ('confirmed', 'processing', 'shipped', 'delivered')`,
    [id, sellerId]
  );
  return r.rows[0] || null;
}

// Moves a seller's order forward (only from one of the allowed current statuses) and records the step.
async function advanceSellerOrder(id, sellerId, newStatus, fromStatuses, note) {
  const r = await pool.query(
    `WITH upd AS (
       UPDATE orders
          SET status = $3::text,
              shipped_at = CASE WHEN $3::text = 'shipped' THEN NOW() ELSE shipped_at END,
              updated_at = NOW()
        WHERE id = $1 AND seller_id = $2 AND status = ANY($4::text[])
        RETURNING id
     )
     INSERT INTO order_events (order_id, status, note)
     SELECT id, $3::text, $5::text FROM upd
     RETURNING order_id`,
    [id, sellerId, newStatus, fromStatuses, note || null]
  );
  return r.rowCount > 0;
}

// Sets or changes the delivery date range (only on a paid order that is not yet delivered).
async function setDeliveryWindow(id, sellerId, from, to, note) {
  const r = await pool.query(
    `WITH upd AS (
       UPDATE orders
          SET delivery_window_start = $3::date, delivery_window_end = $4::date, updated_at = NOW()
        WHERE id = $1 AND seller_id = $2 AND status IN ('confirmed', 'processing', 'shipped')
        RETURNING id, status
     )
     INSERT INTO order_events (order_id, status, note)
     SELECT id, status, $5::text FROM upd
     RETURNING order_id`,
    [id, sellerId, from, to, note || null]
  );
  return r.rowCount > 0;
}

// The buyer confirms the parcel arrived. Only works while the order is 'shipped'.
async function confirmDeliveredByBuyer(id, userId) {
  const r = await pool.query(
    `WITH upd AS (
       UPDATE orders
          SET status = 'delivered', delivered_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND status = 'shipped'
        RETURNING id
     )
     INSERT INTO order_events (order_id, status, note)
     SELECT id, 'delivered', 'Buyer confirmed delivery' FROM upd
     RETURNING order_id`,
    [id, userId]
  );
  return r.rowCount > 0;
}

module.exports = {
  findSellerOrder,
  advanceSellerOrder,
  setDeliveryWindow,
  confirmDeliveredByBuyer,
  getProductsForCheckout,
  countPendingOrders,
  createOrders,
  listMyOrders,
  findMyOrder,
  cancelMyOrder,
  listSellerOrders
};
