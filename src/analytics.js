const pool = require('./db');

const MAX_BUFFER = 10000;
let buffer = [];
let timer = null;

function detectDevice(ua = '') {
  if (/bot|crawl|spider|slurp|curl|wget/i.test(ua)) return 'bot';
  if (/ipad|tablet/i.test(ua)) return 'tablet';
  if (/mobi|android|iphone/i.test(ua)) return 'mobile';
  return ua ? 'desktop' : 'unknown';
}

function recordClick(code, req) {
  const ua = (req.get('user-agent') || '').slice(0, 300);
  const referrer = (req.get('referer') || '').slice(0, 500) || null;
  buffer.push({ code, at: new Date().toISOString(), referrer, ua, device: detectDevice(ua) });
  if (buffer.length > MAX_BUFFER) buffer.shift();
}

async function flush() {
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try {
    await pool.query(
      `WITH ins AS (
         INSERT INTO clicks (link_id, clicked_at, referrer, user_agent, device)
         SELECT l.id, b.at, b.ref, b.ua, b.dev
         FROM unnest($1::text[], $2::timestamptz[], $3::text[], $4::text[], $5::text[])
              AS b(code, at, ref, ua, dev)
         JOIN links l ON l.code = b.code
         RETURNING link_id
       )
       UPDATE links SET click_count = links.click_count + c.n
       FROM (SELECT link_id, count(*) AS n FROM ins GROUP BY link_id) c
       WHERE links.id = c.link_id`,
      [
        batch.map((click) => click.code),
        batch.map((click) => click.at),
        batch.map((click) => click.referrer),
        batch.map((click) => click.ua),
        batch.map((click) => click.device),
      ]
    );
  } catch (err) {
    console.error('Click flush failed, requeueing:', err.message);
    buffer = batch.concat(buffer).slice(-MAX_BUFFER);
  }
}

function startFlusher(ms = 2000) {
  if (!timer) timer = setInterval(flush, ms);
}

async function stopFlusher() {
  clearInterval(timer);
  timer = null;
  await flush();
}

module.exports = { recordClick, flush, startFlusher, stopFlusher };