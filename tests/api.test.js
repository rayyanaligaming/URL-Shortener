const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/db');
const redis = require('../src/redis');
const { flush } = require('../src/analytics');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function register(email) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123' });
  return res.body.token;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await pool.query('TRUNCATE users, links, clicks RESTART IDENTITY CASCADE');
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await pool.end();
  await redis.quit();
});

describe('health', () => {
  test('reports postgres and redis up', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ postgres: 'up', redis: 'up' });
  });
});

describe('auth', () => {
  test('register, then login, then access a protected route', async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'a@test.com', password: 'password123' });
    expect(reg.status).toBe(201);
    expect(reg.body.token).toBeDefined();

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'a@test.com', password: 'password123' });
    expect(login.status).toBe(200);

    const me = await request(app).get('/api/me').set(auth(login.body.token));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('a@test.com');
  });

  test('duplicate email is rejected, case-insensitively', async () => {
    await register('dup@test.com');
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'DUP@test.com', password: 'password123' });
    expect(res.status).toBe(409);
  });

  test('rejects short password, wrong password, and missing token', async () => {
    const short = await request(app)
      .post('/api/auth/register')
      .send({ email: 'short@test.com', password: 'abc' });
    expect(short.status).toBe(400);

    await register('wrong@test.com');
    const bad = await request(app)
      .post('/api/auth/login')
      .send({ email: 'wrong@test.com', password: 'nottherightone' });
    expect(bad.status).toBe(401);

    const noToken = await request(app).get('/api/me');
    expect(noToken.status).toBe(401);
  });
});

describe('links and redirects', () => {
  test('create then redirect with 302, MISS then HIT', async () => {
    const token = await register('links1@test.com');
    const created = await request(app)
      .post('/api/links')
      .set(auth(token))
      .send({ url: 'https://example.com/page' });
    expect(created.status).toBe(201);

    const first = await request(app).get(`/${created.body.code}`);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe('https://example.com/page');
    expect(first.headers['x-cache']).toBe('MISS');

    const second = await request(app).get(`/${created.body.code}`);
    expect(second.status).toBe(302);
    expect(second.headers['x-cache']).toBe('HIT');
  });

  test('unknown code returns 404', async () => {
    const res = await request(app).get('/doesnotexist');
    expect(res.status).toBe(404);
  });

  test('rejects non-http URLs', async () => {
    const token = await register('links2@test.com');
    const res = await request(app)
      .post('/api/links')
      .set(auth(token))
      .send({ url: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
  });

  test('custom alias works and a duplicate alias returns 409', async () => {
    const token = await register('links3@test.com');
    const body = { url: 'https://example.org', customAlias: 'my-alias' };
    const ok = await request(app).post('/api/links').set(auth(token)).send(body);
    expect(ok.status).toBe(201);
    const dup = await request(app).post('/api/links').set(auth(token)).send(body);
    expect(dup.status).toBe(409);
  });

  test("a user cannot delete someone else's link", async () => {
    const owner = await register('owner@test.com');
    const other = await register('other@test.com');
    const link = await request(app)
      .post('/api/links')
      .set(auth(owner))
      .send({ url: 'https://example.com/private' });

    const del = await request(app).delete(`/api/links/${link.body.code}`).set(auth(other));
    expect(del.status).toBe(404);

    const still = await request(app).get(`/${link.body.code}`);
    expect(still.status).toBe(302);
  });

  test('deleting a link invalidates the cache', async () => {
    const token = await register('del@test.com');
    const link = await request(app)
      .post('/api/links')
      .set(auth(token))
      .send({ url: 'https://example.com/gone' });
    await request(app).get(`/${link.body.code}`);
    const del = await request(app).delete(`/api/links/${link.body.code}`).set(auth(token));
    expect(del.status).toBe(204);
    const after = await request(app).get(`/${link.body.code}`);
    expect(after.status).toBe(404);
  });

  test('an expired link stops redirecting even though it was cached', async () => {
    const token = await register('exp@test.com');
    const link = await request(app)
      .post('/api/links')
      .set(auth(token))
      .send({
        url: 'https://example.com/soon',
        expiresAt: new Date(Date.now() + 2000).toISOString(),
      });
    const live = await request(app).get(`/${link.body.code}`);
    expect(live.status).toBe(302);
    await sleep(2300);
    const dead = await request(app).get(`/${link.body.code}`);
    expect(dead.status).toBe(404);
  });
});

describe('analytics', () => {
  test('clicks are counted and broken down by device and referrer', async () => {
    const token = await register('stats@test.com');
    const link = await request(app)
      .post('/api/links')
      .set(auth(token))
      .send({ url: 'https://example.com/stats' });

    for (let i = 0; i < 3; i++) {
      await request(app)
        .get(`/${link.body.code}`)
        .set('User-Agent', 'Mozilla/5.0 (iPhone)')
        .set('Referer', 'https://twitter.com');
    }
    await flush();

    const stats = await request(app)
      .get(`/api/links/${link.body.code}/stats`)
      .set(auth(token));
    expect(stats.status).toBe(200);
    expect(stats.body.totalClicks).toBe(3);
    expect(stats.body.devices).toEqual([{ device: 'mobile', clicks: 3 }]);
    expect(stats.body.topReferrers[0]).toEqual({ referrer: 'https://twitter.com', clicks: 3 });
  });

  test("stats of another user's link return 404", async () => {
    const owner = await register('so@test.com');
    const other = await register('so2@test.com');
    const link = await request(app)
      .post('/api/links')
      .set(auth(owner))
      .send({ url: 'https://example.com/x' });
    const res = await request(app).get(`/api/links/${link.body.code}/stats`).set(auth(other));
    expect(res.status).toBe(404);
  });
});

describe('rate limiting', () => {
  test('link creation is limited to a burst of 20 per user', async () => {
    const token = await register('rl@test.com');
    const statuses = [];
    for (let i = 0; i < 25; i++) {
      const res = await request(app)
        .post('/api/links')
        .set(auth(token))
        .send({ url: `https://example.com/${i}` });
      statuses.push(res.status);
    }
    expect(statuses.filter((status) => status === 201).length).toBe(20);
    expect(statuses.filter((status) => status === 429).length).toBe(5);
  });

  test('login attempts are limited per IP', async () => {
    const statuses = [];
    for (let i = 0; i < 15; i++) {
      const res = await request(app).post('/api/auth/login').send({});
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true);
    expect(statuses.slice(10).some((status) => status === 429)).toBe(true);
  });
});