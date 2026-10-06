const pool = require('../../db');

const USER_COLUMNS = `
      id,
      first_name,
      last_name,
      email,
      phone,
      phone_normalized,
      address,
      location,
      bio,
      avatar_url,
      role,
      is_active,
      created_at,
      updated_at`;


async function findUserByEmail(email) {
  const result = await pool.query(
    `SELECT ${USER_COLUMNS}, password_hash
     FROM users
     WHERE lower(email) = lower($1)
     LIMIT 1`,
    [email]
  );

  return result.rows[0] || null;
}

async function findUserById(id) {
  const result = await pool.query(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = $1 LIMIT 1`,
    [id]
  );

  return result.rows[0] || null;
}

// Phone lookup; pass exceptUserId so a user's own number is not "already taken".
async function findUserByPhone(phoneNormalized, exceptUserId = null) {
  const result = await pool.query(
    `SELECT id FROM users WHERE phone_normalized = $1 AND ($2::bigint IS NULL OR id <> $2) LIMIT 1`,
    [phoneNormalized, exceptUserId]
  );

  return result.rows[0] || null;
}

async function createUser({
  firstName,
  lastName,
  email,
  passwordHash,
  phone,
  phoneNormalized
}) {
  const result = await pool.query(
    `INSERT INTO users (
      first_name,
      last_name,
      email,
      password_hash,
      phone,
      phone_normalized
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING ${USER_COLUMNS}`,
    [
      firstName,
      lastName,
      email,
      passwordHash,
      phone || null,
      phoneNormalized || null
    ]
  );

  return result.rows[0];
}

// Only the fields present in `f` are changed; null clears a field.
async function updateProfile(userId, f) {
  const map = {
    first_name: 'firstName', last_name: 'lastName', phone: 'phone', phone_normalized: 'phoneNormalized',
    address: 'address', location: 'location', bio: 'bio', avatar_url: 'avatarUrl'
  };
  const sets = [];
  const values = [];
  for (const [col, key] of Object.entries(map)) {
    if (f[key] !== undefined) { values.push(f[key]); sets.push(`${col} = $${values.length}`); }
  }
  if (!sets.length) return findUserById(userId);

  values.push(userId);
  const r = await pool.query(
    `UPDATE users SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING ${USER_COLUMNS}`,
    values
  );
  return r.rows[0] || null;
}

async function getPasswordHash(userId) {
  const r = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
  return r.rows[0] ? r.rows[0].password_hash : null;
}

// Also invalidates every token issued before now (other devices are signed out).
async function setPassword(userId, passwordHash) {
  await pool.query(
    `UPDATE users SET password_hash = $2, password_changed_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [userId, passwordHash]
  );
}

module.exports = {
  updateProfile,
  getPasswordHash,
  setPassword,
  findUserByEmail,
  findUserById,
  findUserByPhone,
  createUser
};