const pool = require('../../db');

// The buyer's own order line. Nothing is returned for someone else's order.
async function findOrderItemForBuyer(orderId, userId, productId) {
  const r = await pool.query(
    `SELECT o.id AS order_id, o.status, o.seller_id, oi.product_id
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     WHERE o.id = $1 AND o.user_id = $2 AND oi.product_id = $3
     LIMIT 1`,
    [orderId, userId, productId]
  );
  return r.rows[0] || null;
}

// Returns null when this item in this order already has a review (the database enforces it).
async function createReview({ orderId, productId, sellerId, buyerId, rating, comment }) {
  const r = await pool.query(
    `INSERT INTO product_reviews (order_id, product_id, seller_id, buyer_id, rating, comment)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (order_id, product_id) DO NOTHING
     RETURNING id, order_id, product_id, rating, comment, created_at`,
    [orderId, productId, sellerId, buyerId, rating, comment]
  );
  return r.rows[0] || null;
}

// Only first and last name are read from users. Email and phone are never selected.
async function listProductReviews(productId, limit, offset) {
  const rows = (await pool.query(
    `SELECT r.id, r.rating, r.comment, r.created_at, u.first_name, u.last_name
     FROM product_reviews r
     LEFT JOIN users u ON u.id = r.buyer_id
     WHERE r.product_id = $1 AND r.is_hidden = FALSE
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT $2 OFFSET $3`,
    [productId, limit, offset]
  )).rows;

  const s = (await pool.query(
    `SELECT COUNT(*)::int AS count, ROUND(AVG(rating)::numeric, 1) AS average
     FROM product_reviews WHERE product_id = $1 AND is_hidden = FALSE`,
    [productId]
  )).rows[0];

  return { reviews: rows, count: s.count, average: s.average };
}

// What this buyer has already reviewed, so My Orders can show stars instead of a form.
async function listMyReviews(userId) {
  const r = await pool.query(
    `SELECT order_id, product_id, rating
     FROM product_reviews WHERE buyer_id = $1
     ORDER BY created_at DESC, id DESC LIMIT 500`,
    [userId]
  );
  return r.rows;
}

// ---- admin moderation ----

// Escape LIKE wildcards so a search for "50%" matches the text, not everything.
function like(text) {
  return `%${String(text).replace(/[\\%_]/g, '\\$&')}%`;
}

// Every review, newest first, with who wrote it and what it is about. Admin only.
async function adminListReviews({ search, visibility, limit, offset }) {
  const conditions = [];
  const values = [];

  if (search) {
    values.push(like(search));
    const n = values.length;
    conditions.push(`(r.comment ILIKE $${n} OR p.name ILIKE $${n} OR sp.store_name ILIKE $${n}
      OR u.first_name ILIKE $${n} OR u.last_name ILIKE $${n} OR u.email ILIKE $${n})`);
  }
  if (visibility === 'hidden') conditions.push('r.is_hidden = TRUE');
  if (visibility === 'visible') conditions.push('r.is_hidden = FALSE');

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const from = `FROM product_reviews r
     LEFT JOIN products p ON p.id = r.product_id
     LEFT JOIN users u ON u.id = r.buyer_id
     LEFT JOIN seller_profiles sp ON sp.user_id = r.seller_id
     ${where}`;

  const total = (await pool.query(`SELECT COUNT(*)::int AS total ${from}`, values)).rows[0].total;
  const hiddenCount = (await pool.query(`SELECT COUNT(*)::int AS n FROM product_reviews WHERE is_hidden = TRUE`)).rows[0].n;

  values.push(limit, offset);
  const rows = (await pool.query(
    `SELECT r.id, r.rating, r.comment, r.is_hidden, r.created_at, r.product_id, r.order_id,
            p.name AS product_name, sp.store_name AS seller_name,
            u.first_name, u.last_name, u.email
     ${from}
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  )).rows;

  return { reviews: rows, total, hiddenCount };
}

// Hiding never deletes anything: the review simply stops showing on the site and in ratings.
async function adminSetReviewHidden(id, hidden) {
  const r = await pool.query(
    `UPDATE product_reviews SET is_hidden = $2 WHERE id = $1 RETURNING id, is_hidden`,
    [id, hidden]
  );
  return r.rows[0] || null;
}

module.exports = {
  findOrderItemForBuyer, createReview, listProductReviews, listMyReviews,
  adminListReviews, adminSetReviewHidden
};
