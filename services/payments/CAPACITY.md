# payments: capacity

## Traffic
- Flash sale: 20 000 seats sold in 60 s -> 20 000 / 60 = **~333 payments/s**; plan 400/s with retries.
- Ordinary day: 1M tickets/year = 0.03/s. The system is sized for the spike, not for the average (peak factor > 10 000).

## Concurrency (Little's law)
- PSP call ~100 ms (external, we cannot speed it up). In flight = 400 x 0.1 = **~40 concurrent payments**.
- Rule that falls out of this: **never hold a DB connection while waiting for the PSP.** The code opens a transaction only for the state change, so a pool of 20 serves 40+ in-flight payments.

## Database
- Measured: **561 payments/s per instance with a realistic 100 ms PSP** (compensation path, pool 20); **904/s with the PSP removed**, which shows the database, not the PSP wait, is the ceiling (3 transactions per payment; the CPU breakdown in RESULTS.md was measured before the NestJS 12 / Fastify 5 upgrade and not repeated).
- instances = ceil(400 / (561 x 0.6)) = **2** (with the 904 figure it would be 1, but that figure excludes the PSP latency we always have). The second instance also covers availability.
- Write load = 400 x 3 commits = **~1 200 TPS**. One primary is enough; scaling beyond means batching state transitions (fewer commits per payment) before sharding.

## Storage
- payment row ~200 B + outbox row ~400 B = ~600 B. 1M payments/year x 600 B x 5 years x replication 3 = **~9 GB**. Prune published outbox rows after N days.

## Kafka
- 400 events/s x ~300 B = 120 KB/s: a single partition handles ~10 MB/s. Partitioning key = `paymentId`; one partition is already 80x oversized, so use 3 only for consumer parallelism.
