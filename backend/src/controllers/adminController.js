const {
  getStats,
  getDailyCounts,
  listUsers,
  getUserDetail,
  setUserActive,
  listProducts,
  setProductStatus,
  listOrders,
  getOrderDetail,
  adminAdvanceOrder,
  adminSetDeliveryWindow
} = require('../models/adminModel');
const { validateWindow } = require('../utils/delivery');
const { findUserById } = require('../models/userModel');
const { findProductById } = require('../models/productModel');

const ROLES = ['customer', 'seller', 'admin'];
const USER_STATUSES = ['active', 'suspended'];
const PRODUCT_STATUSES = ['active', 'pending', 'sold', 'removed'];
const ORDER_FILTERS = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'overdue', 'refund_check'];
// Admins can only move a paid order forward. Cancelling and refunding stay manual in the Paystack dashboard.
const ADMIN_ORDER_STEPS = { processing: ['confirmed'], shipped: ['confirmed', 'processing'], delivered: ['shipped'] };

function parsePositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function paging(query) {
  const limit = Math.min(parsePositiveInt(query.limit) || 20, 50);
  const page = parsePositiveInt(query.page) || 1;
  return { limit, page, offset: (page - 1) * limit };
}

function searchText(value) {
  return typeof value === 'string' ? value.trim().slice(0, 100) : '';
}

// Admin actions are written to the server log (visible with `fly logs`).
function audit(req, action, targetType, targetId, extra) {
  console.log(JSON.stringify({ audit: true, at: new Date().toISOString(), adminId: req.user.id, action, targetType, targetId, ...extra }));
}

function fail(res, error, label) {
  console.error(`${label}:`, error);
  return res.status(500).json({ success: false, message: 'Something went wrong' });
}

async function me(req, res) {
  try {
    const user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({
      success: true,
      admin: { id: user.id, name: `${user.first_name} ${user.last_name}`.trim(), email: user.email, role: user.role }
    });
  } catch (e) { return fail(res, e, 'Admin me error'); }
}

async function stats(req, res) {
  try {
    return res.json({ success: true, stats: await getStats() });
  } catch (e) { return fail(res, e, 'Admin stats error'); }
}

async function timeseries(req, res) {
  try {
    const days = Math.min(parsePositiveInt(req.query.days) || 30, 90);
    const [users, products] = await Promise.all([getDailyCounts('users', days), getDailyCounts('products', days)]);
    return res.json({ success: true, days, users, products });
  } catch (e) { return fail(res, e, 'Admin timeseries error'); }
}

async function users(req, res) {
  try {
    const { role, status } = req.query;
    if (role && !ROLES.includes(role)) return res.status(400).json({ success: false, message: 'Invalid role filter' });
    if (status && !USER_STATUSES.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status filter' });

    const { limit, page, offset } = paging(req.query);
    const result = await listUsers({ search: searchText(req.query.search), role, status, limit, offset });
    return res.json({ success: true, ...result, page, limit });
  } catch (e) { return fail(res, e, 'Admin users error'); }
}

async function userDetail(req, res) {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid user id' });
    const detail = await getUserDetail(id);
    if (!detail) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, ...detail });
  } catch (e) { return fail(res, e, 'Admin user detail error'); }
}

function changeUserStatus(active) {
  return async function (req, res) {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Invalid user id' });

      const result = await setUserActive(id, active);
      if (result.status === 'not_found') return res.status(404).json({ success: false, message: 'User not found' });
      if (result.status === 'admin') {
        return res.status(403).json({ success: false, message: 'Admin accounts cannot be suspended here.' });
      }

      audit(req, active ? 'user.reactivate' : 'user.suspend', 'user', id);
      return res.json({ success: true, user: result.user });
    } catch (e) { return fail(res, e, 'Admin user status error'); }
  };
}

async function products(req, res) {
  try {
    const { status } = req.query;
    if (status && !PRODUCT_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status filter' });
    }
    const { limit, page, offset } = paging(req.query);
    const result = await listProducts({ search: searchText(req.query.search), status, limit, offset });
    return res.json({ success: true, ...result, page, limit });
  } catch (e) { return fail(res, e, 'Admin products error'); }
}

async function productDetail(req, res) {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid product id' });
    const product = await findProductById(id); // any status: admins can see removed/pending too
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    return res.json({ success: true, product });
  } catch (e) { return fail(res, e, 'Admin product detail error'); }
}

async function changeProductStatus(req, res) {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid product id' });

    const status = req.body && req.body.status;
    if (!PRODUCT_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: `Status must be one of: ${PRODUCT_STATUSES.join(', ')}` });
    }

    const updated = await setProductStatus(id, status);
    if (!updated) return res.status(404).json({ success: false, message: 'Product not found' });

    audit(req, 'product.status', 'product', id, { status });
    return res.json({ success: true, product: updated });
  } catch (e) { return fail(res, e, 'Admin product status error'); }
}

function formatAdminOrder(r) {
  const items = Array.isArray(r.items) ? r.items : [];
  return {
    id: Number(r.id),
    orderNumber: r.order_number,
    status: r.status,
    total: Number(r.total),
    subtotal: Number(r.subtotal),
    createdAt: r.created_at,
    shippedAt: r.shipped_at || null,
    deliveredAt: r.delivered_at || null,
    deliveryWindow: r.delivery_window_start && r.delivery_window_end
      ? { from: r.delivery_window_start, to: r.delivery_window_end }
      : null,
    buyer: {
      name: `${r.buyer_first_name || ''} ${r.buyer_last_name || ''}`.trim() || null,
      email: r.buyer_email || null,
      phone: r.buyer_phone || null
    },
    seller: { id: r.seller_id == null ? null : Number(r.seller_id), storeName: r.seller_name || null, email: r.seller_email || null },
    shipping: {
      name: r.shipping_name, phone: r.shipping_phone, address: r.shipping_address,
      city: r.shipping_city, state: r.shipping_state || null, country: r.shipping_country
    },
    payment: { status: r.payment_status || null, reference: r.payment_reference || null, paidAt: r.paid_at || null },
    items: items.map(i => ({ name: i.name, quantity: i.quantity, unitPrice: Number(i.unit_price), totalPrice: Number(i.total_price) })),
    events: (Array.isArray(r.events) ? r.events : []).map(e => ({ status: e.status, note: e.note || null, at: e.at }))
  };
}

async function orders(req, res) {
  try {
    const { status } = req.query;
    if (status && !ORDER_FILTERS.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status filter' });
    }
    const { limit, page, offset } = paging(req.query);
    const result = await listOrders({ search: searchText(req.query.search), status, limit, offset });
    const rows = result.orders.map(r => ({
      id: Number(r.id),
      orderNumber: r.order_number,
      status: r.status,
      total: Number(r.total),
      createdAt: r.created_at,
      deliveryWindow: r.delivery_window_start && r.delivery_window_end
        ? { from: r.delivery_window_start, to: r.delivery_window_end }
        : null,
      buyer: { name: `${r.buyer_first_name || ''} ${r.buyer_last_name || ''}`.trim() || null, email: r.buyer_email || null },
      sellerName: r.seller_name || null,
      paymentStatus: r.payment_status || null
    }));
    return res.json({ success: true, orders: rows, total: result.total, page, limit });
  } catch (e) { return fail(res, e, 'Admin orders error'); }
}

async function orderDetail(req, res) {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid order id' });
    const row = await getOrderDetail(id);
    if (!row) return res.status(404).json({ success: false, message: 'Order not found' });
    return res.json({ success: true, order: formatAdminOrder(row) });
  } catch (e) { return fail(res, e, 'Admin order detail error'); }
}

async function changeOrderStatus(req, res) {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid order id' });

    const status = req.body && req.body.status;
    if (typeof status !== 'string' || !Object.prototype.hasOwnProperty.call(ADMIN_ORDER_STEPS, status)) {
      return res.status(400).json({ success: false, message: 'Status must be "processing", "shipped" or "delivered".' });
    }

    const rawNote = req.body.note;
    let note = null;
    if (typeof rawNote === 'string' && rawNote.trim()) {
      if (rawNote.trim().length > 200) return res.status(400).json({ success: false, message: 'The note is too long (200 characters at most).' });
      note = `TM Market support: ${rawNote.trim()}`;
    }
    if (!note && status === 'delivered') note = 'Marked as delivered by TM Market support';

    if (!(await getOrderDetail(id))) return res.status(404).json({ success: false, message: 'Order not found' });

    const moved = await adminAdvanceOrder(id, status, ADMIN_ORDER_STEPS[status], note);
    if (!moved) return res.status(409).json({ success: false, message: 'This order cannot be moved to that step right now.' });

    audit(req, 'order.status', 'order', id, { status });
    return res.json({ success: true, order: formatAdminOrder(await getOrderDetail(id)) });
  } catch (e) { return fail(res, e, 'Admin order status error'); }
}

async function changeOrderWindow(req, res) {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid order id' });

    const b = req.body || {};
    const check = validateWindow(b.from, b.to);
    if (!check.ok) return res.status(400).json({ success: false, message: check.message });

    if (!(await getOrderDetail(id))) return res.status(404).json({ success: false, message: 'Order not found' });

    const saved = await adminSetDeliveryWindow(id, check.from, check.to);
    if (!saved) return res.status(409).json({ success: false, message: 'The delivery window can no longer be changed for this order.' });

    audit(req, 'order.window', 'order', id, { from: check.from, to: check.to });
    return res.json({ success: true, order: formatAdminOrder(await getOrderDetail(id)) });
  } catch (e) { return fail(res, e, 'Admin order window error'); }
}

module.exports = {
  orders,
  orderDetail,
  changeOrderStatus,
  changeOrderWindow,
  me,
  stats,
  timeseries,
  users,
  userDetail,
  suspendUser: changeUserStatus(false),
  reactivateUser: changeUserStatus(true),
  products,
  productDetail,
  changeProductStatus
};
