const {
  getProductsForCheckout,
  countPendingOrders,
  createOrders,
  listMyOrders,
  findMyOrder,
  cancelMyOrder,
  listSellerOrders
} = require('../models/orderModel');
const { parsePositiveInt } = require('./productController');
const { normalizeNigerianPhone } = require('../utils/phone');

const MAX_LINES = 20;        // different products in one checkout
const MAX_QUANTITY = 100;    // of one product
const MAX_PENDING = 20;      // unpaid orders one buyer can have at the same time

function text(value, { min = 0, max }) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v.length >= min && v.length <= max ? v : null;
}

// Money is calculated in kobo (whole numbers) so decimals never drift.
const toKobo = price => Math.round(Number(price) * 100);
const fromKobo = kobo => (kobo / 100).toFixed(2);

function formatOrder(row) {
  const items = Array.isArray(row.items) ? row.items : [];
  return {
    id: Number(row.id),
    orderNumber: row.order_number,
    status: row.status,
    seller: { id: row.seller_id == null ? null : Number(row.seller_id), storeName: row.seller_name || null },
    subtotal: Number(row.subtotal),
    shippingFee: Number(row.shipping_fee),
    discount: Number(row.discount),
    total: Number(row.total),
    shipping: {
      name: row.shipping_name,
      phone: row.shipping_phone,
      address: row.shipping_address,
      city: row.shipping_city,
      state: row.shipping_state || null,
      country: row.shipping_country
    },
    items: items.map(i => ({
      productId: i.product_id == null ? null : Number(i.product_id),
      name: i.name,
      quantity: i.quantity,
      unitPrice: Number(i.unit_price),
      totalPrice: Number(i.total_price)
    })),
    createdAt: row.created_at
  };
}

function pageParams(query) {
  const page = parsePositiveInt(query.page) || 1;
  const limit = Math.min(parsePositiveInt(query.limit) || 10, 50);
  return { page, limit, offset: (page - 1) * limit };
}

/* ---------------- buyer: create orders from a bag ---------------- */

async function createOrder(req, res) {
  try {
    const b = req.body || {};

    // 1. The bag. Only product ids and quantities are read; any price sent by the browser is ignored.
    if (!Array.isArray(b.items) || b.items.length === 0) {
      return res.status(400).json({ success: false, message: 'Your bag is empty.' });
    }
    if (b.items.length > MAX_LINES) {
      return res.status(400).json({ success: false, message: `You can order up to ${MAX_LINES} different items at once.` });
    }

    const wanted = new Map(); // productId -> quantity (the same product listed twice is merged)
    for (const item of b.items) {
      const productId = parsePositiveInt(item && item.productId);
      const quantity = parsePositiveInt(item && item.quantity);
      if (!productId || !quantity) {
        return res.status(400).json({ success: false, message: 'One of the items in your bag is invalid.' });
      }
      const total = (wanted.get(productId) || 0) + quantity;
      if (total > MAX_QUANTITY) {
        return res.status(400).json({ success: false, message: `You can order up to ${MAX_QUANTITY} of one item.` });
      }
      wanted.set(productId, total);
    }

    // 2. Delivery details.
    const s = b.shipping || {};
    const name = text(s.name, { min: 2, max: 200 });
    const phone = normalizeNigerianPhone(typeof s.phone === 'string' ? s.phone : '');
    const address = text(s.address, { min: 5, max: 500 });
    const city = text(s.city, { min: 2, max: 100 });
    const state = s.state ? text(s.state, { max: 100 }) : '';

    if (!name) return res.status(400).json({ success: false, message: 'Please enter your full name.' });
    if (!phone) return res.status(400).json({ success: false, message: 'Please enter a valid Nigerian phone number.' });
    if (!address) return res.status(400).json({ success: false, message: 'Please enter your delivery address.' });
    if (!city) return res.status(400).json({ success: false, message: 'Please enter your city.' });
    if (state === null) return res.status(400).json({ success: false, message: 'State is too long.' });

    // 3. Stop runaway unpaid orders.
    if ((await countPendingOrders(req.user.id)) >= MAX_PENDING) {
      return res.status(400).json({ success: false, message: 'You have too many unpaid orders. Please cancel some first.' });
    }

    // 4. Read the real products, prices and stock from the database.
    const rows = await getProductsForCheckout([...wanted.keys()]);
    const byId = new Map(rows.map(r => [String(r.id), r]));

    const problems = [];
    const lines = [];

    for (const [productId, quantity] of wanted) {
      const p = byId.get(String(productId));

      if (!p || p.status !== 'active' || p.is_active === false || p.seller_id == null || p.seller_active === false) {
        problems.push(p ? `"${p.name}" is no longer available.` : 'An item in your bag is no longer available.');
        continue;
      }
      if (String(p.seller_id) === String(req.user.id)) {
        problems.push(`"${p.name}" is your own listing. You can't buy it.`);
        continue;
      }
      const unitKobo = toKobo(p.price);
      if (!Number.isFinite(unitKobo) || unitKobo <= 0) {
        problems.push(`"${p.name}" can't be ordered right now.`);
        continue;
      }
      if (p.quantity !== null && p.quantity !== undefined && Number(p.quantity) < quantity) {
        problems.push(Number(p.quantity) > 0
          ? `Only ${p.quantity} left of "${p.name}".`
          : `"${p.name}" is out of stock.`);
        continue;
      }

      lines.push({
        sellerId: p.seller_id,
        productId: p.id,
        name: p.name,
        sku: p.sku,
        quantity,
        unitKobo
      });
    }

    if (problems.length) {
      return res.status(409).json({ success: false, message: problems.join(' '), problems });
    }

    // 5. One order per seller.
    const bySeller = new Map();
    for (const l of lines) {
      const key = String(l.sellerId);
      if (!bySeller.has(key)) bySeller.set(key, { sellerId: l.sellerId, subtotalKobo: 0, items: [] });
      const g = bySeller.get(key);
      const totalKobo = l.unitKobo * l.quantity;
      g.subtotalKobo += totalKobo;
      g.items.push({
        productId: l.productId,
        name: l.name,
        sku: l.sku,
        quantity: l.quantity,
        unitPrice: fromKobo(l.unitKobo),
        totalPrice: fromKobo(totalKobo)
      });
    }

    const groups = [...bySeller.values()].map(g => ({
      sellerId: g.sellerId,
      subtotal: fromKobo(g.subtotalKobo),
      items: g.items
    }));

    const created = await createOrders(req.user.id, { name, phone, address, city, state: state || null }, groups);

    return res.status(201).json({
      success: true,
      message: created.length > 1
        ? `Your bag was split into ${created.length} orders, one per seller.`
        : 'Your order was created and is waiting for payment.',
      orders: created.map(formatOrder)
    });
  } catch (error) {
    console.error('Create order error:', error);
    return res.status(500).json({ success: false, message: 'Unable to create your order' });
  }
}

/* ---------------- buyer: my orders ---------------- */

async function myOrders(req, res) {
  try {
    const { page, limit, offset } = pageParams(req.query || {});
    const { orders, total } = await listMyOrders(req.user.id, limit, offset);
    return res.status(200).json({ success: true, orders: orders.map(formatOrder), total, page, limit });
  } catch (error) {
    console.error('List orders error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load your orders' });
  }
}

async function getOrder(req, res) {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(404).json({ success: false, message: 'Order not found' });

    const order = await findMyOrder(id, req.user.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    return res.status(200).json({ success: true, order: formatOrder(order) });
  } catch (error) {
    console.error('Get order error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load this order' });
  }
}

async function cancelOrder(req, res) {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(404).json({ success: false, message: 'Order not found' });

    const order = await findMyOrder(id, req.user.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (order.status !== 'pending' || !(await cancelMyOrder(id, req.user.id))) {
      return res.status(409).json({ success: false, message: 'Only unpaid orders can be cancelled.' });
    }

    return res.status(200).json({ success: true, message: 'Order cancelled.' });
  } catch (error) {
    console.error('Cancel order error:', error);
    return res.status(500).json({ success: false, message: 'Unable to cancel this order' });
  }
}

/* ---------------- seller: orders for my products (paid orders only) ---------------- */

async function sellerOrders(req, res) {
  try {
    const { page, limit, offset } = pageParams(req.query || {});
    const { orders, total } = await listSellerOrders(req.user.id, limit, offset);
    return res.status(200).json({ success: true, orders: orders.map(formatOrder), total, page, limit });
  } catch (error) {
    console.error('Seller orders error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load your orders' });
  }
}

module.exports = { createOrder, myOrders, getOrder, cancelOrder, sellerOrders };
