const express = require('express');
const pool = require('../db');
const redis = require('../redis');
const config = require('../config');
const { requireAuth } = require('../auth');

const { generateCode } = require('../codes');
const { rateLimit } = require('../rateLimit');

const router = express.Router();

const ALIAS_RE = /^[A-Za-z0-9_-]{3,16}$/;
const RESERVED = new Set(['api', 'health']);
const MAX_URL_LENGTH = 2048;

const createLimiter = rateLimit({
  name: 'create',
  capacity: 20,
  refillPerSec: 0.5, // burst of 20, then 1 every 2 seconds
  keyFn: (req) => req.user.id,
});

// Returns a normalized URL string, or null if invalid.
function validateUrl(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH) return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  // Only http/https: blocks javascript:, data:, file:
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // Don't allow links pointing at ourselves (redirect loops)
  if (u.host === new URL(config.baseUrl).host) return null;
  return u.toString();
}

const withShortUrl = (row) => ({ ...row, shortUrl: `${config.baseUrl}/${row.code}` });

// CREATE
router.post('/', requireAuth, createLimiter, async (req, res) => {
    
  const { url, customAlias, expiresAt } = req.body || {};

  const longUrl = validateUrl(url);
  if (!longUrl) return res.status(400).json({ error: 'A valid http(s) URL is required' });

  let expires = null;
  if (expiresAt !== undefined && expiresAt !== null) {
    expires = new Date(expiresAt);
    if (isNaN(expires) || expires <= new Date()) {
      return res.status(400).json({ error: 'expiresAt must be a future date' });
    }
  }

  if (customAlias !== undefined) {
    if (
      typeof customAlias !== 'string' ||
      !ALIAS_RE.test(customAlias) ||
      RESERVED.has(customAlias.toLowerCase())
    ) {
      return res.status(400).json({ error: 'Alias must be 3-16 chars: letters, digits, _ or -' });
    }
  }

  // Custom alias: one attempt (collision = 409). Random code: retry on collision.
  const attempts = customAlias ? 1 : 3;
  for (let i = 0; i < attempts; i++) {
    const code = customAlias || generateCode();
    try {
      const { rows } = await pool.query(
        `INSERT INTO links (code, long_url, user_id, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING code, long_url, created_at, expires_at`,
        [code, longUrl, req.user.id, expires]
      );
      // Clear any negative-cache entry ("not found") for this code
      await redis.del(`url:${code}`).catch(() => {});
      return res.status(201).json(withShortUrl(rows[0]));
    } catch (err) {
      if (err.code === '23505') {
        if (customAlias) return res.status(409).json({ error: 'Alias already taken' });
        continue; // random collision: generate a new code
      }
      console.error(err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
  return res.status(500).json({ error: 'Could not generate a unique code, try again' });
});



// LIST (only my links)
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT code, long_url, created_at, expires_at, click_count
       FROM links WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json(rows.map(withShortUrl));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// STATS (only my own links)
router.get('/:code/stats', requireAuth, async (req, res) => {
  try {
    const link = await pool.query(
      'SELECT id, code, long_url, created_at, click_count FROM links WHERE code = $1 AND user_id = $2',
      [req.params.code, req.user.id]
    );
    if (link.rows.length === 0) return res.status(404).json({ error: 'Link not found' });

    const { id, code, long_url, created_at, click_count } = link.rows[0];
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const since = `clicked_at >= now() - make_interval(days => $2)`;

    const [perDay, referrers, devices] = await Promise.all([
      pool.query(
        `SELECT date_trunc('day', clicked_at) AS day, count(*)::int AS clicks
         FROM clicks WHERE link_id = $1 AND ${since}
         GROUP BY 1 ORDER BY 1`,
        [id, days]
      ),
      pool.query(
        `SELECT COALESCE(referrer, 'direct') AS referrer, count(*)::int AS clicks
         FROM clicks WHERE link_id = $1 AND ${since}
         GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
        [id, days]
      ),
      pool.query(
        `SELECT COALESCE(device, 'unknown') AS device, count(*)::int AS clicks
         FROM clicks WHERE link_id = $1 AND ${since}
         GROUP BY 1 ORDER BY 2 DESC`,
        [id, days]
      ),
    ]);

    res.json({
      code,
      longUrl: long_url,
      createdAt: created_at,
      totalClicks: Number(click_count),
      windowDays: days,
      clicksPerDay: perDay.rows,
      topReferrers: referrers.rows,
      devices: devices.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE (only my own links)
router.delete('/:code', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM links WHERE code = $1 AND user_id = $2 RETURNING code',
      [req.params.code, req.user.id]
    );
    // 404 for both "doesn't exist" and "not yours": don't leak which codes exist
    if (rows.length === 0) return res.status(404).json({ error: 'Link not found' });

    // Cache invalidation: without this, the deleted link keeps redirecting
    await redis.del(`url:${req.params.code}`).catch(() => {});
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;