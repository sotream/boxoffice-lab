# notifications: capacity

*The measured figures quoted here come from the RESULTS.md of this service, taken before the metrics/logging of `@boxoffice/platform` existed and (where Postgres is involved) on PostgreSQL 17; they have not been re-measured. See the measurement status at the top of [RESULTS.md](RESULTS.md).*

## Load
- One flash sale: 20 000 confirmed payments -> 90% x 2 channels + 10% x 1 = **38 000 deliveries**. Delivery is asynchronous, so what matters is *time to drain*, not RPS.
- Target: everyone notified within ~60 s of the sale. Required rate = 38 000 / 60 = **~630 deliveries/s**.

## Consumer sizing
- Per consumer, handling one partition at a time with concurrency 25 and a 20 ms provider: measured **~450 deliveries/s**. Not enough alone (needs 630).
- Handling 3 partitions at once: measured **~1 390 deliveries/s**, drain time 27 s for the whole sale.
- Formula: deliveries/s ~ concurrency x partitions in parallel / (sender latency + DB claim time). Every term can be traded: raise concurrency, add partitions and consumers (up to #partitions), or cut the provider latency.
- Partitions bound the parallelism of a consumer group: 3 partitions = at most 3 busy consumers. Pick the partition count from the **peak consumer parallelism you will ever need**, since increasing it later reorders keys.

## Storage
- `deliveries`: ~60 B per row, 38 000 rows per big sale. 1M tickets/year x 1.9 channels x 60 B x 5 years = ~570 MB. Purge rows older than the provider's idempotency window (e.g. 7 days).
- Kafka: 300 B x 21k events = 6 MB per sale; retention 7 days is trivial.

## Provider limits
- Email providers throttle (often 10-100 msg/s per account depending on plan, [folk]; check the chosen provider's quota). With a 630/s target the sender needs a token-bucket on the **outbound** side (same algorithm as the gateway ADR) or several provider accounts. A 429 from the provider is a retryable error with backoff.
