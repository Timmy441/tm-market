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

module.exports = { findOrderItemForBuyer, createReview, listProductReviews, listMyReviews };
