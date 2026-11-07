# Numbers to know

Order-of-magnitude figures for estimation. Two kinds of number appear here and they are kept apart: folk knowledge (what engineers commonly quote, hardware dependent) and numbers measured in this lab (one MacBook Air M1, load generator on the same machine, so conservative and not production claims).

## (a) Latency

`LATENCY_NS` in `packages/capacity/src/index.ts` holds the constants used by the package.

| Operation | Nanoseconds | Human scale |
|---|---|---|
| L1 cache reference | 1 | 1 ns |
| Main memory reference | 100 | 100 ns |
| SSD random read | 100 000 | 100 us |
| Round trip within a data centre | 500 000 | 0.5 ms |
| Disk seek (spinning) | 10 000 000 | 10 ms |
| Cross-region round trip | 150 000 000 | 150 ms |

Orders of magnitude to remember (folk knowledge, approximate):
- Memory is about 1 000x faster than SSD, SSD about 5x faster than a same-DC network round trip, and a cross-region trip costs 300x a same-DC one.
- Sequential read of 1 MB: ~0.25 ms from memory, ~1 ms from SSD, ~20 ms from spinning disk.
- Compress 1 KB: ~2-10 us. TLS handshake: 1-2 round trips on top of TCP.
- A Redis call on localhost or in the same DC is dominated by the network round trip (about 0.5 ms), not by Redis itself.
- A simple indexed Postgres query: ~1 ms in the DB; with network and pool wait 2-5 ms.

## (b) Throughput ballparks

### Folk knowledge (ballpark, hardware dependent)

| Component | Ballpark | Notes |
|---|---|---|
| Postgres primary, simple indexed reads | 10k-50k+ QPS per node | Depends on cache hit rate and cores |
| Postgres primary, simple writes (commit each) | A few thousand TPS on SSD | fsync per commit is the limit; batching helps |
| Redis single node | ~100k ops/s | Commands execute on one thread (I/O threads are optional); pipelining goes higher |
| Kafka partition | ~10 MB/s per partition is a safe planning number | Brokers do much more in aggregate |
| Node/Fastify instance, trivial handler | Several thousand to 20k+ RPS per core | Any real I/O or DB call lowers it by an order of magnitude |
| Nginx / load balancer | 10k-50k+ RPS per core | TLS termination costs extra |
| Elasticsearch node | hundreds to low thousands of queries/s | Query complexity dominates |
| SQS / managed queue | Very high for standard queues; check the vendor's quotas | Per-message ack and delay built in |

### Measured in this lab (laptop)

All from the linked `RESULTS.md`. Setup: MacBook Air M1, Node 26, NestJS 12 / Fastify 5 (the gateway is plain Fastify 5), Postgres 17 and Redis 7 in Docker, k6 on the same machine. These load runs predate the metrics and logging of `@boxoffice/platform` and the move of compose and CI to PostgreSQL 18; only the inventory hold runs were repeated on the final code (see below).

| Component and scenario | Result | Source |
|---|---|---|
| Inventory hold, atomic UPDATE, 100k seats, pool 20 | 2 654 RPS, p99 31.7 ms (first version, single laptop run, PostgreSQL 17); 2 294 RPS, p99 38.4 ms on the final code (PostgreSQL 18, instrumented, ordered locks) | [inventory](../services/inventory/RESULTS.md) |
| Inventory hold, 20 hot seats | 3 222 RPS (first version, single laptop run, PostgreSQL 17; losers get an immediate 409) | [inventory](../services/inventory/RESULTS.md) |
| Waiting room status/join, Redis 7 | 10 134 RPS, p99 22.3 ms | [waiting-room](../services/waiting-room/RESULTS.md) |
| Gateway hop (IP limiter + proxy) | 2 485 direct -> 2 001 through gateway (single run each, within laptop run-to-run spread, not a stable cost) | [gateway](../services/gateway/RESULTS.md) |
| Catalog search, ranked FTS, no cache | 536 RPS, p99 155.6 ms | [catalog](../services/catalog/RESULTS.md) |
| Catalog search, FTS date order | 3 199 RPS, p99 75.4 ms | [catalog](../services/catalog/RESULTS.md) |
| Catalog search, ranked FTS + Redis cache | 10 275 RPS, p99 9.0 ms | [catalog](../services/catalog/RESULTS.md) |
| Catalog rare term, ILIKE vs GIN | 16 RPS vs 6 230 RPS | [catalog](../services/catalog/RESULTS.md) |
| Payments saga, PSP 100 ms | 561 RPS (3 commits per payment) | [payments](../services/payments/RESULTS.md) |
| Payments saga, PSP 0 ms | 904 RPS, Postgres was the limit when last profiled (before the upgrade) | [payments](../services/payments/RESULTS.md) |
| Notification consumer, 1 / 3 partitions | 447 / 1 393 deliveries/s | [notifications](../services/notifications/RESULTS.md) |
| Redis memory per queued user | 7.68 MB for 57 497 queued users: at most 140 B each (includes admitted keys and baseline); planning figure 100 to 150 B | [waiting-room](../services/waiting-room/RESULTS.md) |

Only the inventory hold runs were repeated on the final code (PostgreSQL 18, instrumentation, ordered locks), on 2026-11-07. The catalog, inventory, waiting-room, gateway and payments runs of 2026-11-06 followed the upgrade from NestJS 10 / Fastify 4 to NestJS 12 / Fastify 5 but not the platform instrumentation, and the payments and notifications figures are stale (payments predate the `REFUNDING` commit; notifications use neither framework and predate the instrumentation). Most figures here are single laptop runs; repeated-run ranges are in [benchmarks](benchmarks.md). Raw outputs are in `docs/load-output/` and `docs/drill-output/`.

k6 note: with 2 000 virtual users on the same laptop the load generator itself dominates the timings, so the gateway flash-sale run reports counts and invariants only, not percentiles. Always re-measure on target hardware.

## (c) Formulas with worked examples

Run with `pnpm --filter @boxoffice/capacity calc -- <command> ...`. Each result prints the formula with the substituted numbers. Numbers accept suffixes k, M, G, T.

| Formula | Command | Output |
|---|---|---|
| avg RPS = DAU x actions / 86 400; peak = avg x peak factor | `traffic --dau 1M --actions 10 --peak 10` | `avg = 1 000 000 x 10 / 86 400 = 115.7 RPS` and `peak = 115.7 x 10 = 1 157 RPS` (catalog) |
| instances = ceil(peak / (per-instance x util)) | `instances --peak 2500 --per-instance 2600` | `instances = ceil(2 500 / (2 600 x 0.6)) = ceil(1.6) = 2` (inventory flash sale) |
| in flight = RPS x latency (Little's law) | `concurrency --rps 400 --latency-ms 100` | `in flight = 400 x 0.1 s = 40` (payments) |
| storage = records/day x bytes x 365 x years x replication | `storage --records-per-day 2740 --bytes 600 --years 5` | `... = 9 000 900 000 B = 9.0 GB` (payments, 1M/year) |
| shards = ceil(peak writes / (per-shard x util)) | `shards --peak-writes 30000 --per-shard 10000` | `shards = ceil(30 000 / (10 000 x 0.6)) = ceil(5) = 5` |
| bandwidth = RPS x payload | `bandwidth --rps 400 --bytes 300` | `bandwidth = 400 x 300 B = 120 000 B/s = 120 KB/s = 0.96 Mbit/s` (payments events to Kafka) |
| cache size = data x hot fraction | `cache --daily-read-bytes 300M --hot 0.2` | `cache = 300 MB x 0.2 = 60.0 MB` (catalog) |

Rounding used across the docs: a measured figure is quoted exactly where it is a result, and rounded down for planning formulas. 2 654 measured holds/s is planned as 2 600, 10 134 queue RPS as 10 100, 1 393 deliveries/s as ~1 390, 447 as ~450. 1 157 RPS is the exact catalog peak (115.7 x 10) and 1 200 its rounded form in `catalog/CAPACITY.md`. 633/s is the exact required notification rate (38 000 / 60), ~630/s the rounded one. 904 payments/s is the PSP-0 ms run and 561 the PSP-100 ms run; the payments plan uses 561.

Formulas without a command (do by hand): drain time = queue size / admission rate (50 000 / 500 = 100 s); admission rate = protected capacity x headroom / attempts per admitted user; required consumer rate = deliveries / target seconds (38 000 / 60 = 633/s).

## (d) Shortcuts

Powers of two:

| Power | Exact | Shortcut |
|---|---|---|
| 2^10 | 1 024 | 1 thousand (KB) |
| 2^16 | 65 536 | 64 K (ports, uint16) |
| 2^20 | 1 048 576 | 1 million (MB) |
| 2^30 | 1.07 billion | 1 billion (GB) |
| 2^32 | 4.29 billion | 4 billion (IPv4, uint32) |
| 2^40 | 1.1 trillion | 1 trillion (TB) |

Time:

| Period | Seconds | Shortcut |
|---|---|---|
| 1 day | 86 400 | ~100 000 (use 1e5, say so) |
| 1 month | 2.6 million | ~2.5 million |
| 1 year | 31.5 million | ~30 million |
| 1M requests/day | | ~12 RPS average |
| 100M requests/day | | ~1 200 RPS average |
| 1 RPS | | 86 400 requests/day, ~2.6M/month |

Availability: 99% = 3.65 days/year, 99.9% = 8.8 h/year, 99.99% = 52 min/year.

Sizes (decimal, as interviewers expect): char 1 B, int64 8 B, UUID 16 B (36 as text), typical row 100 B-1 KB, JSON API response 1-10 KB, image 200 KB, 1 min video 10-50 MB.

## (e) Rules of thumb

- **Headroom 0.6.** Plan to run instances at 60% of measured capacity: room for GC, deploys and a failed node. Used in every `CAPACITY.md`.
- **Peak factors.** Normal consumer traffic 3x average; evening or announcement spike 10x; flash sale 50-100x or more (inventory: peak factor ~100, payments over 10 000).
- **Replication 3.** Multiply stored bytes by 3 for a replicated store (the `storage` command does this by default).
- **Little's law.** Concurrent requests = RPS x latency in seconds. Use it to size pools and thread counts, and to see that a slow dependency multiplies in-flight work.
- **Never hold a DB connection while waiting for an external call.** Open the transaction only for the state change; a pool of 20 then serves 40+ in-flight payments.
- **Pareto cache.** The hot 20% of keys serves about 80% of reads; size the cache for 20% of the data set, add TTL with jitter (catalog: 30 s +-20%).
- **Connection pool sizing [folk].** Start with a pool near cores x 2 plus the number of disks on the DB side, and check against Little's law; a bigger pool does not raise throughput once the database is saturated (payments: pool 20, Postgres CPU-bound). Put a pooler in front when many instances share one primary.
- **Single node first.** One Postgres primary handles several thousand simple TPS; shard or add a search cluster only when a stated number exceeds that.
- **Partitions bound consumer parallelism.** 3 partitions means at most 3 busy consumers; choose the count from the peak parallelism you will ever need, since raising it later reorders keys.
- **Retries need idempotency.** At-least-once delivery plus an idempotency key gives effectively-once results.
- **Measure, then quote.** Say the setup with the number (hardware, data size, contention) and treat it as a per-instance planning figure.
