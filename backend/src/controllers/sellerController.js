const crypto = require('crypto');

const { createToken, publicUser } = require('./authController');
const { findUserById } = require('../models/userModel');
const {
  findSellerByUserId,
  createSellerAndPromote,
  updateSeller,
  getPublicSellerStore
} = require('../models/sellerModel');
const {
  listSellerProducts,
  findSellerProduct,
  createSellerProduct,
  updateSellerProduct,
  removeSellerProduct
} = require('../models/productModel');
const { parsePositiveInt, parseMoney, slugify } = require('./productController');
const { normalizeNigerianPhone } = require('../utils/phone');

const MAX_IMAGES = 5;
const MAX_QUANTITY = 100000;

function text(value, { min = 0, max }) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v.length >= min && v.length <= max ? v : null;
}

// Only images hosted in OUR Cloudinary account are accepted (no arbitrary external URLs).
function isTrustedImageUrl(url) {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloud || typeof url !== 'string' || url.length > 500) return false;
  return url.startsWith(`https://res.cloudinary.com/${cloud}/`);
}

/* ---------------- seller profile ---------------- */

async function becomeSeller(req, res) {
  try {
    const b = req.body || {};
    const storeName = text(b.storeName, { min: 2, max: 150 });
    const location = text(b.location, { min: 2, max: 150 });
    const description = b.description ? text(b.description, { max: 2000 }) : '';

    let whatsapp = null;
    if (b.whatsapp) {
      whatsapp = normalizeNigerianPhone(String(b.whatsapp));
      if (!whatsapp) {
        return res.status(400).json({ success: false, message: 'Please enter a valid Nigerian WhatsApp number.' });
      }
    }

    if (!storeName) return res.status(400).json({ success: false, message: 'Store name is required (2-150 characters).' });
    if (!location) return res.status(400).json({ success: false, message: 'Store location is required.' });
    if (description === null) return res.status(400).json({ success: false, message: 'Description is too long.' });

    const result = await createSellerAndPromote(req.user.id, {
      storeName, description: description || null, location, whatsapp
    });

    if (result.error === 'admin') {
      return res.status(400).json({ success: false, message: 'Administrator accounts cannot open a seller profile.' });
    }
    if (result.error) {
      return res.status(403).json({ success: false, message: 'This account is inactive' });
    }

    const user = await findUserById(req.user.id);

    // Fresh token so the new SELLER role applies immediately, no re-login needed.
    return res.status(201).json({
      success: true,
      message: 'Your seller profile is ready',
      token: createToken(user),
      user: publicUser(user),
      seller: result.profile
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'You already have a seller profile.' });
    }
    console.error('Become seller error:', error);
    return res.status(500).json({ success: false, message: 'Unable to create seller profile' });
  }
}

async function getPublicStore(req, res) {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ success: false, message: 'Invalid seller.' });
    const store = await getPublicSellerStore(userId);
    if (!store) return res.status(404).json({ success: false, message: 'Store not found.' });
    return res.status(200).json({ success: true, ...store });
  } catch (error) {
    console.error('Get public seller store error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load this store.' });
  }
}

async function getMySeller(req, res) {
  try {
    const seller = await findSellerByUserId(req.user.id);
    if (!seller) return res.status(404).json({ success: false, message: 'No seller profile yet' });
    return res.status(200).json({ success: true, seller });
  } catch (error) {
    console.error('Get seller error:', error);
    return res.status(500).json({ success: false, message: 'Unable to retrieve seller profile' });
  }
}

async function updateMySeller(req, res) {
  try {
    const b = req.body || {};
    const fields = { storeName: null, description: null, location: null, whatsapp: null };

    if (b.storeName !== undefined) {
      fields.storeName = text(b.storeName, { min: 2, max: 150 });
      if (!fields.storeName) return res.status(400).json({ success: false, message: 'Store name must be 2-150 characters.' });
    }
    if (b.location !== undefined) {
      fields.location = text(b.location, { min: 2, max: 150 });
      if (!fields.location) return res.status(400).json({ success: false, message: 'Location must be 2-150 characters.' });
    }
    if (b.description !== undefined) {
      fields.description = text(b.description, { max: 2000 });
      if (fields.description === null) return res.status(400).json({ success: false, message: 'Description is too long.' });
    }
    if (b.whatsapp !== undefined) {
      fields.whatsapp = normalizeNigerianPhone(String(b.whatsapp));
      if (!fields.whatsapp) return res.status(400).json({ success: false, message: 'Please enter a valid Nigerian WhatsApp number.' });
    }

    const seller = await updateSeller(req.user.id, fields);
    if (!seller) return res.status(404).json({ success: false, message: 'No seller profile yet' });
    return res.status(200).json({ success: true, seller });
  } catch (error) {
    console.error('Update seller error:', error);
    return res.status(500).json({ success: false, message: 'Unable to update seller profile' });
  }
}

/* ---------------- image upload (signed by the backend; the secret never leaves it) ---------------- */

function signUpload(req, res) {
  const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: secret } = process.env;

  if (!cloudName || !apiKey || !secret) {
    return res.status(503).json({ success: false, message: 'Image uploads are not available yet.' });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'tm-market/products';
  const signature = crypto
    .createHash('sha1')
    .update(`folder=${folder}&timestamp=${timestamp}${secret}`)
    .digest('hex');

  return res.status(200).json({ success: true, cloudName, apiKey, timestamp, folder, signature });
}

/* ---------------- seller listings ---------------- */

function validateListing(body, isUpdate) {
  const data = {};
  const errors = [];
  const b = body || {};

  if (!isUpdate || b.name !== undefined) {
    const v = text(b.name, { min: 2, max: 255 });
    v ? (data.name = v) : errors.push('Product name is required (2-255 characters)');
  }

  if (!isUpdate || b.price !== undefined) {
    const v = parseMoney(b.price);
    v && v > 0 && v < 1e10 ? (data.price = v) : errors.push('Price must be a number greater than 0');
  }

  if (!isUpdate || b.categoryId !== undefined) {
    const v = parsePositiveInt(b.categoryId);
    v ? (data.categoryId = v) : errors.push('Please select a category');
  }

  if (!isUpdate || b.location !== undefined) {
    const v = text(b.location, { min: 2, max: 150 });
    v ? (data.location = v) : errors.push('Location is required');
  }

  if (!isUpdate || b.itemCondition !== undefined) {
    const v = typeof b.itemCondition === 'string' ? b.itemCondition.trim().toLowerCase() : '';
    ['new', 'used', 'repaired'].includes(v)
      ? (data.itemCondition = v)
      : errors.push('Please choose the item condition (new, used or repaired)');
  }

  if (!isUpdate || b.quantity !== undefined) {
    const n = Number(b.quantity);
    Number.isInteger(n) && n >= 0 && n <= MAX_QUANTITY
      ? (data.quantity = n)
      : errors.push(`Quantity must be a whole number from 0 to ${MAX_QUANTITY}`);
  }

  if (b.description !== undefined) {
    const v = text(b.description, { max: 5000 });
    v === null ? errors.push('Description is too long (max 5000 characters)') : (data.description = v || null);
  }

  if (!isUpdate || b.images !== undefined) {
    const list = b.images;
    if (
      !Array.isArray(list) ||
      list.length < (isUpdate ? 0 : 1) ||
      list.length > MAX_IMAGES ||
      !list.every(i => i && isTrustedImageUrl(i.imageUrl))
    ) {
      errors.push(`Please upload 1 to ${MAX_IMAGES} product images`);
    } else {
      data.images = list.map(i => ({ imageUrl: i.imageUrl, altText: data.name || null }));
    }
  }

  if (isUpdate && b.status !== undefined) {
    ['active', 'sold'].includes(b.status)
      ? (data.status = b.status)
      : errors.push('Status can only be changed to active or sold');
  }

  return { data, errors };
}

function handleListingError(error, res, label) {
  if (error.code === '23503') return res.status(400).json({ success: false, message: 'The selected category does not exist' });
  if (error.code === '22003') return res.status(400).json({ success: false, message: 'A number is too large' });
  console.error(`${label} error:`, error);
  return res.status(500).json({ success: false, message: 'Unable to save listing' });
}

async function getMyProducts(req, res) {
  try {
    return res.status(200).json({ success: true, products: await listSellerProducts(req.user.id) });
  } catch (error) {
    console.error('List seller products error:', error);
    return res.status(500).json({ success: false, message: 'Unable to retrieve your listings' });
  }
}

async function createMyProduct(req, res) {
  try {
    const { data, errors } = validateListing(req.body, false);
    if (errors.length) return res.status(400).json({ success: false, message: errors.join('; ') });

    // ACTIVE by default. Set NEW_LISTING_STATUS=pending to require admin approval later.
    data.status = process.env.NEW_LISTING_STATUS === 'pending' ? 'pending' : 'active';
    data.slug = `${slugify(data.name) || 'product'}-${crypto.randomBytes(3).toString('hex')}`.slice(0, 280);

    const id = await createSellerProduct(req.user.id, data);
    return res.status(201).json({
      success: true,
      message: data.status === 'pending' ? 'Listing submitted for approval' : 'Listing published',
      product: await findSellerProduct(id, req.user.id)
    });
  } catch (error) {
    return handleListingError(error, res, 'Create listing');
  }
}

async function updateMyProduct(req, res) {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid product id' });

    const { data, errors } = validateListing(req.body, true);
    if (errors.length) return res.status(400).json({ success: false, message: errors.join('; ') });
    if (!Object.keys(data).length) return res.status(400).json({ success: false, message: 'No valid fields to update' });

    // A "not yours" product looks exactly like a missing one.
    const updated = await updateSellerProduct(id, req.user.id, data);
    if (!updated) return res.status(404).json({ success: false, message: 'Product not found' });

    return res.status(200).json({
      success: true,
      message: 'Listing updated',
      product: await findSellerProduct(id, req.user.id)
    });
  } catch (error) {
    return handleListingError(error, res, 'Update listing');
  }
}

async function deleteMyProduct(req, res) {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid product id' });

    const removed = await removeSellerProduct(id, req.user.id);
    if (!removed) return res.status(404).json({ success: false, message: 'Product not found' });

    return res.status(200).json({ success: true, message: 'Listing removed' });
  } catch (error) {
    console.error('Delete listing error:', error);
    return res.status(500).json({ success: false, message: 'Unable to remove listing' });
  }
}

module.exports = {
  becomeSeller, getPublicStore, getMySeller, updateMySeller, signUpload,
  getMyProducts, createMyProduct, updateMyProduct, deleteMyProduct,
  validateListing
};
