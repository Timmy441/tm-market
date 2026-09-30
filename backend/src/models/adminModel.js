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

module.exports = {
  getStats,
  getDailyCounts,
  listUsers,
  getUserDetail,
  setUserActive,
  listProducts,
  setProductStatus
};
