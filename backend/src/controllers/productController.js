const {
  findProductContact,
  listCategories,
  listProducts,
  findProductById,
  createProduct,
  updateProduct,
  deactivateProduct
} = require('../models/productModel');

function parsePositiveInt(value) {
  const number = Number(value);

  return Number.isInteger(number) && number > 0 ? number : null;
}

function parseMoney(value) {
  if (typeof value === 'boolean' || value === null || value === '') {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) && number >= 0 ? number : null;
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 280);
}

function cleanText(value, maxLength) {
  if (value === null) {
    return { value: null };
  }

  if (typeof value !== 'string') {
    return { error: true };
  }

  const trimmed = value.trim();

  if (trimmed.length > maxLength) {
    return { error: true };
  }

  return { value: trimmed === '' ? null : trimmed };
}

function validateFields(body, isUpdate) {
  const data = {};
  const errors = [];

  if (body.name !== undefined || !isUpdate) {
    if (
      typeof body.name !== 'string' ||
      !body.name.trim() ||
      body.name.trim().length > 255
    ) {
      errors.push('name is required (max 255 characters)');
    } else {
      data.name = body.name.trim();
    }
  }

  if (body.slug !== undefined) {
    const slug = slugify(body.slug);

    if (!slug) {
      errors.push('slug is invalid');
    } else {
      data.slug = slug;
    }
  } else if (!isUpdate && data.name) {
    const slug = slugify(data.name);

    if (!slug) {
      errors.push('slug could not be generated from name, please provide a slug');
    } else {
      data.slug = slug;
    }
  }

  if (body.price !== undefined || !isUpdate) {
    const price = parseMoney(body.price);

    if (price === null) {
      errors.push('price is required and must be a number, 0 or more');
    } else {
      data.price = price;
    }
  }

  if (body.compareAtPrice !== undefined) {
    if (body.compareAtPrice === null) {
      data.compareAtPrice = null;
    } else {
      const compareAtPrice = parseMoney(body.compareAtPrice);

      if (compareAtPrice === null) {
        errors.push('compareAtPrice must be a number, 0 or more');
      } else {
        data.compareAtPrice = compareAtPrice;
      }
    }
  }

  if (body.categoryId !== undefined) {
    if (body.categoryId === null) {
      data.categoryId = null;
    } else {
      const categoryId = parsePositiveInt(body.categoryId);

      if (!categoryId) {
        errors.push('categoryId must be a positive whole number');
      } else {
        data.categoryId = categoryId;
      }
    }
  }

  const textFields = [
    ['description', 5000],
    ['sku', 100],
    ['brand', 150]
  ];

  for (const [field, maxLength] of textFields) {
    if (body[field] !== undefined) {
      const cleaned = cleanText(body[field], maxLength);

      if (cleaned.error) {
        errors.push(`${field} must be text (max ${maxLength} characters)`);
      } else {
        data[field] = cleaned.value;
      }
    }
  }

  for (const field of ['isActive', 'isFeatured']) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== 'boolean') {
        errors.push(`${field} must be true or false`);
      } else {
        data[field] = body[field];
      }
    }
  }

  if (!isUpdate && body.images !== undefined) {
    if (!Array.isArray(body.images) || body.images.length > 10) {
      errors.push('images must be a list of up to 10 items');
    } else {
      const images = [];

      for (const image of body.images) {
        if (
          !image ||
          typeof image.imageUrl !== 'string' ||
          !image.imageUrl.trim()
        ) {
          errors.push('each image needs an imageUrl');
          break;
        }

        images.push({
          imageUrl: image.imageUrl.trim(),
          altText:
            typeof image.altText === 'string' ? image.altText.trim() : null
        });
      }

      data.images = images;
    }
  }

  return { data, errors };
}

function handleWriteError(error, res, label) {
  if (error.code === '23505') {
    return res.status(409).json({
      success: false,
      message: 'A product with this slug or SKU already exists'
    });
  }

  if (error.code === '23503') {
    return res.status(400).json({
      success: false,
      message: 'The category does not exist'
    });
  }

  if (error.code === '22003') {
    return res.status(400).json({
      success: false,
      message: 'A number is too large'
    });
  }

  console.error(`${label} error:`, error);

  return res.status(500).json({
    success: false,
    message: 'Unable to save product'
  });
}

async function getProducts(req, res) {
  try {
    const search =
      typeof req.query.search === 'string' ? req.query.search.trim() : '';

    let categoryId = null;

    if (req.query.categoryId !== undefined) {
      categoryId = parsePositiveInt(req.query.categoryId);

      if (!categoryId) {
        return res.status(400).json({
          success: false,
          message: 'Invalid category id'
        });
      }
    }

    // ?category=electronics,fashion  (one or more category slugs)
    const categorySlug =
      typeof req.query.category === 'string'
        ? req.query.category.split(',').map(c => c.trim().toLowerCase()).filter(Boolean).slice(0, 10)
        : [];
    const location =
      typeof req.query.location === 'string' ? req.query.location.trim() : '';
    const minPrice = req.query.minPrice !== undefined ? parseMoney(req.query.minPrice) : null;
    const maxPrice = req.query.maxPrice !== undefined ? parseMoney(req.query.maxPrice) : null;

    if (
      (req.query.minPrice !== undefined && minPrice === null) ||
      (req.query.maxPrice !== undefined && maxPrice === null)
    ) {
      return res.status(400).json({ success: false, message: 'Invalid price filter' });
    }

    const sort = typeof req.query.sort === 'string' ? req.query.sort : 'newest';
    const featured = req.query.featured === 'true';
    const page = parsePositiveInt(req.query.page) || 1;
    const limit = Math.min(parsePositiveInt(req.query.limit) || 20, 50);
    const offset = (page - 1) * limit;

    const { products, total } = await listProducts({
      search,
      categoryId,
      categorySlug,
      location,
      minPrice,
      maxPrice,
      sort,
      featured,
      limit,
      offset
    });

    return res.status(200).json({
      success: true,
      products,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('List products error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to retrieve products'
    });
  }
}

async function getProduct(req, res) {
  try {
    const id = parsePositiveInt(req.params.id);

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product id'
      });
    }

    const product = await findProductById(id);

    if (!product || !product.is_active || product.status !== 'active') {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    return res.status(200).json({
      success: true,
      product
    });
  } catch (error) {
    console.error('Get product error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to retrieve product'
    });
  }
}

async function getProductContact(req, res) {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid product id' });

    const contact = await findProductContact(id);
    if (!contact) return res.status(404).json({ success: false, message: 'Seller contact not available' });

    return res.status(200).json({ success: true, contact: { storeName: contact.store_name, whatsapp: contact.whatsapp } });
  } catch (error) {
    console.error('Product contact error:', error);
    return res.status(500).json({ success: false, message: 'Unable to retrieve seller contact' });
  }
}

async function getCategories(req, res) {
  try {
    return res.status(200).json({ success: true, categories: await listCategories() });
  } catch (error) {
    console.error('List categories error:', error);
    return res.status(500).json({ success: false, message: 'Unable to retrieve categories' });
  }
}

async function createNewProduct(req, res) {
  try {
    const { data, errors } = validateFields(req.body || {}, false);

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: errors.join('; ')
      });
    }

    const productId = await createProduct(data);
    const product = await findProductById(productId);

    return res.status(201).json({
      success: true,
      message: 'Product created successfully',
      product
    });
  } catch (error) {
    return handleWriteError(error, res, 'Create product');
  }
}

async function updateExistingProduct(req, res) {
  try {
    const id = parsePositiveInt(req.params.id);

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product id'
      });
    }

    const { data, errors } = validateFields(req.body || {}, true);

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: errors.join('; ')
      });
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update'
      });
    }

    const updated = await updateProduct(id, data);

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    const product = await findProductById(id);

    return res.status(200).json({
      success: true,
      message: 'Product updated successfully',
      product
    });
  } catch (error) {
    return handleWriteError(error, res, 'Update product');
  }
}

async function removeProduct(req, res) {
  try {
    const id = parsePositiveInt(req.params.id);

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product id'
      });
    }

    const removed = await deactivateProduct(id);

    if (!removed) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Product removed successfully'
    });
  } catch (error) {
    console.error('Remove product error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to remove product'
    });
  }
}

module.exports = {
  parsePositiveInt,
  parseMoney,
  slugify,
  getCategories,
  getProductContact,
  getProducts,
  getProduct,
  createNewProduct,
  updateExistingProduct,
  removeProduct
};