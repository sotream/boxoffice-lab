# inventory: measured results

Setup: MacBook Air M1, Node 22 + Fastify, Postgres 17 in Docker (256 MB shared_buffers), pool 20, k6 with 50 VUs for 20 s, k6 and server on the same machine (so numbers are conservative). Script: `load/hold.js`, runner: `load/run.sh`.

| Strategy | Contention | RPS | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|
| atomic-update | low (100k seats) | 2359 | 20.3 | 28.8 | 37.7 |
| atomic-update | hot (20 seats) | 2780 | 17.1 | 24.8 | 30.7 |
| for-update | low (100k seats) | 1924 | 25.0 | 35.7 | 46.3 |
| for-update | hot (20 seats) | 2834 | 16.8 | 23.7 | 30.7 |

## Reading
- Hot seats are *faster* per request: losers get an immediate 409 and no write happens. Throughput of **successful** holds is what drops, so measure both.
- The strategy gap shows at low contention (extra round trip), and vanishes at high contention.
- Bottleneck: pool/CPU shared between k6, Node and Postgres on one laptop. Treat ~2 300 RPS as a per-instance planning number, not a production claim.
