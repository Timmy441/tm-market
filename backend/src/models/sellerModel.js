const pool = require('../../db');

const PROFILE_COLUMNS = `id, user_id, store_name, description, location, whatsapp, logo_url, is_active, created_at, updated_at`;

async function findSellerByUserId(userId) {
  const r = await pool.query(`SELECT ${PROFILE_COLUMNS} FROM seller_profiles WHERE user_id = $1 LIMIT 1`, [userId]);
  return r.rows[0] || null;
}

// Creates the store and upgrades the user to SELLER in one transaction.
async function createSellerAndPromote(userId, { storeName, description, location, whatsapp }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const u = await client.query(`SELECT role, is_active FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    const user = u.rows[0];
    if (!user || !user.is_active) { await client.query('ROLLBACK'); return { error: 'inactive' }; }
    if (user.role === 'admin') { await client.query('ROLLBACK'); return { error: 'admin' }; }

    const p = await client.query(
      `INSERT INTO seller_profiles (user_id, store_name, description, location, whatsapp)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${PROFILE_COLUMNS}`,
      [userId, storeName, description, location, whatsapp]
    );

    await client.query(`UPDATE users SET role = 'seller', updated_at = NOW() WHERE id = $1`, [userId]);
    await client.query('COMMIT');
    return { profile: p.rows[0] };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function updateSeller(userId, { storeName, description, location, whatsapp }) {
  const r = await pool.query(
    `UPDATE seller_profiles SET
       store_name = COALESCE($2, store_name),
       description = COALESCE($3, description),
       location = COALESCE($4, location),
       whatsapp = COALESCE($5, whatsapp),
       updated_at = NOW()
     WHERE user_id = $1 RETURNING ${PROFILE_COLUMNS}`,
    [userId, storeName, description, location, whatsapp]
  );
  return r.rows[0] || null;
}

// Role is read from the database (not the token) so a suspended or demoted user loses access immediately.
async function getAuthState(userId) {
  const r = await pool.query(`SELECT id, role, is_active, password_changed_at FROM users WHERE id = $1`, [userId]);
  return r.rows[0] || null;
}

module.exports = { findSellerByUserId, createSellerAndPromote, updateSeller, getAuthState };
