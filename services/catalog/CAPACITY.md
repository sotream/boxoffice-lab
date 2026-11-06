# catalog: capacity

## Traffic
- 1M DAU x 10 searches/day = 10M/day -> avg **116 RPS** (10M / 86 400). Peak factor 10 (evening, on-sale announcements) -> **~1 200 RPS**.
- Read/write ratio ~100:1: events change rarely, which is why caching is cheap to get right.

## Instances (using measured numbers, 200k events)
| Setup | RPS per instance | Instances for 1 200 RPS at 0.6 headroom |
|---|---|---|
| FTS ranked, no cache | 684 | ceil(1200 / 410) = **3**, and the DB is the bottleneck |
| FTS ordered by date, no cache | 4 387 | 1 |
| FTS ranked + Redis cache | 15 236 | 1 (the DB sees only misses) |

The decision is driven by DB load, not Node: without a cache every request is a ranked query (~64 ms median of database work).

## Cache sizing
- Query popularity is Zipf-like: caching the hot ~20% of distinct queries serves ~80% of traffic (Pareto). A result list of 20 events is ~3 KB.
- Distinct queries ~ 16 genres x 17 city options x a few thousand free-text variants ~ 100k keys x 3 KB = **~300 MB**. Hot 20% = ~60 MB. One small Redis.
- TTL 30 s +-20%: bounds staleness and, with jitter, avoids synchronised expiry.

## Storage
- 200k events: table + index sizes in RESULTS.md. 5 years x 20k new events/year stays under 1M rows: **a single Postgres node is enough**, no sharding, no search cluster.
