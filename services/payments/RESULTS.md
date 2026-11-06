# payments: measured results

Setup: MacBook Air M1, Postgres 17 and Redpanda in Docker, pool 20, k6 100 VUs, 20 s. Every 5th payment is retried with the same key. Seats are not held, so every payment takes the **compensation path** (charge, failed confirm, refund): the longest saga path.

| PSP latency | RPS (incl. retries) | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|
| 100 ms (compensation path calls the PSP twice) | 528 | 217 | 253 | 308 |
| 0 ms | 697 | 153 | 201 | 274 |

## Integrity checks after the run (PSP 100 ms)
- payments rows 8 874, outbox rows 8 874, published 8 874, Kafka topic high watermark 8 874.
- Duplicate idempotency keys: 0 (client retries returned the stored result).

## Bottleneck (measured, not guessed)
At PSP 0 ms: Postgres container ~243% CPU with LWLock waits, payments Node ~84% CPU. The database is the limit: **3 commits per payment** (insert, PENDING->CHARGED with outbox, final state) plus inventory's confirm. Next optimisation if needed: collapse transitions that need no durability between them, or use `synchronous_commit=off` for the intermediate step (accepting that a crash re-runs it, which `resume` already handles).

Known quirk: kafkajs prints `TimeoutNegativeWarning` on Node 26; it does not affect delivery (counts above match).

## Slow provider (drill 4, `drills/slow-psp.mjs`)
300 payments with a held seat each, 100 clients, PSP latency raised at runtime, client abort at 15 s. Same script before and after the timeout work.

| PSP latency | Version | Client sees | Final state after PSP recovers | DB connections | Duplicate charges |
|---|---|---|---|---|---|
| 3 s | before | 300 x 200 CONFIRMED, p50 3.07 s | immediate | 1 | 0 |
| 20 s | before | **300 of 300 client timeouts at 15 s, no answer** | all CONFIRMED 5.6 s later | 1 | 0 |
| 20 s | after (2 s step timeout) | 300 x 202 in-progress, p50 2.09 s | all CONFIRMED 3.2 s later (sweeper, 10 parallel) | 0-1 | 0 |
| 3 s | after (2 s step timeout) | 300 x 202 in-progress, p50 2.07 s | all CONFIRMED 9.2 s later (sequential sweeper, first version) | 0-1 | 0 |

Reading: a DB connection is never held while waiting for the PSP (1 active at 300 in flight), so the pool is not the failure mode; the missing bounded answer is. The step timeout converts a hanging request into a definite "accepted" answer. Trade-off: with a PSP slower than the timeout (3 s vs 2 s) every payment takes the asynchronous path; set the timeout above the provider's p99. The first sweeper handled 50 payments per second sequentially (8.7 s for 300); handling 10 in parallel cut it to 3.2 s.
