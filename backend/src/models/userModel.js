const pool = require('../../db');

async function findUserByEmail(email) {
  const result = await pool.query(
    `SELECT
      id,
      first_name,
      last_name,
      email,
      password_hash,
      phone,
      role,
      is_active,
      created_at,
      updated_at
     FROM users
     WHERE lower(email) = lower($1)
     LIMIT 1`,
    [email]
  );

  return result.rows[0] || null;
}

async function findUserById(id) {
  const result = await pool.query(
    `SELECT
      id,
      first_name,
      last_name,
      email,
      phone,
      role,
      is_active,
      created_at,
      updated_at
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [id]
  );

  return result.rows[0] || null;
}

async function findUserByPhone(phoneNormalized) {
  const result = await pool.query(
    `SELECT id FROM users WHERE phone_normalized = $1 LIMIT 1`,
    [phoneNormalized]
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
    RETURNING
      id,
      first_name,
      last_name,
      email,
      phone,
      role,
      is_active,
      created_at,
      updated_at`,
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

module.exports = {
  findUserByEmail,
  findUserById,
  findUserByPhone,
  createUser
};