const { createRequest, countRecent, listMine, listPublic, listForSellers, listAdmin, summary, getAdmin, setStatus, deleteRequest } = require('../models/requestModel');
const { isTrustedImageUrl, signUploadParams } = require('../utils/cloudinary');
const { mailConfigured, sendMail } = require('../utils/mailer');
const { findUserById } = require('../models/userModel');

const MAX_IMAGES = 4;
const MAX_PENDING = 5;
const MAX_PER_DAY = 10;
const STATUSES = ['pending', 'approved', 'rejected', 'fulfilled'];

const bad = (res, message, code = 400) => res.status(code).json({ success: false, message });
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function text(value, { min = 0, max }) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v.length >= min && v.length <= max ? v : null;
}
function positiveInt(v) { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; }

function audit(req, action, id, extra) {
  console.log(JSON.stringify({ audit: true, at: new Date().toISOString(), adminId: req.user.id, action, targetType: 'product_request', targetId: id, ...extra }));
}

/* ---------------- customer ---------------- */

function validateRequest(b) {
  const d = {};
  const errors = [];
  b = b || {};

  d.title = text(b.title, { min: 3, max: 120 });
  if (!d.title) errors.push('Please say what you want (3-120 characters)');

  d.description = text(b.description, { min: 10, max: 1000 });
  if (!d.description) errors.push('Please describe it in at least 10 characters (max 1000)');

  if (b.categoryId !== undefined && b.categoryId !== null && b.categoryId !== '') {
    d.categoryId = positiveInt(b.categoryId);
    if (!d.categoryId) errors.push('Invalid category');
  }

  if (b.budget !== undefined && b.budget !== null && b.budget !== '') {
    const n = Number(b.budget);
    if (!Number.isFinite(n) || n <= 0 || n >= 1e10) errors.push('Budget must be a number greater than 0');
    else d.budget = Math.round(n * 100) / 100;
  }

  if (b.location !== undefined && b.location !== null && b.location !== '') {
    d.location = text(b.location, { max: 150 });
    if (d.location === null) errors.push('Location is too long');
  }

  const imgs = b.images;
  if (!Array.isArray(imgs) || imgs.length < 1 || imgs.length > MAX_IMAGES || !imgs.every(isTrustedImageUrl)) {
    errors.push(`Please upload 1 to ${MAX_IMAGES} photos of the product`);
  } else d.images = imgs;

  return { d, errors };
}

async function notifyAdmin(user, id, d) {
  const to = process.env.ADMIN_NOTIFY_EMAIL;
  if (!to || !mailConfigured()) {
    console.warn('Product request email skipped: set ADMIN_NOTIFY_EMAIL and the Brevo secrets.');
    return;
  }
  const adminUrl = (process.env.ADMIN_URL || '').replace(/\/+$/, '');
  const who = `${user.first_name} ${user.last_name}`.trim();
  const lines = [
    `Request #${id}: ${d.title}`,
    `From: ${who} | ${user.email} | ${user.phone || 'no phone saved'}`,
    d.budget ? `Budget: N${d.budget}` : null,
    d.location ? `Location: ${d.location}` : null,
    '', d.description, '', `Photo: ${d.images[0]}`,
    adminUrl ? `\nReview it here: ${adminUrl}` : '\nOpen the admin panel > Requests to approve or reject it.'
  ].filter(v => v !== null);
  await sendMail({
    to, name: 'TM Market admin',
    subject: `New product request: ${d.title}`,
    text: lines.join('\n'),
    html: `<h3>New product request #${id}</h3><p><strong>${esc(d.title)}</strong></p>
<p>From <strong>${esc(who)}</strong> (${esc(user.email)}, ${esc(user.phone || 'no phone saved')})</p>
${d.budget ? `<p>Budget: &#8358;${esc(d.budget)}</p>` : ''}${d.location ? `<p>Location: ${esc(d.location)}</p>` : ''}
<p style="white-space:pre-line">${esc(d.description)}</p>
<p><img src="${esc(d.images[0])}" alt="" style="max-width:320px;border-radius:8px"></p>
<p>${adminUrl ? `<a href="${esc(adminUrl)}">Open the admin panel</a> to approve or reject it.` : 'Open the admin panel &gt; Requests to approve or reject it.'}</p>`
  });
}

// POST /api/requests
async function submitRequest(req, res) {
  try {
    const { d, errors } = validateRequest(req.body);
    if (errors.length) return bad(res, errors.join('; '));

    const counts = await countRecent(req.user.id);
    if (counts.pending >= MAX_PENDING) return bad(res, `You already have ${MAX_PENDING} requests waiting for review. Please wait for them to be reviewed.`, 429);
    if (counts.today >= MAX_PER_DAY) return bad(res, 'You have reached today\'s limit for requests. Please try again tomorrow.', 429);

    const id = await createRequest(req.user.id, d);

    // The customer sees "pending" at once; the admin email goes out after the response and cannot block it.
    res.status(201).json({ success: true, message: 'Request sent. It is pending review by TM Market.', request: { id, title: d.title, status: 'pending' } });

    try {
      const user = await findUserById(req.user.id);
      await notifyAdmin(user, id, d);
    } catch (e) { console.error('Admin email for product request failed:', e.message); }
  } catch (error) {
    if (error.code === '23503') return bad(res, 'The selected category does not exist');
    console.error('Submit product request error:', error);
    if (!res.headersSent) return bad(res, 'Unable to send your request', 500);
  }
}

async function myRequests(req, res) {
  try { return res.status(200).json({ success: true, requests: await listMine(req.user.id) }); }
  catch (error) { console.error('My requests error:', error); return bad(res, 'Unable to load your requests', 500); }
}

async function publicRequests(req, res) {
  try {
    const limit = Math.min(positiveInt(req.query.limit) || 12, 50);
    const page = positiveInt(req.query.page) || 1;
    const { requests, total } = await listPublic({ limit, offset: (page - 1) * limit });
    return res.status(200).json({ success: true, requests, pagination: { page, limit, total } });
  } catch (error) { console.error('Public requests error:', error); return bad(res, 'Unable to load requests', 500); }
}

async function sellerRequests(req, res) {
  try {
    const limit = Math.min(positiveInt(req.query.limit) || 20, 50);
    const page = positiveInt(req.query.page) || 1;
    const { requests, total } = await listForSellers({ limit, offset: (page - 1) * limit });
    return res.status(200).json({ success: true, requests, pagination: { page, limit, total } });
  } catch (error) { console.error('Seller requests error:', error); return bad(res, 'Unable to load requests', 500); }
}

function signRequestUpload(req, res) {
  const signed = signUploadParams('tm-market/requests');
  if (!signed) return bad(res, 'Image uploads are not available yet.', 503);
  return res.status(200).json({ success: true, ...signed });
}

/* ---------------- admin ---------------- */

async function adminList(req, res) {
  try {
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    if (req.query.status && !status) return bad(res, 'Invalid status filter');
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    const limit = Math.min(positiveInt(req.query.limit) || 20, 50);
    const page = positiveInt(req.query.page) || 1;
    const { requests, total } = await listAdmin({ status, search, limit, offset: (page - 1) * limit });
    return res.status(200).json({ success: true, requests, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) { console.error('Admin requests error:', error); return bad(res, 'Unable to load requests', 500); }
}

async function adminSummary(req, res) {
  try { return res.status(200).json({ success: true, summary: await summary() }); }
  catch (error) { console.error('Admin request summary error:', error); return bad(res, 'Unable to load summary', 500); }
}

async function adminDetail(req, res) {
  try {
    const id = positiveInt(req.params.id);
    if (!id) return bad(res, 'Invalid request id');
    const request = await getAdmin(id);
    if (!request) return bad(res, 'Request not found', 404);
    return res.status(200).json({ success: true, request });
  } catch (error) { console.error('Admin request detail error:', error); return bad(res, 'Unable to load request', 500); }
}

async function adminSetStatus(req, res) {
  try {
    const id = positiveInt(req.params.id);
    if (!id) return bad(res, 'Invalid request id');
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) return bad(res, 'Status must be pending, approved, rejected or fulfilled');

    let note = null;
    if (req.body.note !== undefined && req.body.note !== null && req.body.note !== '') {
      note = text(req.body.note, { max: 500 });
      if (note === null) return bad(res, 'Note is too long (max 500 characters)');
    }

    if (!(await setStatus(id, status, note, req.user.id))) return bad(res, 'Request not found', 404);
    audit(req, 'request.status', id, { status });
    return res.status(200).json({ success: true, message: 'Request updated' });
  } catch (error) { console.error('Admin request status error:', error); return bad(res, 'Unable to update request', 500); }
}

async function adminDelete(req, res) {
  try {
    const id = positiveInt(req.params.id);
    if (!id) return bad(res, 'Invalid request id');
    if (!(await deleteRequest(id))) return bad(res, 'Request not found', 404);
    audit(req, 'request.delete', id);
    return res.status(200).json({ success: true, message: 'Request removed' });
  } catch (error) { console.error('Admin request delete error:', error); return bad(res, 'Unable to remove request', 500); }
}

module.exports = {
  validateRequest, submitRequest, myRequests, sellerRequests, signRequestUpload,
  adminList, adminSummary, adminDetail, adminSetStatus, adminDelete
};
