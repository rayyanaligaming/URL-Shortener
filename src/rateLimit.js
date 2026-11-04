const redis = require('./redis');

// Runs atomically inside Redis: read bucket, refill, take a token, save.
// KEYS[1] = bucket key, ARGV[1] = capacity, ARGV[2] = refill tokens/second
const TOKEN_BUCKET = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  ts = now
end

local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + (elapsed / 1000) * refill)

local allowed = 0
local retryMs = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retryMs = math.ceil((1 - tokens) / refill * 1000)
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
-- Idle buckets clean themselves up once they would be full again
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / refill * 1000) + 1000)

return { allowed, math.floor(tokens), retryMs }
`;

redis.defineCommand('tokenBucket', { numberOfKeys: 1, lua: TOKEN_BUCKET });

function rateLimit({ name, capacity, refillPerSec, keyFn }) {
  return async (req, res, next) => {
    try {
      const [allowed, remaining, retryMs] = await redis.tokenBucket(
        `rl:${name}:${keyFn(req)}`,
        capacity,
        refillPerSec
      );
      res.set('X-RateLimit-Limit', String(capacity));
      res.set('X-RateLimit-Remaining', String(remaining));
      if (!allowed) {
        res.set('Retry-After', String(Math.ceil(retryMs / 1000)));
        return res.status(429).json({ error: 'Too many requests, slow down' });
      }
    } catch (err) {
      // Fail open: a Redis outage should not take the whole API down
      console.error('Rate limiter unavailable, allowing request:', err.message);
    }
    next();
  };
}

module.exports = { rateLimit };