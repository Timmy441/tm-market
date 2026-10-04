const pool = require('../../db');

// Replaces any earlier unused link for this user with a new one.
async function createResetToken(userId, tokenHash, minutes) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL`, [userId]);
    await client.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)`,
      [userId, tokenHash, String(minutes)]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// True when this user asked for a link within the last `seconds` seconds.
async function requestedRecently(userId, seconds) {
  const r = await pool.query(
    `SELECT 1 FROM password_resets WHERE user_id = $1 AND created_at > NOW() - ($2 || ' seconds')::interval LIMIT 1`,
    [userId, String(seconds)]
  );
  return r.rowCount > 0;
}

// Single use: marks the token used and sets the new password in ONE transaction.
// Returns the user id, or null when the token is unknown, expired or already used.
async function consumeResetToken(tokenHash, newPasswordHash) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const t = await client.query(
      `UPDATE password_resets SET used_at = NOW()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
       RETURNING user_id`,
      [tokenHash]
    );
    if (!t.rowCount) { await client.query('ROLLBACK'); return null; }
    const userId = t.rows[0].user_id;

    const u = await client.query(
      `UPDATE users SET password_hash = $2, password_changed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND is_active = TRUE RETURNING id`,
      [userId, newPasswordHash]
    );
    if (!u.rowCount) { await client.query('ROLLBACK'); return null; }

    await client.query(`UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
    await client.query('COMMIT');
    return userId;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { createResetToken, requestedRecently, consumeResetToken };
