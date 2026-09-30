const {
  getStats,
  getDailyCounts,
  listUsers,
  getUserDetail,
  setUserActive,
  listProducts,
  setProductStatus
} = require('../models/adminModel');
const { findUserById } = require('../models/userModel');
const { findProductById } = require('../models/productModel');

const ROLES = ['customer', 'seller', 'admin'];
const USER_STATUSES = ['active', 'suspended'];
const PRODUCT_STATUSES = ['active', 'pending', 'sold', 'removed'];

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

module.exports = {
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
