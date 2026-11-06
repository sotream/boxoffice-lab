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
