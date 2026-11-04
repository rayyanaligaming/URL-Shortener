# URL Shortener

## Redirect Cache Benchmark

Measured on 2026-11-04 using one warmed short link and the local Docker Postgres/Redis services. Both modes ran the same redirect path with click analytics enabled; the cache-off mode bypassed Redis cache reads and writes.

| Setting        | Avg req/s | Avg latency | p97.5 |   p99 | Requests | Status codes |
| -------------- | --------: | ----------: | ----: | ----: | -------: | ------------ |
| Cache enabled  |  2,234.74 |    44.45 ms | 60 ms | 65 ms |   33,513 | 33,513 x 302 |
| Cache disabled |  1,527.74 |    64.85 ms | 89 ms | 98 ms |   22,916 | 22,916 x 302 |

Conditions: Windows 11 Pro, Intel Core i7-8650U at 1.90 GHz, 15.9 GB RAM; Node.js 22.15.0; autocannon 8.0.0; 100 concurrent connections; 15 seconds per run; each mode ran twice and the second result is reported. The production entry point (`node src/server.js`, the target of `npm start`) was used without nodemon. The workload repeatedly requested a single hot link from localhost. These are local synthetic results, not production capacity guarantees.

## Deployment Notes

Free Render services may sleep while idle, so the first request after inactivity can take 30 to 60 seconds.
