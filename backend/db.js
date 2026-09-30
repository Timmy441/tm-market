const { Pool } = require('pg');

// Hosted Postgres (Fly, Neon, Supabase...) usually provides DATABASE_URL.
// Otherwise the existing DB_* variables are used, exactly as before.
const ssl = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined;

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl })
  : new Pool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl
    });

module.exports = pool;
