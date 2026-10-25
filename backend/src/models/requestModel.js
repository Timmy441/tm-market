const pool = require('../../db');

const IMAGES = `COALESCE((SELECT json_agg(i.image_url ORDER BY i.sort_order, i.id)
                          FROM product_request_images i WHERE i.request_id = r.id), '[]'::json) AS images`;

const BASE = `r.id, r.title, r.description, r.budget, r.location, r.status, r.admin_note,
              r.created_at, r.reviewed_at, c.name AS category_name, ${IMAGES}`;
const JOINS = `FROM product_requests r LEFT JOIN categories c ON c.id = r.category_id`;

async function createRequest(userId, d) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO product_requests (user_id, title, description, category_id, budget, location)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [userId, d.title, d.description, d.categoryId || null, d.budget || null, d.location || null]
    );
    const id = r.rows[0].id;
    for (let i = 0; i < d.images.length; i++) {
      await client.query(
        `INSERT INTO product_request_images (request_id, image_url, sort_order) VALUES ($1, $2, $3)`,
        [id, d.images[i], i]
      );
    }
    await client.query('COMMIT');
    return id;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Used for per-customer limits (spam protection).
async function countRecent(userId) {
  const r = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS today
     FROM product_requests WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0];
}

async function listMine(userId) {
  const r = await pool.query(
    `SELECT ${BASE} ${JOINS} WHERE r.user_id = $1 ORDER BY r.created_at DESC, r.id DESC LIMIT 100`,
    [userId]
  );
  return r.rows;
}

// Public: only approved / fulfilled, and never any customer details.
async function listPublic({ limit, offset }) {
  const where = `r.status IN ('approved', 'fulfilled')`;
  const rows = await pool.query(
    `SELECT r.id, r.title, r.description, r.budget, r.location, r.status, r.created_at,
            c.name AS category_name, ${IMAGES}
     ${JOINS} WHERE ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const total = await pool.query(`SELECT COUNT(*)::int AS n FROM product_requests r WHERE ${where}`);
  return { requests: rows.rows, total: total.rows[0].n };
}

/* ---------------- admin ---------------- */

const ADMIN_WHO = `u.first_name || ' ' || u.last_name AS customer_name, u.email AS customer_email, u.phone AS customer_phone`;

async function listAdmin({ status, search, limit, offset }) {
  const cond = [];
  const vals = [];
  if (status) { vals.push(status); cond.push(`r.status = $${vals.length}`); }
  if (search) { vals.push(`%${search}%`); cond.push(`(r.title ILIKE $${vals.length} OR u.email ILIKE $${vals.length} OR u.first_name ILIKE $${vals.length} OR u.last_name ILIKE $${vals.length})`); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  const from = `FROM product_requests r JOIN users u ON u.id = r.user_id LEFT JOIN categories c ON c.id = r.category_id`;

  const total = await pool.query(`SELECT COUNT(*)::int AS n ${from} ${where}`, vals);
  vals.push(limit, offset);
  const rows = await pool.query(
    `SELECT ${BASE}, ${ADMIN_WHO} ${from} ${where}
     ORDER BY (r.status = 'pending') DESC, r.created_at DESC, r.id DESC
     LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
    vals
  );
  return { requests: rows.rows, total: total.rows[0].n };
}

async function summary() {
  const r = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
            COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
            COUNT(*) FILTER (WHERE status = 'fulfilled')::int AS fulfilled,
            MAX(created_at) FILTER (WHERE status = 'pending') AS latest_pending
     FROM product_requests`
  );
  return r.rows[0];
}

async function getAdmin(id) {
  const r = await pool.query(
    `SELECT ${BASE}, ${ADMIN_WHO}
     FROM product_requests r JOIN users u ON u.id = r.user_id LEFT JOIN categories c ON c.id = r.category_id
     WHERE r.id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

async function setStatus(id, status, note, adminId) {
  const r = await pool.query(
    `UPDATE product_requests
     SET status = $2, admin_note = $3, reviewed_by = $4, reviewed_at = NOW(), updated_at = NOW()
     WHERE id = $1 RETURNING id`,
    [id, status, note || null, adminId]
  );
  return r.rowCount > 0;
}

module.exports = { createRequest, countRecent, listMine, listPublic, listAdmin, summary, getAdmin, setStatus };
