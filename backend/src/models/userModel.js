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
     WHERE email = $1
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

async function createUser({
  firstName,
  lastName,
  email,
  passwordHash,
  phone
}) {
  const result = await pool.query(
    `INSERT INTO users (
      first_name,
      last_name,
      email,
      password_hash,
      phone
    )
    VALUES ($1, $2, $3, $4, $5)
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
      phone || null
    ]
  );

  return result.rows[0];
}

module.exports = {
  findUserByEmail,
  findUserById,
  createUser
};