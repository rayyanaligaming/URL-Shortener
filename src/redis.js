const Redis = require('ioredis');
const config = require('./config');

const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 2,
});

redis.on('error', (err) => console.error('Redis error:', err.code || err.message || err));

module.exports = redis;