const pool = require('../../db');

async function listProducts({ search, categoryId, featured, limit, offset }) {
  const conditions = ['p.is_active = TRUE'];
  const values = [];

  if (search) {
    values.push(`%${search}%`);
    conditions.push(
      `(p.name ILIKE $${values.length} OR p.brand ILIKE $${values.length})`
    );
  }

  if (categoryId) {
    values.push(categoryId);
    conditions.push(`p.category_id = $${values.length}`);
  }

  if (featured) {
    conditions.push('p.is_featured = TRUE');
  }

  const where = conditions.join(' AND ');

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM products p
     WHERE ${where}`,
    values
  );

  values.push(limit);
  values.push(offset);

  const result = await pool.query(
    `SELECT
      p.id,
      p.category_id,
      c.slug AS category_slug,
      p.name,
      p.slug,
      p.description,
      p.price,
      p.compare_at_price,
      p.sku,
      p.brand,
      p.is_featured,
      p.created_at,
      (
        SELECT pi.image_url
        FROM product_images pi
        WHERE pi.product_id = p.id
        ORDER BY pi.sort_order, pi.id
        LIMIT 1
      ) AS image_url
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE ${where}
     ORDER BY p.created_at DESC, p.id DESC
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
    `SELECT
      p.id,
      p.category_id,
      c.slug AS category_slug,
      p.name,
      p.slug,
      p.description,
      p.price,
      p.compare_at_price,
      p.sku,
      p.brand,
      p.is_active,
      p.is_featured,
      p.created_at,
      p.updated_at
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
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
     SET is_active = FALSE, updated_at = NOW()
     WHERE id = $1
     RETURNING id`,
    [id]
  );

  return result.rowCount > 0;
}

module.exports = {
  listProducts,
  findProductById,
  createProduct,
  updateProduct,
  deactivateProduct
};