const express = require('express');
const pool = require('../db');
const redis = require('../redis');
const { recordClick } = require('../analytics');

const router = express.Router();

const CODE_RE = /^[A-Za-z0-9_-]{1,16}$/;
const MAX_TTL = 24 * 60 * 60; // cache entries live at most 24h
const NEGATIVE_TTL = 60; // cache "not found" for 60s
const NOT_FOUND = '__NF__';
const CACHE_ENABLED = process.env.CACHE_ENABLED !== 'false';

router.get('/:code', async (req, res) => {
  const { code } = req.params;
  if (!CODE_RE.test(code)) return res.status(404).json({ error: 'Not found' });

  const key = `url:${code}`;

  // 1. Try the cache. If Redis is down, fall through to Postgres.
  if (CACHE_ENABLED) {
    try {
      const cached = await redis.get(key);
      if (cached === NOT_FOUND) return res.status(404).json({ error: 'Not found' });
      if (cached) {
        res.set('X-Cache', 'HIT');
        recordClick(code, req);
        return res.redirect(302, cached);
      }
    } catch (err) {
      console.error('Redis read failed, falling back to DB:', err.message);
    }
  }

  // 2. Cache miss: ask Postgres.
  try {
    const { rows } = await pool.query(
      'SELECT long_url, expires_at FROM links WHERE code = $1',
      [code]
    );
    const row = rows[0];

    let ttl = MAX_TTL;
    let gone = !row;
    if (row && row.expires_at) {
      const secsLeft = Math.floor((new Date(row.expires_at) - Date.now()) / 1000);
      if (secsLeft <= 0) gone = true;
      else ttl = Math.min(ttl, secsLeft); // cache never outlives the link
    }

    if (gone) {
      // Negative caching: protects Postgres from floods of bogus codes
      if (CACHE_ENABLED) redis.set(key, NOT_FOUND, 'EX', NEGATIVE_TTL).catch(() => {});
      return res.status(404).json({ error: 'Not found' });
    }

    // 3. Populate the cache for next time.
    if (CACHE_ENABLED) redis.set(key, row.long_url, 'EX', ttl).catch(() => {});

    recordClick(code, req);
    res.set('X-Cache', 'MISS');
    return res.redirect(302, row.long_url);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;