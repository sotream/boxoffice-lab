# inventory: measured results

*Measurement status: these figures were measured on PostgreSQL 17, before `@boxoffice/platform` (metrics, JSON logging, trace context, graceful shutdown) existed and before `confirm` became all-or-nothing in a transaction (the load runs exercise holds, not confirm). They were repeated on the final code (PostgreSQL 18, instrumentation, ordered locks) for the hold runs only: see the section below. The other services' figures have not been repeated. Overhead of the instrumentation alone: [operations.md](../../docs/operations.md#overhead).*

Setup: MacBook Air M1, Node 26, NestJS 12 / Fastify 5, Postgres 17 in Docker (256 MB shared_buffers), pool 20, k6 with 50 VUs for 20 s, k6 and server on the same machine (so numbers are conservative). Script: `load/hold.js`, runner: `load/run.sh`.

| Strategy | Contention | RPS | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|
| atomic-update | low (100k seats) | 2654 | 18.0 | 26.1 | 31.7 |
| atomic-update | hot (20 seats) | 3222 | 14.7 | 21.3 | 27.9 |
| for-update | low (100k seats) | 2182 | 22.3 | 30.9 | 38.4 |
| for-update | hot (20 seats) | 3218 | 14.8 | 20.7 | 25.7 |

Hold outcomes in the same runs (ok / 409 conflict): atomic-update low 41 144 / 11 972, hot 20 / 64 456; for-update low 35 496 / 8 180, hot 20 / 64 410. At hot contention exactly the 20 seats are held in every run.

## Re-measured on the final code (2026-11-07)

Same machine, script and settings, but now on PostgreSQL 18.6, with the instrumentation of `@boxoffice/platform` (metrics, JSON logs, trace context), with the ordered-lock statements of ADR 001 (`WITH locked AS MATERIALIZED (... ORDER BY seat_id FOR UPDATE) UPDATE ...`) and with all-or-nothing `confirm`. One run per row, k6 and server on the same laptop, so differences of a few percent are noise.

| Strategy | Contention | RPS | p50 ms | p95 ms | p99 ms | RPS before |
|---|---|---|---|---|---|---|
| atomic-update | low (100k seats) | 2294 | 21.0 | 28.9 | 38.4 | 2654 |
| atomic-update | hot (20 seats) | 2695 | 17.7 | 25.6 | 32.0 | 3222 |
| for-update | low (100k seats) | 2168 | 22.2 | 31.1 | 40.5 | 2182 |
| for-update | hot (20 seats) | 3193 | 14.8 | 21.4 | 26.5 | 3218 |

Outcomes (ok / 409): atomic low 36 702 / 9 208, hot 20 / 53 920; for-update low 35 175 / 8 241, hot 20 / 63 879. At hot contention exactly the 20 seats are held in every run.

What changed (single laptop runs, **see the caveat below**): `atomic-update` measured 2 294 RPS against 2 654 before (p99 38.4 against 31.7 ms at low contention), `for-update` 2 168 against 2 182. A difference of this size is inside the measured run-to-run spread of the laptop (up to 2.2x, see [benchmarks](../../docs/benchmarks.md)), so no cost of the instrumentation, of PostgreSQL 18 or of the ordered locking is established, and no gap between the strategies is established either. The ordered statement (the single `UPDATE` takes row locks in a separate sorted step) is kept for deadlock safety, because it cannot deadlock with `confirm` (ADR 001, `lockorder.test.ts`). The first table is kept above because it is the evidence the original derivation used.

## Second environment (GitHub-hosted runner)

Final code, Postgres 18 defaults, 4 vCPU, 5 runs, median (min-max): atomic low 1 711 (1 666-1 737), atomic hot 1 960 (1 925-1 968), for-update low 1 812 (1 789-1 821), for-update hot 2 476 (2 424-2 487). for-update is equal or faster, so the strategy gap above is not reproduced; the figures in this file are single laptop runs. Details: [benchmarks](../../docs/benchmarks.md).

## Reading
- Hot seats are *faster* per request: losers get an immediate 409 and no write happens. Throughput of **successful** holds is what drops, so measure both.
- In the first single run `for-update` was slower at low contention (extra round trip); this did not reproduce on the final code or on the runner. At high contention the strategies are indistinguishable.
- Bottleneck: pool/CPU shared between k6, Node and Postgres on one laptop. Treat ~2 600 RPS as a per-instance planning number, not a production claim.
