const pool = require('../../db');

// Read-only. Every query is limited to the logged-in buyer's own orders (user_id = $1).
const COLUMNS = `
  o.id, o.order_number, o.status, o.total, o.created_at,
  to_char(o.delivery_window_start, 'YYYY-MM-DD') AS delivery_window_start,
  to_char(o.delivery_window_end, 'YYYY-MM-DD') AS delivery_window_end,
  o.shipped_at, o.delivered_at,
  sp.store_name AS seller_name`;

const FROM = `FROM orders o LEFT JOIN seller_profiles sp ON sp.user_id = o.seller_id`;

async function recentOrdersForUser(userId, limit = 3) {
  const r = await pool.query(
    `SELECT ${COLUMNS} ${FROM} WHERE o.user_id = $1 ORDER BY o.created_at DESC, o.id DESC LIMIT $2`,
    [userId, limit]
  );
  return r.rows;
}

async function orderByNumberForUser(userId, orderNumber) {
  const r = await pool.query(
    `SELECT ${COLUMNS} ${FROM} WHERE o.user_id = $1 AND o.order_number = $2`,
    [userId, orderNumber]
  );
  return r.rows[0] || null;
}

module.exports = { recentOrdersForUser, orderByNumberForUser };
