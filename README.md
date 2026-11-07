# URL Shortener

A URL shortener with a REST API, JWT authentication, Redis-cached redirects, rate limiting, click analytics, and a React frontend.

**Live demo:** https://url-shortener-neon-nine.vercel.app
**API:** https://url-shortener-eb27.onrender.com (health check: `/health`)

> The API runs on a free Render instance and the database on a free Neon instance, so the first request after a period of inactivity can take 30 to 60 seconds while they wake up.

**Stack:** Node.js, Express, PostgreSQL, Redis, Docker, React (Vite), Jest and Supertest

## Features

- **Short links with random 7-character codes** generated from a cryptographically secure source (62^7, about 3.5 trillion combinations). Collisions are resolved by a database unique constraint plus retries.
- **Custom aliases and expiring links.** Aliases are validated and reserved words are blocked.
- **Fast redirects.** Redis cache-aside with a TTL that never outlives the link's expiry, negative caching for unknown codes, and a graceful fallback to Postgres if Redis is down.
- **Click analytics.** Clicks are buffered in memory and written to Postgres in one batched statement every 2 seconds, so recording a click never slows a redirect. Stats show clicks per day, top referrers, and device breakdown.
- **JWT authentication.** Passwords are hashed with bcrypt, and users can only see and delete their own links.
- **Rate limiting.** A token bucket implemented as a Redis Lua script, so the limit is atomic and shared across app instances.
- **Input validation and safety.** Only `http` and `https` targets are accepted, links to the service's own host are rejected, queries are parameterized, and `helmet` sets security headers.
- **Operations.** Health endpoint that checks both dependencies, graceful shutdown that flushes buffered clicks, SQL migrations, and Docker Compose for local setup.

## Architecture

```mermaid
flowchart LR
    Browser[React app<br/>Vercel] -->|REST + JWT| API[Express API<br/>Render, Docker]
    Visitor[Anyone with a short link] -->|GET /:code| API
    API -->|cache read/write<br/>rate-limit buckets| Redis[(Redis<br/>Upstash)]
    API -->|users, links, clicks| PG[(PostgreSQL<br/>Neon)]
```

**Redirect flow (`GET /:code`)**

1. Reject malformed codes immediately.
2. Look up `url:{code}` in Redis. On a hit, record the click and redirect with `302`.
3. On a miss, query Postgres. If the link is missing or expired, cache a short "not found" marker and return `404`.
4. Otherwise cache the URL (TTL is the smaller of 24 hours and the time until expiry), record the click, and redirect.

Postgres is the source of truth. Redis holds only disposable data (cache entries and rate-limit buckets), so if Redis fails the service gets slower, not wrong.

**Why `302` and not `301`?** A `301` is cached by browsers, so repeat clicks would never reach the server. That would break analytics and make it impossible to expire or change a link.

## API

All protected routes need `Authorization: Bearer <token>`.

| Method and path | Auth | Description |
|---|---|---|
| `POST /api/auth/register` | no | Create an account, returns a token |
| `POST /api/auth/login` | no | Log in, returns a token valid for 1 hour |
| `POST /api/links` | yes | Create a short link. Body: `{ "url", "customAlias"?, "expiresAt"? }` |
| `GET /api/links` | yes | List your 50 most recent links |
| `GET /api/links/:code/stats?days=30` | yes | Clicks per day, top referrers, devices (1 to 365 days) |
| `DELETE /api/links/:code` | yes | Delete one of your links |
| `GET /:code` | no | Redirect to the original URL |
| `GET /health` | no | Postgres and Redis status |

Common responses: `400` invalid input, `401` missing or invalid token, `404` not found (also returned for links that belong to someone else), `409` email or alias already taken, `429` rate limited (with a `Retry-After` header).

**Example**

```bash
BASE=https://url-shortener-eb27.onrender.com

# Register (or log in) and copy the token from the response
curl -X POST $BASE/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"a-long-password"}'

# Shorten a URL
curl -X POST $BASE/api/links \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/some/very/long/path?x=1"}'
```

## Run locally

Requires Node.js 18 or newer and Docker Desktop.

```bash
# 1. Install dependencies
npm install

# 2. Create a .env file
#    PORT=3000
#    BASE_URL=http://localhost:3000
#    DATABASE_URL=postgres://shortener:shortener@127.0.0.1:5432/shortener
#    REDIS_URL=redis://127.0.0.1:6379
#    JWT_SECRET=<a long random string>

# 3. Start Postgres and Redis, create the tables, run the API
docker compose up -d postgres redis
npm run migrate
npm run dev
```

Check it with `curl http://localhost:3000/health`, which should report both services as `up`.

To run the whole stack (API included) in containers instead: `docker compose up --build -d`.

**Frontend**

```bash
cd frontend
npm install
echo VITE_API_URL=http://localhost:3000 > .env
npm run dev
```

### Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Port the API listens on |
| `BASE_URL` | Prefix for returned short links, and used to block links to the service itself |
| `DATABASE_URL` | Postgres connection string (hosted databases need `sslmode=require`) |
| `REDIS_URL` | Redis connection string (hosted Redis often needs `rediss://`) |
| `JWT_SECRET` | Secret used to sign tokens. Use a fresh random value in production |
| `CACHE_ENABLED` | Set to `false` to bypass the redirect cache (used for benchmarking) |

## Tests

15 integration tests (Jest and Supertest) run against a separate database and Redis DB, so they never touch development data.

```bash
docker compose exec postgres psql -U shortener -d shortener -c "CREATE DATABASE shortener_test"
DATABASE_URL=postgres://shortener:shortener@127.0.0.1:5432/shortener_test npm run migrate
npm test
```

On Windows PowerShell, set the variable first with `$env:DATABASE_URL="..."`, run `npm run migrate`, then `Remove-Item Env:DATABASE_URL`.

They cover registration and login, duplicate emails, validation, redirect cache miss then hit, custom aliases, ownership rules, cache invalidation on delete, link expiry, click analytics, and both rate limiters.

## Redirect Cache Benchmark

Measured on 2026-11-04 using one warmed short link and the local Docker Postgres/Redis services. Both modes ran the same redirect path with click analytics enabled; the cache-off mode bypassed Redis cache reads and writes.

| Setting        | Avg req/s | Avg latency |   p99 | Requests | Status codes |
| -------------- | --------: | ----------: | ----: | -------: | ------------ |
| Cache enabled  |  2,234.74 |    44.45 ms | 65 ms |   33,513 | 33,513 x 302 |
| Cache disabled |  1,527.74 |    64.85 ms | 98 ms |   22,916 | 22,916 x 302 |

Caching gave about 1.46x the throughput and about 34% lower p99 latency.

Conditions: Windows 11 Pro, Intel Core i7-8650U at 1.90 GHz, 15.9 GB RAM; Node.js 22.15.0; autocannon 8.0.0; 100 concurrent connections; 15 seconds per run; each mode ran twice and the second result is reported. The production entry point (`node src/server.js`, the target of `npm start`) was used without nodemon. The workload repeatedly requested a single hot link from localhost. These are local synthetic results, not production capacity guarantees.

## Design decisions

| Decision | Reason |
|---|---|
| Random codes with a `UNIQUE` constraint | Unguessable codes, no coordination between servers, and the database settles races. A check-then-insert would be racy. |
| `302` redirects | Every click reaches the server, so analytics and expiry work. |
| Cache TTL = min(24 h, time until expiry) | An expired link can never be served from cache, with no cleanup job. |
| Delete cache keys on create and delete | Prevents deleted links from redirecting and "not found" markers from hiding new links. |
| Negative caching (60 s) | Floods of random codes do not hit Postgres. |
| Lua token bucket in Redis | Read, refill, and spend happen atomically, shared across instances, using Redis's own clock. |
| Rate limiter fails open | A Redis outage should not take the whole API down. |
| Batched, buffered click writes | Redirects never wait on a database write. Trade-off: a crash can lose about 2 seconds of clicks. |
| Click insert and counter update in one SQL statement | The `click_count` cannot drift from the rows. |
| `404` for links owned by others | Does not reveal which codes exist. |
| Stateless API with JWTs | Any instance can verify a token, so the API can scale horizontally. |

## Known limitations

- CORS allows any origin, and the frontend stores the token in `localStorage`. An httpOnly cookie plus a restricted CORS origin would be safer.
- Tokens cannot be revoked before they expire (1 hour). Refresh tokens and a revocation list would fix this.
- Clicks are buffered in memory, so up to about 2 seconds of clicks can be lost in a crash. A durable queue would remove that risk.
- No protection against cache stampedes on a hot key, no URL reputation checks, and no rate limit on the redirect route.
- Single Redis and Postgres instance. The link list returns the latest 50 without pagination.
- The benchmark is a single-machine, single-link comparison and does not represent production capacity.

## Project structure

```
src/
  app.js            Express app, middleware, routes
  server.js         Startup, click flusher, graceful shutdown
  config.js         Environment variables (fails fast if missing)
  db.js, redis.js   Postgres pool and Redis client
  auth.js           JWT signing and auth middleware
  codes.js          Secure base62 code generator
  rateLimit.js      Lua token bucket and middleware
  analytics.js      Click buffer and batched writer
  migrate.js        SQL migration runner
  routes/           auth, links, redirect
migrations/         Numbered SQL files
tests/              Jest and Supertest suite
frontend/           React (Vite) app
Dockerfile, docker-compose.yml
```

## Deployment Notes

Free Render services may sleep while idle, so the first request after inactivity can take 30 to 60 seconds.

The API runs as a Docker image on Render, with Postgres on Neon, Redis on Upstash (TLS, `rediss://`), and the React app on Vercel. Configuration is supplied through environment variables, and migrations run when the container starts. `trust proxy` is enabled so rate limiting sees the real client address behind the platform's proxy.
