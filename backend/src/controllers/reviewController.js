const {
  findOrderItemForBuyer,
  createReview,
  listProductReviews,
  listMyReviews
} = require('../models/reviewModel');
const { parsePositiveInt } = require('./productController');

const MAX_COMMENT = 1000;

// "ada" + "okafor"  ->  "Ada O."   Never a full name, never an email.
function reviewerName(first, last) {
  const f = typeof first === 'string' ? first.trim() : '';
  const l = typeof last === 'string' ? last.trim() : '';
  if (!f) return 'TM customer';
  const name = f.charAt(0).toUpperCase() + f.slice(1);
  return l ? `${name} ${l.charAt(0).toUpperCase()}.` : name;
}

function parseRating(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d$/.test(value.trim()))) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

function formatReview(row) {
  return {
    id: Number(row.id),
    rating: Number(row.rating),
    comment: row.comment || null,
    reviewer: reviewerName(row.first_name, row.last_name),
    createdAt: row.created_at
  };
}

/* ---------------- buyer: leave a review ---------------- */

async function submitReview(req, res) {
  try {
    const b = req.body || {};
    const orderId = parsePositiveInt(b.orderId);
    const productId = parsePositiveInt(b.productId);
    const rating = parseRating(b.rating);

    if (!orderId || !productId) {
      return res.status(400).json({ success: false, message: 'Please choose the item you want to review.' });
    }
    if (!rating) {
      return res.status(400).json({ success: false, message: 'Please choose a rating from 1 to 5 stars.' });
    }

    let comment = null;
    if (b.comment !== undefined && b.comment !== null) {
      if (typeof b.comment !== 'string') {
        return res.status(400).json({ success: false, message: 'Your comment is not valid.' });
      }
      const t = b.comment.trim();
      if (t.length > MAX_COMMENT) {
        return res.status(400).json({ success: false, message: `Your comment is too long (${MAX_COMMENT} characters at most).` });
      }
      comment = t === '' ? null : t;
    }

    // Only the buyer's own order line is found. Anyone else gets the same 404 as a missing order.
    const line = await findOrderItemForBuyer(orderId, req.user.id, productId);
    if (!line) return res.status(404).json({ success: false, message: 'We could not find that item in your orders.' });

    if (line.status !== 'delivered') {
      return res.status(409).json({ success: false, message: 'You can review an item once your order has been delivered.' });
    }

    const saved = await createReview({
      orderId, productId, sellerId: line.seller_id, buyerId: req.user.id, rating, comment
    });
    if (!saved) {
      return res.status(409).json({ success: false, message: 'You have already reviewed this item.' });
    }

    return res.status(201).json({
      success: true,
      message: 'Thank you for your review!',
      review: { id: Number(saved.id), orderId, productId, rating, comment, createdAt: saved.created_at }
    });
  } catch (error) {
    console.error('Submit review error:', error);
    return res.status(500).json({ success: false, message: 'Unable to save your review' });
  }
}

/* ---------------- public: reviews for one product ---------------- */

async function getProductReviews(req, res) {
  try {
    const productId = parsePositiveInt(req.params.id);
    if (!productId) return res.status(404).json({ success: false, message: 'Product not found' });

    const page = parsePositiveInt(req.query && req.query.page) || 1;
    const limit = Math.min(parsePositiveInt(req.query && req.query.limit) || 5, 20);
    const out = await listProductReviews(productId, limit, (page - 1) * limit);

    return res.status(200).json({
      success: true,
      summary: { count: out.count, average: out.count > 0 && out.average !== null ? Number(out.average) : null },
      reviews: out.reviews.map(formatReview),
      page,
      limit
    });
  } catch (error) {
    console.error('Product reviews error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load reviews' });
  }
}

/* ---------------- buyer: what I have already reviewed ---------------- */

async function myReviews(req, res) {
  try {
    const rows = await listMyReviews(req.user.id);
    return res.status(200).json({
      success: true,
      reviews: rows.map(r => ({ orderId: Number(r.order_id), productId: Number(r.product_id), rating: Number(r.rating) }))
    });
  } catch (error) {
    console.error('My reviews error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load your reviews' });
  }
}

module.exports = { submitReview, getProductReviews, myReviews, reviewerName };
