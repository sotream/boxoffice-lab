# waiting-room: measured results

Setup: MacBook Air M1, Node 26, NestJS 12 / Fastify 5, Redis 7 in Docker, k6 100 VUs, 20 s. Each iteration: 1 join + 2 status polls (3 requests). Script `load/join.js`.

| Metric | Value |
|---|---|
| Requests/s (all endpoints) | 10 134 |
| p50 / p95 / p99 | 8.9 / 16.0 / 22.3 ms |
| Users in queue after run | 57 497 (about 67.5 k joined, 10 k admitted at 500/s) |
| Redis memory | 7.68 MB total (`used_memory_human`), so at most 140 B per queued user (7.68 MiB / 57 497); includes 10 000 admitted keys and the Redis baseline, so the per-user cost is lower; planning figure 100 to 150 B |

Reading: the waiting room absorbs ~3.8x more requests per instance than `inventory` accepts holds, and costs a fraction of the database load. That ratio is the reason it exists.
