# inventory: measured results

Setup: MacBook Air M1, Node 26, NestJS 12 / Fastify 5, Postgres 17 in Docker (256 MB shared_buffers), pool 20, k6 with 50 VUs for 20 s, k6 and server on the same machine (so numbers are conservative). Script: `load/hold.js`, runner: `load/run.sh`.

| Strategy | Contention | RPS | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|
| atomic-update | low (100k seats) | 2654 | 18.0 | 26.1 | 31.7 |
| atomic-update | hot (20 seats) | 3222 | 14.7 | 21.3 | 27.9 |
| for-update | low (100k seats) | 2182 | 22.3 | 30.9 | 38.4 |
| for-update | hot (20 seats) | 3218 | 14.8 | 20.7 | 25.7 |

Hold outcomes in the same runs (ok / 409 conflict): atomic-update low 41 144 / 11 972, hot 20 / 64 456; for-update low 35 496 / 8 180, hot 20 / 64 410. At hot contention exactly the 20 seats are held in every run.

## Reading
- Hot seats are *faster* per request: losers get an immediate 409 and no write happens. Throughput of **successful** holds is what drops, so measure both.
- The strategy gap shows at low contention (extra round trip), and vanishes at high contention.
- Bottleneck: pool/CPU shared between k6, Node and Postgres on one laptop. Treat ~2 600 RPS as a per-instance planning number, not a production claim.
