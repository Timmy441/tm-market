require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./src/routes/authRoutes');
const productRoutes = require('./src/routes/productRoutes');
const sellerRoutes = require('./src/routes/sellerRoutes');
const adminRoutes = require('./src/routes/adminRoutes');
const { getCategories } = require('./src/controllers/productController');

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Refusing to start.');
  process.exit(1);
}

const app = express();

app.set('trust proxy', 1); // running behind Fly's proxy
app.use(helmet());
app.use(morgan('tiny'));
app.use(express.json({ limit: '100kb' }));

const allowedOrigins = [
  'http://localhost:5000',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
  'https://tm-market-pi.vercel.app',
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean)
];

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('CORS policy blocked this origin.'));
  },
  credentials: true
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again in a few minutes.' }
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.' }
});

app.get('/api/health', (req, res) => res.json({ success: true }));

// Same public paths as before: POST /api/register, POST /api/login (plus GET /api/me)
app.use('/api/register', authLimiter);
app.use('/api/login', authLimiter);
app.use('/api', authRoutes);
app.get('/api/categories', getCategories);
app.use('/api/products', productRoutes);
app.use('/api/sellers', sellerRoutes);
app.use('/api/admin', adminLimiter, adminRoutes);

app.use((req, res) => res.status(404).json({ success: false, message: 'Not found' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.message === 'CORS policy blocked this origin.') {
    return res.status(403).json({ success: false, message: err.message });
  }
  console.error('Unhandled error:', err);
  return res.status(500).json({ success: false, message: 'Something went wrong' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
