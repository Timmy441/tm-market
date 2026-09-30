const pool = require('../../db');

const LIST_SORTS = {
  newest: 'p.created_at DESC, p.id DESC',
  price_asc: 'p.price ASC, p.id DESC',
  price_desc: 'p.price DESC, p.id DESC'
};

const PRODUCT_SELECT = `
      p.id,
      p.category_id,
      c.slug AS category_slug,
      c.name AS category_name,
      p.name,
      p.slug,
      p.description,
      p.price,
      p.compare_at_price,
      p.sku,
      p.brand,
      p.location,
      p.status,
      p.seller_id,
      sp.store_name AS seller_name,
      sp.location AS seller_location,
      i.quantity,
      (p.status = 'active' AND (i.quantity IS NULL OR i.quantity > 0)) AS available,
      p.is_featured,
      p.created_at`;

const PRODUCT_JOINS = `
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN seller_profiles sp ON sp.user_id = p.seller_id
     LEFT JOIN inventory i ON i.product_id = p.id`;

const FIRST_IMAGE = `(
        SELECT pi.image_url
        FROM product_images pi
        WHERE pi.product_id = p.id
        ORDER BY pi.sort_order, pi.id
        LIMIT 1
      ) AS image_url`;

async function listProducts({ search, categoryId, categorySlug, location, minPrice, maxPrice, sort, featured, limit, offset }) {
  const conditions = ["p.is_active = TRUE", "p.status = 'active'"];
  const values = [];

  if (search) {
    values.push(`%${search}%`);
    conditions.push(
      `(p.name ILIKE $${values.length} OR p.brand ILIKE $${values.length} OR p.description ILIKE $${values.length})`
    );
  }

  if (categoryId) {
    values.push(categoryId);
    conditions.push(`p.category_id = $${values.length}`);
  }

  if (categorySlug) {
    values.push(categorySlug);
    conditions.push(`c.slug = $${values.length}`);
  }

  if (location) {
    values.push(`%${location}%`);
    conditions.push(`p.location ILIKE $${values.length}`);
  }

  if (minPrice !== null && minPrice !== undefined) {
    values.push(minPrice);
    conditions.push(`p.price >= $${values.length}`);
  }

  if (maxPrice !== null && maxPrice !== undefined) {
    values.push(maxPrice);
    conditions.push(`p.price <= $${values.length}`);
  }

  if (featured) {
    conditions.push('p.is_featured = TRUE');
  }

  const where = conditions.join(' AND ');
  const orderBy = LIST_SORTS[sort] || LIST_SORTS.newest;

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total ${PRODUCT_JOINS} WHERE ${where}`,
    values
  );

  values.push(limit);
  values.push(offset);

  const result = await pool.query(
    `SELECT ${PRODUCT_SELECT}, ${FIRST_IMAGE}
     ${PRODUCT_JOINS}
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );

  return {
    products: result.rows,
    total: countResult.rows[0].total
  };
}

async function findProductById(id) {
  const productResult = await pool.query(
    `SELECT ${PRODUCT_SELECT}, p.is_active, p.updated_at
     ${PRODUCT_JOINS}
     WHERE p.id = $1
     LIMIT 1`,
    [id]
  );

  const product = productResult.rows[0];

  if (!product) {
    return null;
  }

  const imagesResult = await pool.query(
    `SELECT id, image_url, alt_text, sort_order
     FROM product_images
     WHERE product_id = $1
     ORDER BY sort_order, id`,
    [id]
  );

  product.images = imagesResult.rows;

  return product;
}

async function createProduct({
  categoryId,
  name,
  slug,
  description,
  price,
  compareAtPrice,
  sku,
  brand,
  isActive,
  isFeatured,
  images
}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO products (
        category_id,
        name,
        slug,
        description,
        price,
        compare_at_price,
        sku,
        brand,
        is_active,
        is_featured
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id`,
      [
        categoryId || null,
        name,
        slug,
        description || null,
        price,
        compareAtPrice === undefined ? null : compareAtPrice,
        sku || null,
        brand || null,
        isActive === undefined ? true : isActive,
        isFeatured === undefined ? false : isFeatured
      ]
    );

    const productId = result.rows[0].id;
    const imageList = images || [];

    for (let i = 0; i < imageList.length; i++) {
      await client.query(
        `INSERT INTO product_images (
          product_id,
          image_url,
          alt_text,
          sort_order
        )
        VALUES ($1, $2, $3, $4)`,
        [
          productId,
          imageList[i].imageUrl,
          imageList[i].altText || null,
          i
        ]
      );
    }

    await client.query('COMMIT');

    return productId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const UPDATABLE_COLUMNS = {
  categoryId: 'category_id',
  name: 'name',
  slug: 'slug',
  description: 'description',
  price: 'price',
  compareAtPrice: 'compare_at_price',
  sku: 'sku',
  brand: 'brand',
  isActive: 'is_active',
  isFeatured: 'is_featured'
};

async function updateProduct(id, fields) {
  const sets = [];
  const values = [];

  for (const [key, column] of Object.entries(UPDATABLE_COLUMNS)) {
    if (fields[key] !== undefined) {
      values.push(fields[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }

  if (sets.length === 0) {
    return false;
  }

  values.push(id);

  const result = await pool.query(
    `UPDATE products
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING id`,
    values
  );

  return result.rowCount > 0;
}

async function deactivateProduct(id) {
  const result = await pool.query(
    `UPDATE products
     SET is_active = FALSE, status = 'removed', updated_at = NOW()
     WHERE id = $1
     RETURNING id`,
    [id]
  );

  return result.rowCount > 0;
}


async function listCategories() {
  const r = await pool.query(
    `SELECT id, name, slug FROM categories WHERE is_active = TRUE ORDER BY name`
  );
  return r.rows;
}

// ---------- seller-owned listings: every query is scoped to seller_id ----------

async function listSellerProducts(sellerId) {
  const r = await pool.query(
    `SELECT ${PRODUCT_SELECT}, p.is_active, p.updated_at, ${FIRST_IMAGE}
     ${PRODUCT_JOINS}
     WHERE p.seller_id = $1 AND p.status <> 'removed'
     ORDER BY p.created_at DESC, p.id DESC`,
    [sellerId]
  );
  return r.rows;
}

async function findSellerProduct(id, sellerId) {
  const product = await findProductById(id);
  if (!product || product.seller_id === null || String(product.seller_id) !== String(sellerId)) return null;
  return product;
}

async function replaceImages(client, productId, images) {
  await client.query('DELETE FROM product_images WHERE product_id = $1', [productId]);
  for (let i = 0; i < images.length; i++) {
    await client.query(
      `INSERT INTO product_images (product_id, image_url, alt_text, sort_order) VALUES ($1, $2, $3, $4)`,
      [productId, images[i].imageUrl, images[i].altText || null, i]
    );
  }
}

async function createSellerProduct(sellerId, d) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query(
      `INSERT INTO products (seller_id, category_id, name, slug, description, price, location, status, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE) RETURNING id`,
      [sellerId, d.categoryId || null, d.name, d.slug, d.description || null, d.price, d.location, d.status]
    );
    const productId = r.rows[0].id;

    await client.query(`INSERT INTO inventory (product_id, quantity) VALUES ($1, $2)`, [productId, d.quantity]);
    await replaceImages(client, productId, d.images || []);

    await client.query('COMMIT');
    return productId;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Returns false when the product does not exist OR is not owned by this seller.
async function updateSellerProduct(id, sellerId, d) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const map = { categoryId: 'category_id', name: 'name', description: 'description', price: 'price', location: 'location', status: 'status' };
    const sets = [];
    const values = [];
    for (const [key, col] of Object.entries(map)) {
      if (d[key] !== undefined) { values.push(d[key]); sets.push(`${col} = $${values.length}`); }
    }
    if (d.status === 'active' || d.status === 'sold') sets.push('is_active = TRUE');

    values.push(id, sellerId);
    const r = await client.query(
      `UPDATE products SET ${sets.length ? sets.join(', ') + ',' : ''} updated_at = NOW()
       WHERE id = $${values.length - 1} AND seller_id = $${values.length} AND status <> 'removed'
       RETURNING id`,
      values
    );

    if (r.rowCount === 0) { await client.query('ROLLBACK'); return false; }

    if (d.quantity !== undefined) {
      await client.query(
        `INSERT INTO inventory (product_id, quantity) VALUES ($1, $2)
         ON CONFLICT (product_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = NOW()`,
        [id, d.quantity]
      );
    }
    if (d.images !== undefined) await replaceImages(client, id, d.images);

    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function removeSellerProduct(id, sellerId) {
  const r = await pool.query(
    `UPDATE products SET is_active = FALSE, status = 'removed', updated_at = NOW()
     WHERE id = $1 AND seller_id = $2 AND status <> 'removed' RETURNING id`,
    [id, sellerId]
  );
  return r.rowCount > 0;
}

module.exports = {
  listProducts,
  findProductById,
  createProduct,
  updateProduct,
  deactivateProduct,
  listCategories,
  listSellerProducts,
  findSellerProduct,
  createSellerProduct,
  updateSellerProduct,
  removeSellerProduct
};