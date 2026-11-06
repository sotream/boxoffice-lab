# payments: measured results

Setup: MacBook Air M1, Node 26, NestJS 12 / Fastify 5, Postgres 17 and Redpanda in Docker, pool 20, k6 100 VUs, 20 s. Every 5th payment is retried with the same key. Seats are not held, so every payment takes the **compensation path** (charge, failed confirm, refund): the longest saga path.

| PSP latency | RPS (incl. retries) | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|
| 100 ms (compensation path calls the PSP twice) | 561 | 208 | 219 | 325 |
| 0 ms | 904 | 118 | 144 | 179 |

## Integrity checks after the run (PSP 100 ms)
- PSP 100 ms run: 9 407 payments rows, all REFUNDED (the compensation path), 0 duplicate idempotency keys (client retries returned the stored result). The script's outbox query failed on shell quoting in this run, so no outbox count was saved for it.
- PSP 0 ms run: 15 097 payments rows, all REFUNDED; outbox rows 15 097, published 15 097 (checked separately after the same quoting failure); 0 duplicate idempotency keys.
- Earlier run before the NestJS 12 / Fastify 5 upgrade (PSP 100 ms): payments, outbox and published rows all 8 874, Kafka topic high watermark 8 874.

## Bottleneck (measured, not guessed)
Measured before the NestJS 12 / Fastify 5 upgrade, not repeated. At PSP 0 ms: Postgres container ~243% CPU with LWLock waits, payments Node ~84% CPU. The database is the limit: **3 commits per payment** (insert, PENDING->CHARGED with outbox, final state) plus inventory's confirm. Next optimisation if needed: collapse transitions that need no durability between them, or use `synchronous_commit=off` for the intermediate step (accepting that a crash re-runs it, which `resume` already handles because the PSP is idempotent by key; not implemented or measured).

Known quirk: kafkajs prints `TimeoutNegativeWarning` on Node 26; it does not affect delivery (counts above match).

## Slow provider (drill 4, `drills/slow-psp.mjs`)
300 payments with a held seat each, 100 clients, PSP latency raised at runtime, client abort at 15 s. Same script before and after the timeout work.

| PSP latency | Version | Client sees | Final state after PSP recovers | DB connections | Duplicate charges |
|---|---|---|---|---|---|
| 3 s | before | 300 x 200 CONFIRMED, p50 3.07 s | immediate | 1 | 0 |
| 20 s | before | **300 of 300 client timeouts at 15 s, no answer** | all CONFIRMED 5.6 s later | 1 | 0 |
| 20 s | after (2 s step timeout) | 300 x 202 in-progress, p50 2.09 s | all CONFIRMED 3.2 s later in the first run, 4.5 s in the earlier saved rerun, **3.1 s in the latest run** on NestJS 12 / Fastify 5 (p50 2.1 s, 0 DB connections; sweeper, 10 parallel) | 0-1 | 0 |
| 3 s | after (2 s step timeout) | 300 x 202 in-progress, p50 2.07 s | all CONFIRMED 9.2 s later (sequential sweeper, first version) | 0-1 | 0 |

Reading: a DB connection is never held while waiting for the PSP (1 active at 300 in flight), so the pool is not the failure mode; the missing bounded answer is. The step timeout converts a hanging request into a definite "accepted" answer. Trade-off: with a PSP slower than the timeout (3 s vs 2 s) every payment takes the asynchronous path; set the timeout above the provider's p99. The first sweeper handled 50 payments per second sequentially (8.7 s for 300); handling 10 in parallel cut it to 3.1-4.5 s (three runs).
