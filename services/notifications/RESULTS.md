# notifications: measured results

*Measurement status: these figures were measured before `@boxoffice/platform` (metrics, JSON logging, trace context, graceful shutdown, DLQ routing of malformed events) existed, with Postgres 17 in the Docker setup of that time, and have not been repeated on PostgreSQL 18 or with the instrumentation. Overhead of the instrumentation alone: [operations.md](../../docs/operations.md#overhead).*

Setup: MacBook Air M1, Redpanda (3 partitions) and Postgres in Docker. `load/bench.js` produces 21 010 events: 20 000 unique, 1 000 duplicate deliveries, 10 poison messages (invalid JSON). 10% of events are `payment.failed` (push only). Fake provider with 20 ms latency; every 201st event's email fails twice before succeeding.

These figures predate the final code; `scripts/bench.sh notifications` now reproduces both rows, with the integrity checks below, over repeated runs ([benchmarks.md](../../docs/benchmarks.md#method)).

| Partitions consumed at once | Time | Deliveries/s |
|---|---|---|
| 1 | 85.1 s | 447 |
| 3 | 27.3 s | 1 393 |

### Re-measured on the final code (2026-11-08, M1 Air, PostgreSQL 18, 3 runs, a noisier machine)
| Partitions consumed at once | Time | Deliveries/s |
|---|---|---|
| 1 | 81.6 s (81.5-81.6) | 466 |
| 3 | 27.4 s (27.4-27.4) | 1 388 (1 387-1 389) |

Integrity in every run: 38 000 of 38 000 sent, 0 duplicate `(event, channel)` rows, 10 dead letters, 38 180 provider calls. Within 4% of the first record. Details: [benchmarks](../../docs/benchmarks.md#final-code-on-the-m1-air-request-signing-the-ownership-check-gateway-and-notifications).

## Integrity (identical in both runs)
- Deliveries sent: 38 000 of 38 000 expected. Duplicate `(event, channel)` rows: 0.
- Provider calls: 38 180 = 38 000 + 90 flaky events x 2 retries. Duplicate deliveries cost no extra provider calls.
- Dead letters: 10 = exactly the poison messages.

## Reading
Throughput scales with consumed partitions (x3.1 for 3), which is the sizing rule in CAPACITY.md. Bottleneck at this scale is the provider latency x concurrency plus 3 DB statements per delivery; Postgres was not saturated.
