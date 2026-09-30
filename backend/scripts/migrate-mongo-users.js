// One-time import of existing MongoDB users into PostgreSQL. Passwords keep working
// (the bcrypt hashes are copied as-is). DRY RUN by default; add --apply to write.
//   MONGO_URI=... node scripts/migrate-mongo-users.js
//   MONGO_URI=... node scripts/migrate-mongo-users.js --apply
require('dotenv').config();
const mongoose = require('mongoose');
const pool = require('../db');

const APPLY = process.argv.includes('--apply');

(async () => {
  if (!process.env.MONGO_URI) throw new Error('Set MONGO_URI to read the old users.');
  await mongoose.connect(process.env.MONGO_URI);
  const docs = await mongoose.connection.db.collection('users').find({}).sort({ createdAt: 1 }).toArray();

  const seen = new Set();
  let imported = 0, duplicates = 0, existing = 0;

  for (const d of docs) {
    const email = String(d.email || '').trim().toLowerCase();
    if (!email || !d.password) { console.log('skip (missing email/password):', d._id); continue; }
    if (seen.has(email)) { duplicates++; console.log('duplicate email (kept oldest):', email); continue; }
    seen.add(email);

    const parts = String(d.name || '').trim().split(/\s+/).filter(Boolean);
    const first = parts[0] || 'Customer';
    const last = parts.slice(1).join(' ');

    if (!APPLY) { imported++; continue; }

    const r = await pool.query(
      `INSERT INTO users (first_name, last_name, email, password_hash, created_at)
       VALUES ($1, $2, $3, $4, COALESCE($5, NOW()))
       ON CONFLICT ((lower(email))) DO NOTHING`,
      [first, last, email, d.password, d.createdAt || null]
    );
    if (r.rowCount) imported++; else existing++;
  }

  console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}: ${docs.length} Mongo users, ${imported} ${APPLY ? 'imported' : 'would import'}, ${existing} already in Postgres, ${duplicates} case-duplicates skipped.`);
  await mongoose.disconnect();
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
