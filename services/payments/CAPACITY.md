# payments: capacity

## Traffic
- Flash sale: 20 000 seats sold in 60 s -> 20 000 / 60 = **~333 payments/s**; plan 400/s with retries.
- Ordinary day: 1M tickets/year = 0.03/s. The system is sized for the spike, not for the average (peak factor > 10 000).

## Concurrency (Little's law)
- PSP call ~100 ms (external, we cannot speed it up). In flight = 400 x 0.1 = **~40 concurrent payments**.
- Rule that falls out of this: **never hold a DB connection while waiting for the PSP.** The code opens a transaction only for the state change, so a pool of 20 serves 40+ in-flight payments.

## Database
- Measured ceiling: **~700 payments/s per instance with a 20-connection pool, bounded by Postgres** (3 transactions per payment, see RESULTS.md).
- instances = ceil(400 / (700 x 0.6)) = **1**, run **2** for availability. The pool, not Node CPU, is the limit.
- Write load = 400 x 3 commits = **~1 200 TPS**. One primary is enough; scaling beyond means batching state transitions (fewer commits per payment) before sharding.

## Storage
- payment row ~200 B + outbox row ~400 B = ~600 B. 1M payments/year x 600 B x 5 years x replication 3 = **~9 GB**. Prune published outbox rows after N days.

## Kafka
- 400 events/s x ~300 B = 120 KB/s: a single partition handles ~10 MB/s. Partitioning key = `paymentId`; one partition is already 80x oversized, so use 3 only for consumer parallelism.
