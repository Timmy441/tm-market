require('dotenv').config();
const authRoutes = require('./src/routes/authRoutes');
const productRoutes = require('./src/routes/productRoutes');
const pool = require('./db');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 5000;

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});

app.use('/api', limiter);

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'TM Market API is running'
  });
});
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'TM Market backend is healthy'
  });
});
app.get('/api/db-test', async (req, res) => {
  try {
    const result = await pool.query('SELECT current_database() AS database');
    
    res.json({
      success: true,
      message: 'PostgreSQL connection is working',
      database: result.rows[0].database
    });
  } catch (error) {
    console.error('Database connection error:', error);
    
    res.status(500).json({
      success: false,
      message: 'PostgreSQL connection failed'
    });
  }
});

app.listen(PORT, () => {
  console.log(`TM Market API running on http://localhost:${PORT}`);
});