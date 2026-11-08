# Changelog

## 1.0.0

First fixed state of the playbook: six services, capacity formulas, ADRs, and measured numbers on three environments (M1 Air, M4 Pro, GitHub-hosted runner).

### Security and correctness
- Internal routes of payments and inventory authenticate with signed requests (HMAC-SHA256 over timestamp, method, path, body hash), not a static token (ADR 002, payments ADR 006).
- Payments asks inventory who holds the seats before charging (ADR 007, `VERIFY_HOLDS`); the sweeper threshold margin is enforced at startup.
- Shared Postgres pool: client-side query timeout, hung connections are discarded.
- Waiting room: Redis command timeout, request path answers 503 with `Retry-After`; the admission tick has none on purpose.

### Tests
- Fault suite F1 to F14 (`pnpm test:e2e:faults`), including network faults through a TCP proxy and silent partitions; runs nightly.
- 82 mutations in `scripts/mutation-check.mjs`, validated in CI.
- `pnpm docs:links` checks relative links and anchors in CI.

### Benchmarks
- `scripts/bench.sh` scenarios: inventory, waiting-room, payments, payments-verify, catalog, gateway, notifications; `scripts/ab-signing.sh`; `PAYMENTS_BENCH_POOL`.
- Measured: the ownership check costs 11.5% of payments throughput at a 0 ms PSP; request signing is inside the noise on the M4 Pro; a payments pool of 20 limits the 100 ms PSP case, and the 100 ms inversion disappears at pool 40 and 100.

### Known open items
Listed in the README Limits and in [docs/benchmarks.md](docs/benchmarks.md): one unexplained `overload.e2e` failure on the M4 Pro (1 in 11 runs), the larger check cost at a 0 ms PSP with bigger pools, no tests for silent partitions of payments to Postgres, Redpanda and notifications, no TCP keepalive.
