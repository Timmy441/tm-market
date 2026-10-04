const pool = require('../../db');

// "Today" and daily charts follow Nigerian time (WAT), not server time.
const TZ = 'Africa/Lagos';
const DAY_START = `(date_trunc('day', NOW() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}')`;

const SERIES_TABLES = { users: 'users', products: 'products' };

// Escape LIKE wildcards so a search for "50%" matches the text, not everything.
function like(text) {
  return `%${String(text).replace(/[\\%_]/g, '\\$&')}%`;
}

async function getStats() {
  const users = (await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE created_at >= ${DAY_START})::int AS today,
       COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS last_7_days,
       COUNT(*) FILTER (WHERE role = 'customer')::int AS customers,
       COUNT(*) FILTER (WHERE role = 'seller')::int AS sellers,
       COUNT(*) FILTER (WHERE role = 'admin')::int AS admins,
       COUNT(*) FILTER (WHERE is_active = FALSE)::int AS suspended
     FROM users`
  )).rows[0];

  const products = (await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status <> 'removed')::int AS total,
       COUNT(*) FILTER (WHERE status = 'active')::int AS active,
       COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
       COUNT(*) FILTER (WHERE status = 'sold')::int AS sold,
       COUNT(*) FILTER (WHERE status = 'removed')::int AS removed,
       COUNT(*) FILTER (WHERE status <> 'removed' AND created_at >= ${DAY_START})::int AS today,
       COUNT(*) FILTER (WHERE status <> 'removed' AND created_at >= NOW() - INTERVAL '7 days')::int AS last_7_days
     FROM products`
  )).rows[0];

  const recentProducts = (await pool.query(
    `SELECT p.id, p.name, p.price, p.status, p.created_at, sp.store_name AS seller_name
     FROM products p
     LEFT JOIN seller_profiles sp ON sp.user_id = p.seller_id
     WHERE p.status <> 'removed'
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT 5`
  )).rows;

  // Orders: real numbers only. If the table is missing, report "not available" instead of inventing 0s.
  let orders = null;
  try {
    const r = await pool.query(`SELECT status, COUNT(*)::int AS n FROM orders GROUP BY status`);
    orders = { total: 0, byStatus: {} };
    for (const row of r.rows) { orders.byStatus[row.status] = row.n; orders.total += row.n; }
  } catch (e) {
    if (e.code !== '42P01') throw e; // 42P01 = table does not exist
  }

  return { users, products, recentProducts, orders };
}

// One row per day for the last N days, including days with zero (so charts are honest).
async function getDailyCounts(table, days) {
  const name = SERIES_TABLES[table];
  if (!name) throw new Error('Unknown series table');

  const r = await pool.query(
    `WITH days AS (
       SELECT generate_series(
         date_trunc('day', NOW() AT TIME ZONE '${TZ}') - (($1::int - 1) * INTERVAL '1 day'),
         date_trunc('day', NOW() AT TIME ZONE '${TZ}'),
         INTERVAL '1 day'
       ) AS d
     )
     SELECT to_char(days.d, 'YYYY-MM-DD') AS date, COUNT(t.id)::int AS count
     FROM days
     LEFT JOIN ${name} t ON date_trunc('day', t.created_at AT TIME ZONE '${TZ}') = days.d
     GROUP BY days.d
     ORDER BY days.d`,
    [days]
  );
  return r.rows;
}

async function listUsers({ search, role, status, limit, offset }) {
  const conditions = [];
  const values = [];

  if (search) {
    values.push(like(search));
    const n = values.length;
    conditions.push(
      `((u.first_name || ' ' || u.last_name) ILIKE $${n} OR u.email ILIKE $${n}
        OR u.phone ILIKE $${n} OR u.phone_normalized ILIKE $${n} OR sp.store_name ILIKE $${n})`
    );
  }
  if (role) { values.push(role); conditions.push(`u.role = $${values.length}`); }
  if (status === 'active') conditions.push('u.is_active = TRUE');
  if (status === 'suspended') conditions.push('u.is_active = FALSE');

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const from = `FROM users u LEFT JOIN seller_profiles sp ON sp.user_id = u.id ${where}`;

  const total = (await pool.query(`SELECT COUNT(*)::int AS total ${from}`, values)).rows[0].total;

  values.push(limit, offset);
  const r = await pool.query(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.role, u.is_active, u.created_at,
            sp.store_name,
            (SELECT COUNT(*)::int FROM products p WHERE p.seller_id = u.id AND p.status <> 'removed') AS product_count
     ${from}
     ORDER BY u.created_at DESC, u.id DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );

  return { users: r.rows, total };
}

// Never selects password_hash.
async function getUserDetail(id) {
  const u = await pool.query(
    `SELECT id, first_name, last_name, email, phone, role, is_active, location, created_at, updated_at
     FROM users WHERE id = $1`,
    [id]
  );
  const user = u.rows[0];
  if (!user) return null;

  const seller = (await pool.query(
    `SELECT store_name, location, whatsapp, created_at FROM seller_profiles WHERE user_id = $1`,
    [id]
  )).rows[0] || null;

  const counts = (await pool.query(
    `SELECT status, COUNT(*)::int AS n FROM products WHERE seller_id = $1 GROUP BY status`,
    [id]
  )).rows;

  const products = { active: 0, pending: 0, sold: 0, removed: 0 };
  for (const row of counts) products[row.status] = row.n;

  return { user, seller, products };
}

// Admin accounts cannot be suspended from the panel (they are managed directly in the database).
async function setUserActive(id, active) {
  const r = await pool.query(
    `UPDATE users SET is_active = $2, updated_at = NOW()
     WHERE id = $1 AND role <> 'admin'
     RETURNING id, is_active`,
    [id, active]
  );
  if (r.rowCount > 0) return { status: 'ok', user: r.rows[0] };

  const exists = await pool.query(`SELECT role FROM users WHERE id = $1`, [id]);
  if (!exists.rows[0]) return { status: 'not_found' };
  return { status: 'admin' };
}

async function listProducts({ search, status, limit, offset }) {
  const conditions = [];
  const values = [];

  if (search) {
    values.push(like(search));
    const n = values.length;
    conditions.push(`(p.name ILIKE $${n} OR p.brand ILIKE $${n} OR p.location ILIKE $${n} OR sp.store_name ILIKE $${n})`);
  }
  if (status) { values.push(status); conditions.push(`p.status = $${values.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const from = `FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN seller_profiles sp ON sp.user_id = p.seller_id
     LEFT JOIN inventory i ON i.product_id = p.id
     ${where}`;

  const total = (await pool.query(`SELECT COUNT(*)::int AS total ${from}`, values)).rows[0].total;

  values.push(limit, offset);
  const r = await pool.query(
    `SELECT p.id, p.name, p.price, p.status, p.location, p.created_at, p.seller_id,
            c.name AS category_name, sp.store_name AS seller_name, i.quantity,
            (SELECT pi.image_url FROM product_images pi WHERE pi.product_id = p.id
             ORDER BY pi.sort_order, pi.id LIMIT 1) AS image_url
     ${from}
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );

  return { products: r.rows, total };
}

// Keeps is_active in step with status, the same way the seller endpoints do.
async function setProductStatus(id, status) {
  const r = await pool.query(
    `UPDATE products
     SET status = $2::varchar, is_active = ($2::varchar <> 'removed'), updated_at = NOW()
     WHERE id = $1
     RETURNING id, status`,
    [id, status]
  );
  return r.rows[0] || null;
}

// ---- orders (tracking) ----

const ORDER_STATUSES = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];

const ORDER_FROM = `
  FROM orders o
  LEFT JOIN users bu ON bu.id = o.user_id
  LEFT JOIN seller_profiles sp ON sp.user_id = o.seller_id
  LEFT JOIN payments pay ON pay.order_id = o.id`;

// Two special filters on top of the real statuses:
//   overdue      = paid, not delivered, and the delivery window has already ended (Nigeria date)
//   refund_check = money was received but the order is cancelled (needs a manual refund in Paystack)
const OVERDUE = `o.status IN ('confirmed', 'processing', 'shipped')
  AND o.delivery_window_end IS NOT NULL
  AND o.delivery_window_end < (NOW() AT TIME ZONE '${TZ}')::date`;
const REFUND_CHECK = `o.status = 'cancelled' AND pay.status = 'successful'`;

async function listOrders({ search, status, limit, offset }) {
  const where = [];
  const params = [];

  if (status === 'overdue') where.push(`(${OVERDUE})`);
  else if (status === 'refund_check') where.push(`(${REFUND_CHECK})`);
  else if (status) { params.push(status); where.push(`o.status = $${params.length}`); }

  if (search) {
    params.push(like(search));
    const n = params.length;
    where.push(`(o.order_number ILIKE $${n} OR bu.email ILIKE $${n}
                 OR (bu.first_name || ' ' || bu.last_name) ILIKE $${n}
                 OR sp.store_name ILIKE $${n})`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = (await pool.query(`SELECT COUNT(*)::int AS n ${ORDER_FROM} ${clause}`, params)).rows[0].n;

  params.push(limit, offset);
  const rows = (await pool.query(
    `SELECT o.id, o.order_number, o.status, o.total, o.created_at,
            to_char(o.delivery_window_start, 'YYYY-MM-DD') AS delivery_window_start,
            to_char(o.delivery_window_end, 'YYYY-MM-DD') AS delivery_window_end,
            bu.first_name AS buyer_first_name, bu.last_name AS buyer_last_name, bu.email AS buyer_email,
            sp.store_name AS seller_name, pay.status AS payment_status
     ${ORDER_FROM} ${clause}
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )).rows;

  return { orders: rows, total };
}

async function getOrderDetail(id) {
  const r = await pool.query(
    `SELECT o.id, o.order_number, o.status, o.subtotal, o.shipping_fee, o.discount, o.total,
            o.shipping_name, o.shipping_phone, o.shipping_address, o.shipping_city, o.shipping_state, o.shipping_country,
            o.created_at, o.shipped_at, o.delivered_at,
            to_char(o.delivery_window_start, 'YYYY-MM-DD') AS delivery_window_start,
            to_char(o.delivery_window_end, 'YYYY-MM-DD') AS delivery_window_end,
            bu.first_name AS buyer_first_name, bu.last_name AS buyer_last_name, bu.email AS buyer_email, bu.phone AS buyer_phone,
            o.seller_id, sp.store_name AS seller_name, su.email AS seller_email,
            pay.status AS payment_status, pay.transaction_reference AS payment_reference, pay.paid_at,
            COALESCE((SELECT json_agg(json_build_object('name', oi.product_name, 'quantity', oi.quantity,
                        'unit_price', oi.unit_price, 'total_price', oi.total_price) ORDER BY oi.id)
                      FROM order_items oi WHERE oi.order_id = o.id), '[]'::json) AS items,
            COALESCE((SELECT json_agg(json_build_object('status', oe.status, 'note', oe.note, 'at', oe.created_at)
                        ORDER BY oe.created_at, oe.id)
                      FROM order_events oe WHERE oe.order_id = o.id), '[]'::json) AS events
     ${ORDER_FROM}
     LEFT JOIN users su ON su.id = o.seller_id
     WHERE o.id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

// Moves an order forward only from the allowed current statuses, and records the step.
async function adminAdvanceOrder(id, newStatus, fromStatuses, note) {
  const r = await pool.query(
    `WITH upd AS (
       UPDATE orders
          SET status = $2::text,
              shipped_at = CASE WHEN $2::text = 'shipped' THEN NOW() ELSE shipped_at END,
              delivered_at = CASE WHEN $2::text = 'delivered' THEN NOW() ELSE delivered_at END,
              updated_at = NOW()
        WHERE id = $1 AND status = ANY($3::text[])
        RETURNING id
     )
     INSERT INTO order_events (order_id, status, note)
     SELECT id, $2::text, $4::text FROM upd
     RETURNING order_id`,
    [id, newStatus, fromStatuses, note || null]
  );
  return r.rowCount > 0;
}

async function adminSetDeliveryWindow(id, from, to) {
  const r = await pool.query(
    `WITH upd AS (
       UPDATE orders
          SET delivery_window_start = $2::date, delivery_window_end = $3::date, updated_at = NOW()
        WHERE id = $1 AND status IN ('confirmed', 'processing', 'shipped')
        RETURNING id, status
     )
     INSERT INTO order_events (order_id, status, note)
     SELECT id, status, $4::text FROM upd
     RETURNING order_id`,
    [id, from, to, `Delivery expected between ${from} and ${to}`]
  );
  return r.rowCount > 0;
}

module.exports = {
  ORDER_STATUSES,
  listOrders,
  getOrderDetail,
  adminAdvanceOrder,
  adminSetDeliveryWindow,
  getStats,
  getDailyCounts,
  listUsers,
  getUserDetail,
  setUserActive,
  listProducts,
  setProductStatus
};
