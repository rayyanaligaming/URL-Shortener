const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pool = require('./db');
const redis = require('./redis');
const authRoutes = require('./routes/auth');
const linkRoutes = require('./routes/links');
const redirectRoutes = require('./routes/redirect');
const { rateLimit } = require('./rateLimit');

const app = express();

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10kb' }));
const authLimiter = rateLimit({
  name: 'auth',
  capacity: 10,
  refillPerSec: 10 / 60,
  keyFn: (req) => req.headers['cf-connecting-ip'] || req.ip,
});
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/links', linkRoutes);

// Temporary route to test the middleware; we'll remove it later
const { requireAuth } = require('./auth');
app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.user }));


app.get('/health', async (req, res) => {
  const status = { postgres: 'down', redis: 'down' };
  try {
    await pool.query('SELECT 1');
    status.postgres = 'up';
  } catch (e) {}
  try {
    if ((await redis.ping()) === 'PONG') status.redis = 'up';
  } catch (e) {}

  const healthy = status.postgres === 'up' && status.redis === 'up';
  res.status(healthy ? 200 : 503).json(status);
});


app.use('/', redirectRoutes);
module.exports = app;