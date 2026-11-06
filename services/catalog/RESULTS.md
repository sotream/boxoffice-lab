# catalog: measured results

Setup: MacBook Air M1, Node 22 + Fastify, Postgres 17 in Docker, Redis 7, 200 000 synthetic events, pool 20, k6 50 VUs for 15 s. "Common terms" follow a Zipf distribution over 16 genres and 16 cities (a city filter on every query); "rare term" is one event number. Script `load/search.js`, runner `load/run.sh`.

| Scenario | RPS | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|
| common: ILIKE, date order | 2 398 | 18.9 | 36.3 | 64.2 |
| common: FTS (GIN), date order | 4 387 | 9.4 | 21.8 | 52.7 |
| common: FTS ranked by ts_rank | 684 | 64.1 | 116.2 | 292.4 |
| common: FTS ranked + Redis cache | 15 236 | 2.7 | 5.5 | 8.1 |
| rare term: ILIKE | 25 | 1 819.7 | 2 466.8 | 2 600.4 |
| rare term: FTS (GIN), date order | 2 177 | 21.0 | 36.3 | 47.1 |

Size at 200 000 events: table 63 MB, indexes 24 MB (GIN + city/date b-tree).

## Reading
1. **Cache beats the better index** for hot queries: 22x the ranked query, p99 8 ms.
2. **GIN wins by 87x on selective terms**; for common terms with a city filter and date order the gap is only 1.8x, because ILIKE can stop early via the `(city, starts_at)` index.
3. **Ranking is the expensive part for common terms** (6.4x slower than date order): O(matches), not O(1).

## Mistakes the benchmark caught in itself (kept as method notes)
- First run compared ILIKE with date order against FTS with ranking and "proved" ILIKE was 7x faster. Different `ORDER BY` made it unfair; fixed by adding the `fts-date` strategy.
- Synthetic data had each genre in exactly one city (both generators coprime with 16); made independent.
- The rare-term run initially reported ILIKE at 8 400 RPS because an empty `city=` was read as the city named "" and matched nothing; fixed, real figure is 25 RPS.
