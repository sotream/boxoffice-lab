# catalog: measured results

*Measurement status: these figures were measured on PostgreSQL 17, before `@boxoffice/platform` (metrics, JSON logging, trace context, graceful shutdown) existed, and the load runs have not been repeated on PostgreSQL 18 or with the instrumentation. Overhead of the instrumentation alone: [operations.md](../../docs/operations.md#overhead).*

Setup: MacBook Air M1, Node 26, NestJS 12 / Fastify 5, Postgres 17 in Docker, Redis 7, 200 000 synthetic events, pool 20, k6 50 VUs for 15 s. "Common terms" follow a Zipf distribution over 16 genres and 16 cities (a city filter on every query); "rare term" is one event number. Script `load/search.js`, runner `load/run.sh`.

| Scenario | RPS | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|
| common: ILIKE, date order | 2 839 | 16.0 | 28.3 | 41.6 |
| common: FTS (GIN), date order | 3 199 | 13.1 | 26.5 | 75.4 |
| common: FTS ranked by ts_rank | 536 | 90.7 | 125.9 | 155.6 |
| common: FTS ranked + Redis cache | 10 275 | 4.4 | 6.8 | 9.0 |
| rare term: ILIKE | 16 | 2 834.2 | 3 949.1 | 4 105.2 |
| rare term: FTS (GIN), date order | 6 230 | 7.7 | 11.2 | 14.6 |

Size at 200 000 events: table 63 MB, indexes 24 MB (GIN + city/date b-tree).

## Reading
1. **Cache beats the better index** for hot queries: 19x the ranked query (10 275 vs 536 RPS), p99 9 ms.
2. **GIN wins by about 390x on selective terms** (6 230 vs 16 RPS); for common terms with a city filter and date order the gap is only 1.1x (3 199 vs 2 839 RPS), because ILIKE can stop early via the `(city, starts_at)` index. FTS in date order is now only slightly faster than ILIKE on common terms, and its p99 is higher (75.4 ms vs 41.6 ms), so for common terms the GIN index buys little throughput and no tail-latency win in this run.
3. **Ranking is the expensive part for common terms** (6.0x slower than date order: 536 vs 3 199 RPS): O(matches), not O(1).

## Mistakes the benchmark caught in itself (kept as method notes)
- First run compared ILIKE with date order against FTS with ranking and "proved" ILIKE was 7x faster. Different `ORDER BY` made it unfair; fixed by adding the `fts-date` strategy.
- Synthetic data had each genre in exactly one city (both generators coprime with 16); made independent.
- The rare-term run initially reported ILIKE at 8 400 RPS because an empty `city=` was read as the city named "" and matched nothing; fixed, real figure is 16 RPS (25 RPS before the NestJS 12 / Fastify 5 upgrade).
