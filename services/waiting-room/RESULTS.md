# waiting-room: measured results

Setup: MacBook Air M1, Node 22 + Fastify, Redis 7 in Docker, k6 100 VUs, 20 s. Each iteration: 1 join + 2 status polls (3 requests). Script `load/join.js`.

| Metric | Value |
|---|---|
| Requests/s (all endpoints) | 7 656 |
| p50 / p95 / p99 | 11.9 / 21.5 / 27.8 ms |
| Users in queue after run | 41 145 (51 k joined, 10 k admitted at 500/s) |
| Redis memory | 6 MB total, so ~100 B per user |

Reading: the waiting room absorbs ~3x more requests per instance than `inventory` accepts holds, and costs a fraction of the database load. That ratio is the reason it exists.
