# Scaling ladder

The order in which to escalate when a service is too slow or too small: fix the query or index, then cache, then read replica, then partitioning or sharding, then queue or async. Each rung is cheaper and less risky than the next; skip a rung only when a number says the lower rung cannot work.

Labels: **[measured]** from a RESULTS.md in this repo; **[derived]** computed with the [`packages/capacity`](../../packages/capacity/src/index.ts) formulas, arithmetic shown; **[folk]** a ballpark not measured here; **[paper design]** no code here. Measurements are from one MacBook Air M1 with the load generator on the same machine; use them as ratios and planning figures, not as production claims. Related: [workload-to-architecture](workload-to-architecture.md), [data-store-selection](data-store-selection.md), [from-100-to-1m-users](from-100-to-1m-users.md).

Before climbing, one calculation: `instancesNeeded(peak, perInstance, 0.6)` = ceil(peak / (perInstance x 0.6)). If the answer is 1 or 2, the ladder is not your problem. If the answer is large because the per-instance figure is small, find out why (rung 1) before buying instances.

## Rung 1: fix the query or the index

**Symptom that says "move up".** After the query is as cheap as it can be, one DB instance still cannot serve peak load, or the remaining cost is inherent (the same hot result recomputed again and again).

**Trigger.** Do this rung first, always. Measure per-query cost in isolation, then per-instance RPS. Catalog evidence, all [measured, [catalog RESULTS](../../services/catalog/RESULTS.md)]:
- GIN vs ILIKE on a rare term: 2 177 vs 25 RPS (87x), p50 21.0 vs 1 819.7 ms.
- ILIKE vs FTS on a common term with city filter: 2 398 vs 4 387 RPS, only 1.8x, because the `(city, starts_at)` b-tree lets ILIKE stop early.
- Ranking: FTS ordered by date 4 387 RPS vs FTS ranked 684 RPS (6.4x). Ranking cost is O(matches). Remedy inside this rung: take top-N candidates by a cheap key and rank only those, or order by a b-tree column ([catalog ADR 001](../../services/catalog/adr/001-postgres-fts-before-elasticsearch.md)).
- Inventory: one conditional UPDATE instead of `SELECT ... FOR UPDATE` then UPDATE: 2 359 vs 1 924 RPS at low contention (about 18 % fewer for the lock-then-write form) [measured, [inventory RESULTS](../../services/inventory/RESULTS.md)].
- Payments: 3 commits per payment is the limit; fewer commits per payment is the same kind of fix [measured, [payments RESULTS](../../services/payments/RESULTS.md)]; the collapse was proposed, not implemented.

**Cost.** Engineering time only. Index cost is write amplification and space: at 200 000 events the table is 63 MB and indexes 24 MB [measured]. A cheaper sort key may change product behaviour (date order instead of relevance).

**Do NOT yet.** Add a cache or an instance to hide a query that scans. The first catalog benchmark "proved" ILIKE 7x faster because it compared different ORDER BY clauses; compare like with like before concluding anything [measured, catalog RESULTS method notes].

## Rung 2: cache

**Symptom that says "move up".** The remaining DB load is the same few expensive reads repeated: high read:write ratio, Zipf-like key popularity, staleness tolerated.

**Trigger.** Peak read RPS exceeds what the DB can serve at 0.6 headroom after rung 1: `instancesNeeded(peak, perInstanceUncached) > 1` with the DB, not Node, as the bottleneck. Catalog: 1 157 / (684 x 0.6) = 2.82, so 3 [derived]; cached, one instance serves 15 236 RPS, p99 8.1 ms (22x the ranked query) [measured]. Cache size = data x hot fraction: 300 MB x 0.2 = 60 MB [derived, catalog CAPACITY.md, assuming 100k distinct keys x 3 KB]. The hit rate was not measured in this repo; the 15 236 figure is for a hot key set. What would settle it: a k6 run with a Zipf key distribution over the real key space, reporting hit ratio next to RPS (extend `services/catalog/load/search.js`).

**Cost.** Consistency: stale reads by design (search results age out in at most 36 s; event detail is invalidated on write) [[catalog ADR 002](../../services/catalog/adr/001-postgres-fts-before-elasticsearch.md), tested]. Operations: one more system, plus invalidation rules and failure modes. Per-process single-flight caps a miss wave at instances x 1 query per key. Money: a small Redis (60 MB hot set). Failure behaviour: with Redis down, a limiter that queued commands made 100 % of requests fail until the client was made fail-fast [measured, drill 1 in [failure-drills](../failure-drills.md)]; a cache needs the same fail-fast client and a fall-through to the DB.

**Do NOT yet.** Cache anything on a path with a correctness invariant (a seat hold, a payment). Do not write-through when the data changes rarely: it couples the writer to every cached query shape (ADR 002). Do not skip TTL jitter; synchronised expiry is a miss wave.

## Rung 3: read replica

**Symptom that says "move up".** Reads that cannot be cached (unique keys, per-user data, freshness stricter than a TTL) still saturate the primary, or you need to isolate reporting from the transactional workload.

**Trigger.** Uncached read QPS after rung 2 exceeds what the primary can serve alongside its writes. Folk ballpark: 10k to 50k+ simple indexed reads per second per node [folk, [numbers-to-know](../numbers-to-know.md)]. **The repo has no measurement for this rung**: nothing here runs a replica. The measurement that would settle it: Postgres streaming replica in `docker-compose.yml`, the catalog `GET /events/:id` path pointed at it, report replication lag (bytes and seconds) under the write rate of a flash-sale run, and p99 with and without the replica.

**Cost.** Consistency: replication lag means read-your-writes breaks (a user renames an event and still sees the old name); you need routing rules (reads after a write go to the primary). Operations: failover, lag monitoring. Money: roughly one more node per replica [folk].

**Do NOT yet.** Send an invariant check to a replica ("is the seat free?" followed by a write to the primary is the check-then-write race with extra lag). In this repo the catalog needs no replica: 5 years x 20k events/year stays under 1M rows, "a single Postgres node is enough" [catalog CAPACITY.md]; 1M rows is about 5x the 200 000 measured, so about 435 MB at the measured 87 MB per 200k, assuming linear growth [derived].

## Rung 4: partitioning and sharding

**Symptom that says "move up".** Write throughput, or the hot working set, exceeds one primary even after rung 1 (batching, fewer commits), or storage will not fit one node.

**Trigger.** `shardsNeeded(peakWritesPerSec, writesPerShard, 0.6)` = ceil(peak / (writesPerShard x 0.6)) greater than 1. Worked examples [derived]:
- Inventory, one event: 2 500 writes/s with one primary at "several thousand simple TPS" [folk]: no sharding. Many events at once: 10 events x 2 500 = 25 000 writes/s; with the measured 2 359 hold RPS as a conservative per-shard figure, ceil(25 000 / (2 359 x 0.6)) = 18. The 2 359 is laptop-bound with the generator on the same machine; measure per-shard capacity on target hardware first. Shard key `event_id` ([inventory CAPACITY](../../services/inventory/CAPACITY.md)).
- Payments: 400 x 3 commits = 1 200 TPS, one primary; "batch state transitions before sharding" [payments CAPACITY.md].
- The numbers-to-know example: ceil(30 000 / (10 000 x 0.6)) = 5.

Consumer-side partitioning is a different, measured case: Kafka partitions bound consumer parallelism; 1 vs 3 partitions consumed gave 447 vs 1 393 deliveries/s (x3.1) [measured, [notifications RESULTS](../../services/notifications/RESULTS.md)]. The partition count must be chosen up front from the peak parallelism needed, since raising it later reorders keys [stated, notifications CAPACITY.md]. No Postgres sharding is implemented or measured in this repo.

**Cost.** Consistency: invariants and transactions that span shards need a saga or are forbidden; shard by the entity that owns the invariant. Operations: resharding, cross-shard queries, per-shard backup and failover. Money: shards x node cost, the largest step on this ladder.

**Do NOT yet.** Shard because a table is "big": 10 MB per big event and about 50 GB over 5 years is "trivial" [inventory CAPACITY.md]. Do not pick a shard key from a field that skews (a celebrity, one event on sale) without checking hot-key load.

## Rung 5: queue or async

**Symptom that says "move up".** The caller does not need the result now, the downstream is slower or less available than the caller, or the work is bursty and a backlog is acceptable; or a producer must not fail when its consumer is down.

**Trigger.** Drain time = work / consumer rate must fit the deadline; required rate = work / deadline. Notifications: 38 000 / 60 s = 633/s required [derived]; one partition measured 447/s (too slow), three 1 393/s, 27.3 s drain [measured]. For a protected service the same idea appears as admission: admit/s = capacity x 0.6 / attempts = 2 300 x 0.6 / 3 = 460 [derived], queue absorbing 7 656 RPS per instance [measured, [waiting-room RESULTS](../../services/waiting-room/RESULTS.md)].

**Cost.** Consistency: eventual; the user sees "accepted", not "done". Operations: at-least-once means every consumer must deduplicate (DB key `(outbox_id, channel)`), retries, DLQ, lease tuning (30 s lease set the 33.6 s recovery in drill 3) [measured]. Money: a broker. Redpanda stopped under 300 payments: 300 of 300 payments OK, events caught up 1.2 s after return [measured, drill 2].

**Do NOT yet.** Put a queue in front of a step whose result the user is waiting for and whose failure must be synchronous (a payment authorisation the user needs to see). Do not use a queue to hide a consumer that cannot keep up: Little's law and the rate formula tell you the backlog grows forever if the required rate exceeds the consumer rate. Do not use Kafka as a position-lookup structure; the waiting room rejected it for exactly that ([ADR](../../services/waiting-room/adr/001-redis-sorted-set-queue.md)).

## Worked ladder: catalog

Requirement: 1M DAU, 10 searches per user per day, peak factor 10, p99 under 50 ms, staleness up to 30 s, 200 000 events now, under 1M in 5 years [catalog README and CAPACITY.md].

Peak: avg = 1 000 000 x 10 / 86 400 = 115.7 RPS; peak = 115.7 x 10 = 1 157 RPS [derived, matches the `traffic` command example in numbers-to-know]. Write rate at the stated 100:1 ratio: about 12 writes/s at peak [derived: 1 157 / 100].

| Rung | Setup | Per-instance RPS | p99 | Instances at peak 1 157 | Verdict |
|---|---|---|---|---|---|
| 0 | ILIKE, date order, common term | 2 398 [measured] | 64.2 ms | ceil(1 157 / (2 398 x 0.6)) = 1 [derived] | Fine for common terms; 25 RPS and p50 1 819.7 ms on a rare term, unacceptable alone [measured] |
| 1 | FTS (GIN), date order | 4 387 [measured] | 52.7 ms | ceil(1 157 / (4 387 x 0.6)) = 1 [derived] | Meets the RPS; p99 52.7 ms is above the 50 ms target on this laptop [measured]; loses relevance ranking |
| 1b | FTS ranked by ts_rank, no cache | 684 [measured] | 292.4 ms | ceil(1 157 / (684 x 0.6)) = 3 [derived], DB-bound | Fails the latency budget; ranking cost is O(matches) |
| 2 | FTS ranked + Redis cache | 15 236 [measured] | 8.1 ms | ceil(1 157 / (15 236 x 0.6)) = 1 [derived] | Meets RPS and latency; one instance, the DB sees only misses |
| 3 | Read replica | not measured | not measured | not needed | One node suffices: under 1M rows, about 435 MB [derived]. Measurement that would change this: hit ratio under a Zipf load, then replica lag |
| 4 | Sharding | not applicable | | | 12 writes/s: `shardsNeeded(12, 3000)` = ceil(12 / (3 000 x 0.6)) = 1 [derived; 3 000 is a folk figure for "a few thousand TPS"] |
| 5 | Async | not applicable for reads | | | Becomes relevant only if a search cluster is added and fed by CDC or dual write (eventual consistency, see [data-store-selection](data-store-selection.md)) |

Read of the ladder: the repo's catalog stops at rung 2, which is exactly where its own lesson sits: "cache beats the better index" (22x on hot queries) and "ranking cost is O(matches)" [measured]. Revisit triggers for leaving Postgres FTS are in [ADR 001](../../services/catalog/adr/001-postgres-fts-before-elasticsearch.md): typo tolerance or synonyms, a corpus beyond what one node serves at target latency (tens of millions of documents), or faceting as the core feature. The 15 236 RPS figure is a hot-key figure; the cache hit ratio at real key diversity is unmeasured.

## Where this is proven in the repo / what is still paper

Proven:
- Rung 1: [catalog RESULTS](../../services/catalog/RESULTS.md) (GIN, ranking), [inventory RESULTS](../../services/inventory/RESULTS.md) (conditional UPDATE), [payments RESULTS](../../services/payments/RESULTS.md) (commits per payment).
- Rung 2: [catalog ADR 002](../../services/catalog/adr/001-postgres-fts-before-elasticsearch.md), cached run in catalog RESULTS.
- Rung 4 (consumer side only): [notifications RESULTS](../../services/notifications/RESULTS.md).
- Rung 5: [notifications](../../services/notifications/README.md), [payments outbox, drill 2](../failure-drills.md), [waiting-room](../../services/waiting-room/README.md).

Still paper or unmeasured:
- Rung 3: no replica, no lag measurement.
- Rung 4: no Postgres sharding; per-shard write capacity unmeasured on target hardware. Worked design for a sharded key space: [url-shortener](worked-scenarios/url-shortener.md) [paper design].
- Cache hit ratio at realistic key diversity; invalidation across instances (request collapsing via a Redis lock is listed as "not done" in the catalog ADR).
