# Worked scenario: URL shortener (read-heavy, 100:1)

[paper design] No code in this repo implements this system: every figure below is derived from stated assumptions with the formulas in [`packages/capacity`](../../../packages/capacity/src/index.ts), or borrowed from a measured component and cited. Nothing here was run.

Load shape: read-heavy, 100 reads per write, a Zipf-like hot set, a trivial read path. Matching shape in the playbook: [workload-to-architecture.md](../workload-to-architecture.md) (read-heavy / cacheable). Other pages used: [numbers-to-know.md](../../numbers-to-know.md), [data-store-selection.md](../data-store-selection.md), [scaling-ladder.md](../scaling-ladder.md).

Labels: [measured] lab figure with its source file, [derived] arithmetic shown, [folk] common ballpark not measured here, [paper design] a design with no code here.

## Requirements

Functional
- Create a short link for a long URL (optionally a custom alias and an expiry).
- `GET /{key}` redirects to the long URL.
- Optional: click counts (decided below, because it changes the redirect status code).

Non-functional (assumptions, stated so they can be replaced)
- 100M redirects per day, 1M new links per day (ratio 100:1).
- Peak factor 10 for redirects (a link going viral), 10 for creates.
- Redirect p99 under 20 ms server-side; availability 99.9% (8.8 h per year of downtime, [folk] table in numbers-to-know).
- Links live 5 years. Average stored record 300 B including index overhead (key 7 B, URL ~100 B, timestamps, owner, indexes).
- A redirect may be stale for up to 60 s after an edit or delete (cache TTL), a create must be visible at once.

## Estimates

All commands are from [numbers-to-know.md](../../numbers-to-know.md) section (c): `pnpm --filter @boxoffice/capacity calc -- <command>`.

| Quantity | Formula and arithmetic | Result |
|---|---|---|
| Redirect RPS | `traffic --dau 100M --actions 1 --peak 10`: 100 000 000 x 1 / 86 400 = 1 157 avg; x 10 | 1 157 avg, 11 574 peak [derived] |
| Create RPS | `traffic --dau 1M --actions 1 --peak 10`: 1 000 000 / 86 400 = 11.6 avg; x 10 | 11.6 avg, 115.7 peak [derived] |
| App instances | `instances --peak 11574 --per-instance 10134`: ceil(11 574 / (10 134 x 0.6)) = ceil(1.9) | 2 [derived], using the waiting-room per-instance figure of 10 134 RPS as a proxy for "one Redis call per request" ([measured] [waiting-room RESULTS.md](../../../services/waiting-room/RESULTS.md)); real handler must be re-measured |
| In flight at peak | `concurrency --rps 11574 --latency-ms 5`: 11 574 x 0.005 s | 57.9 requests [derived]; 5 ms is the assumed server-side time |
| Response bandwidth | `bandwidth --rps 11574 --bytes 300`: 11 574 x 300 B | 3.5 MB/s = 27.8 Mbit/s [derived] (a 302 has no body, about 300 B with headers) |
| Link storage, 1 replica | `storage --records-per-day 1M --bytes 300 --years 5 --replication 1` | 548 GB [derived] |
| Link storage, 3 replicas | same with the default replication 3 | 1.6 TB [derived] |
| Key space | 62^7 = 3.5e12 keys; links over 5 years = 1M x 365 x 5 = 1.8e9 | the space is 1 900x larger than the data [derived] |
| Cache size | `cache --daily-read-bytes 30G`: 100M reads x 300 B = 30 GB/day, x 0.2 | 6.0 GB [derived]; an upper bound, because it counts every read as a distinct record |
| DB reads after cache | peak 11 574 x (1 - hit rate 0.8) | 2 315 QPS [derived], hit rate 0.8 from the Pareto rule [folk] |
| Required hit rate for a DB budget | DB budget 6 000 QPS (10 000 QPS [folk] x 0.6): miss <= 6 000 / 11 574 = 0.52, so hit >= 0.48 at x1 | the cache is optional at x1 and mandatory at x10 (see below) [derived] |

Redis single node is about 100k ops/s [folk] ([numbers-to-know.md](../../numbers-to-know.md) section b). Postgres primary indexed reads 10k-50k+ QPS per node [folk]. Measured effect of a cache in this lab: a ranked query went from 536 to 10 275 RPS, p99 155.6 ms to 9.0 ms ([measured], [catalog RESULTS.md](../../../services/catalog/RESULTS.md)); a key lookup is cheaper than that query, so the ratio is not transferable, only the direction.

## Design

Components: stateless redirect service (N instances behind a load balancer), Redis cache, one Postgres primary with a read replica, a create path in the same service (11.6 writes/s average does not justify a separate deployable).

Data model: `links(key text primary key, url text, owner_id, created_at, expires_at, disabled bool)`. The primary key is the lookup index; there is no secondary index on `url` unless "same URL returns same key" is required (decision below).

Read path: `GET /{key}` -> Redis `GET` -> on miss, Postgres by primary key, then `SET` with a TTL of 60 s +-20% jitter and single-flight on the miss. This is the cache-aside pattern with the same three details as the catalog ADR 002 in [adr/001-postgres-fts-before-elasticsearch.md](../../../services/catalog/adr/001-postgres-fts-before-elasticsearch.md) (cache-aside, single-flight, TTL jitter). Negative results (unknown key) are cached for a shorter TTL so a scanner cannot turn misses into DB load.

Key decisions

1. ID generation.
   - Chosen: a database sequence handed out in blocks of 1 000 per app instance, then a reversible scramble (multiply by a constant coprime to 62^7, modulo 62^7) and base62 encoding. Arithmetic: 11.6 creates/s average means one sequence call per 1 000 / 11.6 = 86 s for the whole fleet [derived]; keys are unique by construction, not guessable in order, 7 characters.
   - Rejected: hash of the URL truncated to 7 characters. Collision probability per insert near the end of the 5 years is links / key space = 1.8e9 / 3.5e12 = 5.2e-4 [derived], so every create needs a check-and-retry loop and the same URL from two users collides by design. Also rejected: random keys with retry (same 5.2e-4 retry rate, no gain over the sequence), and a distributed ID service such as Snowflake style (64-bit IDs encode to 11 characters; too long for the product).
2. Redirect status code, 301 vs 302.
   - 301 is cacheable by the browser: repeat visits by the same client never reach the service, so load drops. It also removes your ability to count clicks, change the target or expire the link, because the browser stops asking.
   - 302 (or 307) reaches the service on every click. Chosen when clicks are counted or links are editable, which is the usual product. If 30% of clicks were repeat visits from clients that obeyed a 301, peak would be 11 574 x 0.7 = 8 102 RPS (the 30% is an assumption to measure, [derived]).
   - Middle path: 301 with `Cache-Control: max-age=3600` for links flagged "permanent, no analytics".
3. Click counts. Chosen: the redirect writes nothing; it emits an event to a log or a Redis `INCR` batch, flushed periodically. Rejected: a Postgres `UPDATE clicks = clicks + 1` per redirect, which would turn 11 574 read RPS into 11 574 writes/s, concentrated on a few hot rows; the lab's closest figure is the hot-seat hold run in [inventory RESULTS.md](../../../services/inventory/RESULTS.md), but that run answers conflicting holds with an immediate 409, not with counter increments, so the cost of hot-row counters would have to be measured.
4. Store. Chosen: Postgres, because 548 GB and 116 writes/s at peak fit one node ([folk] ballparks above); a key-value store adds an operational system for no number that needs it. Revisit with [data-store-selection.md](../data-store-selection.md).
5. Cache failure. Redis down must not become 100% errors: use the fail-fast client and fail-open policy proven for reads in [gateway adr/001](../../../services/gateway/adr/001-token-bucket-redis.md) and [failure-drills.md](../../failure-drills.md) drill 1 ([measured]: 0 errors on availability through a 10 s Redis outage). Here fail-open means reading Postgres directly, which is safe only while the DB can take the full read load; at peak 11 574 QPS that is at the edge of one primary, so rate limit per client in that mode.

## What breaks at x10

x10 means 1 billion redirects per day (peak 115 741 RPS) and 10M creates per day.

1. First bottleneck: Redis operations per second.
   - `traffic --dau 1000M --actions 1 --peak 10` gives 11 574 avg and 115 741 peak RPS [derived]. One Redis node at about 100 000 ops/s [folk] is exceeded at peak; with headroom 0.6 it is exceeded at 60 000 / 11 574 = x5.2 [derived].
   - Change: `shards --peak-writes 115741 --per-shard 100k` gives ceil(115 741 / (100 000 x 0.6)) = 2 shards [derived] (the command is named for writes; the formula is the same for reads). Cheaper first step: an in-process LRU of the hottest few thousand keys in each app instance, which removes Redis calls for the head of the Zipf curve.
2. Second bottleneck: database reads on misses, then storage.
   - At 20% miss, DB load is 115 741 x 0.2 = 23 148 QPS [derived], above a conservative 6 000 QPS budget. The hit rate must reach 1 - 6 000 / 115 741 = 0.948 [derived]. Change: bigger cache plus the in-process layer to reach 95%, then a read replica; both are cheaper than sharding.
   - Storage `storage --records-per-day 10M --bytes 300 --years 5 --replication 1` = 5.5 TB [derived]. A single node holding 5.5 TB is past comfortable operation ([folk]); change: range- or hash-partition `links` by key, or move cold links (not read in 12 months) to cheaper storage.
3. Not a bottleneck at x10: app instances (20, `instances --peak 115741 --per-instance 10134` = ceil(19.03) [derived]) and create writes (1 157 per second peak [derived], inside one primary).

## What would be measured first

A k6 script `load/redirect.js` against a stub service, copied from two existing pieces: the Zipf key selection and cached vs uncached comparison of [services/catalog/load/search.js and run.sh](../../../services/catalog/load/search.js), and the direct vs through-a-hop comparison of [services/gateway/load/overhead.js](../../../services/gateway/load/overhead.js) (for the redirect handler vs proxy cost). Three runs, same data:
1. 10M seeded links, Zipf over keys, cache off: the Postgres primary-key lookup ceiling at pool 20 (compare against the 2 654 RPS hold figure in [inventory RESULTS.md](../../../services/inventory/RESULTS.md) as the order of magnitude for one indexed statement).
2. Same, cache on: RPS, p99 and the real hit rate at the Zipf exponent chosen (decides whether 0.8 holds).
3. Redis killed for 10 s under load (copy [drills/redis-down.mjs](../../../drills/redis-down.mjs)): does fail-open to Postgres hold.
Pass criterion written before running: p99 under 20 ms at 11 574 RPS aggregate, hit rate at least 0.8.

## Where this is proven in the repo / what is still paper

Proven (measured, different component): cache beats the better index for hot reads ([catalog RESULTS.md](../../../services/catalog/RESULTS.md)); Redis-backed handler at 10 134 RPS per instance ([waiting-room RESULTS.md](../../../services/waiting-room/RESULTS.md)); fail-open read path ([failure-drills.md](../../failure-drills.md)).

Still paper: the whole redirect service, ID scheme, 301/302 split, hit rate at 0.8, the 30% repeat-visit share, the sharded Redis, every x10 figure.
