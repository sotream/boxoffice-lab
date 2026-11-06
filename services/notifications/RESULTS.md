# notifications: measured results

Setup: MacBook Air M1, Redpanda (3 partitions) and Postgres in Docker. `load/bench.js` produces 21 010 events: 20 000 unique, 1 000 duplicate deliveries, 10 poison messages (invalid JSON). 10% of events are `payment.failed` (push only). Fake provider with 20 ms latency; every 201st event's email fails twice before succeeding.

| Partitions consumed at once | Time | Deliveries/s |
|---|---|---|
| 1 | 85.1 s | 447 |
| 3 | 27.3 s | 1 393 |

## Integrity (identical in both runs)
- Deliveries sent: 38 000 of 38 000 expected. Duplicate `(event, channel)` rows: 0.
- Provider calls: 38 180 = 38 000 + 90 flaky events x 2 retries. Duplicate deliveries cost no extra provider calls.
- Dead letters: 10 = exactly the poison messages.

## Reading
Throughput scales with consumed partitions (x3.1 for 3), which is the sizing rule in CAPACITY.md. Bottleneck at this scale is the provider latency x concurrency plus 3 DB statements per delivery; Postgres was not saturated.
