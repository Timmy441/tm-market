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
const orderRoutes = require('./src/routes/orderRoutes');
const paymentRoutes = require('./src/routes/paymentRoutes');
const chatRoutes = require('./src/routes/chatRoutes');
const { paystackWebhook } = require('./src/controllers/paymentController');
const { getCategories } = require('./src/controllers/productController');

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Refusing to start.');
  process.exit(1);
}

const app = express();

app.set('trust proxy', 1); // running behind Fly's proxy
app.use(helmet());
app.use(morgan('tiny'));

// Webhook signature verification requires the untouched raw request body.
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), paystackWebhook);

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

const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.' }
});

// Bank details and withdrawals handle money, so they get a tighter limit.
const payoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again in a few minutes.' }
});

const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'You are sending messages too quickly. Please wait a few minutes.' }
});

app.get('/api/health', (req, res) => res.json({ success: true }));

// Same public paths as before: POST /api/register, POST /api/login (plus GET /api/me)
app.use('/api/register', authLimiter);
app.use('/api/login', authLimiter);
app.use('/api/me/change-password', authLimiter);
app.use('/api/forgot-password', authLimiter);
app.use('/api/reset-password', authLimiter);
app.use('/api', authRoutes);
app.get('/api/categories', getCategories);
app.use('/api/products', productRoutes);
app.use('/api/sellers/me/bank', payoutLimiter);
app.use('/api/sellers/me/withdrawals', payoutLimiter);
app.use('/api/sellers', sellerRoutes);
app.use('/api/admin', adminLimiter, adminRoutes);
app.use('/api/orders', orderLimiter, orderRoutes);
app.use('/api/payments', orderLimiter, paymentRoutes);
app.use('/api/chat', chatLimiter, chatRoutes);

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
