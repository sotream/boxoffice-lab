# Data store selection by access pattern

Choose a store by what the code does to the data, not by brand. Related: [workload-to-architecture](workload-to-architecture.md), [scaling-ladder](scaling-ladder.md).

Labels: **[measured]** from a RESULTS.md or drill in this repo; **[derived]** computed from stated assumptions; **[folk]** a widely quoted ballpark, not measured here; **[paper design]** no code in this repo. Elasticsearch/OpenSearch and MongoDB were never run in this repo. Everything said about them below is [folk] or [paper design] and is taken from the ADR reasoning or general knowledge, not from an experiment. Measurements come from one MacBook Air M1 with the generator on the same machine.

## Lookup: access pattern to store

| Access pattern | First choice | Why | Chosen here? |
|---|---|---|---|
| Transactional writes with invariants (conditional update, unique key) | Postgres | One arbiter, one statement | Yes: [inventory](../../services/inventory/adr/001-hold-strategy.md), [payments](../../services/payments/adr/001-saga-over-2pc.md) |
| Point lookup by key, joins, range scans on moderate data | Postgres | Indexes, SQL | Yes |
| Full-text search, moderate corpus, must be consistent with the data | Postgres tsvector + GIN | No sync pipeline | Yes: [catalog ADR 001](../../services/catalog/adr/001-postgres-fts-before-elasticsearch.md) |
| Full-text with typo tolerance, synonyms, facets, tens of millions of documents | Elasticsearch / OpenSearch | Search engine features | No [paper design] |
| Hot cache of derived or repeated reads, TTL | Redis | Memory speed, TTL | Yes: [catalog ADR 002](../../services/catalog/adr/001-postgres-fts-before-elasticsearch.md) |
| Ordered set with rank, idempotent insert, pop N atomically | Redis sorted set | `ZADD NX`, `ZRANK`, `ZPOPMIN` | Yes: [waiting-room ADR](../../services/waiting-room/adr/001-redis-sorted-set-queue.md) |
| Atomic counters and token buckets shared across instances | Redis + Lua | One atomic round trip | Yes: [gateway ADR 001](../../services/gateway/adr/001-token-bucket-redis.md) |
| Append-only event stream with replay, several independent consumers, per-key order | Kafka / Redpanda | Log, partitions, retention | Yes: [notifications ADR 001](../../services/notifications/adr/001-kafka-for-notifications.md) |
| Task queue with per-message ack, delay, built-in DLQ | SQS / RabbitMQ | Simpler than a log | Runner-up, not run |
| Document-shaped records read and written whole, flexible schema, shard-by-key from day one | MongoDB | [folk] | No [paper design] |
| Large immutable blobs (files, images, exports) | Object storage | Cheap per GB, no query | No [paper design] |

## Postgres

**When yes.** Anything with an invariant: conditional UPDATE, unique idempotency key, compare-and-set state transitions, outbox row in the same transaction as the state change. Also the default for everything else until a stated number says otherwise: "Single node first. One Postgres primary handles several thousand simple TPS; shard or add a search cluster only when a stated number exceeds that" ([numbers-to-know](../numbers-to-know.md), [folk]).

**When no.** A queue with random access to a user's position under a spike you are trying to protect the database from (the waiting room rejected a Postgres `ORDER BY joined_at` table because "queue writes would hit the same database we are protecting"). Typo-tolerant, faceted search at corpus sizes beyond one node. Sustained write rates above what one primary commits (see the commit-bound payments measurement).

**What this repo chose it for.**
- Inventory seats with a conditional UPDATE: 2 359 RPS, p99 37.7 ms with 100k seats; 2 780 RPS with 20 hot seats [measured, [inventory RESULTS](../../services/inventory/RESULTS.md)]. [ADR 001](../../services/inventory/adr/001-hold-strategy.md).
- Payments state machine, idempotency key and outbox: about 700 payments/s per instance with pool 20, Postgres-bound, 3 commits per payment [measured, [payments RESULTS](../../services/payments/RESULTS.md)]. [ADR 001 to 003](../../services/payments/adr/001-saga-over-2pc.md).
- Catalog search with tsvector + GIN: 4 387 RPS date-ordered, 684 RPS ranked; 87x ILIKE on a rare term [measured, [catalog RESULTS](../../services/catalog/RESULTS.md)]. [ADR 001](../../services/catalog/adr/001-postgres-fts-before-elasticsearch.md).
- Notification dedup and delivery state `(outbox_id, channel)` with a lease [[notifications ADR 002](../../services/notifications/adr/001-kafka-for-notifications.md)].

**Rejected here and why (from the ADRs).**
- Redis `SET NX EX` as the seat hold: fast with built-in TTL, but "a second source of truth to reconcile with the sale in Postgres"; revisit if the DB becomes the bottleneck. Not measured.
- Redis `SETNX` as an idempotency lock: "adds a second system whose failure semantics must match the database's".
- Serializable isolation: correct but needs retry loops; heavier than needed for single-row predicates.
- Postgres as the waiting-room queue: see "When no".

**Operational cost.** Lowest of the stores here: one system, SQL, transactions, backup. Costs: connection pools (Little's law: 2 500 x 0.02 s = 50 connections in flight for inventory [derived]), a pooler when many instances share a primary, and the single-primary write ceiling. Storage was never the constraint: 100k seats x about 100 B = 10 MB per big event; about 50 GB over 5 years [derived, inventory CAPACITY.md].

**Failure behaviour.** Postgres failover is **not drilled** ([failure-drills](../failure-drills.md) "Not drilled"). What is drilled is the layer around it: killing a notifications consumer mid-delivery lost and duplicated nothing, with recovery equal to the 30 s lease (drill 3, [measured]).

## Redis

**When yes.** Data that is derived, rebuildable, or short-lived, with an access pattern that Redis structures do directly: TTL cache, sorted set with rank, atomic Lua script, counters. Single node about 100k ops/s [folk, numbers-to-know].

**When no.** As the only copy of anything that must not be lost, or as a second source of truth for an invariant owned by a database (the seat hold and the idempotency lock were rejected for this reason).

**What this repo chose it for.**
- Cache-aside for catalog search with single-flight and TTL jitter: 15 236 RPS, p99 8.1 ms vs 684 RPS uncached [measured]. Sizing: about 300 MB for 100k keys of 3 KB, 60 MB hot [derived, catalog CAPACITY.md]. [Catalog ADR 002](../../services/catalog/adr/001-postgres-fts-before-elasticsearch.md).
- Waiting-room queue: sorted set with `INCR` sequence as score; 7 656 RPS, p99 27.8 ms, 6 MB for 41 145 queued users, about 100 B each [measured, [waiting-room RESULTS](../../services/waiting-room/RESULTS.md)]. [ADR](../../services/waiting-room/adr/001-redis-sorted-set-queue.md).
- Gateway token bucket: one Lua call per request; 12 500 ops/s is about 12 % of a node [derived, gateway CAPACITY.md]. [ADR 001](../../services/gateway/adr/001-token-bucket-redis.md).

**Rejected here and why.** In-process counters (wrong with N instances); `GET` then `SET` from the app (races; tested 300 concurrent takes on a bucket of 100 allow about 100); sticky routing with local buckets (uneven, breaks on rebalancing); a Redis lookup per hold for admission (replaced by an HMAC token, trade-off: no revocation for 5 minutes) [gateway ADRs 001 and 002].

**Operational cost.** Low to run, but it becomes a dependency of the hot path, so its failure mode needs a decision. Memory is the cost driver (about 100 MB per million queued users [derived]).

**Failure behaviour.** Drilled: Redis stopped for 10 s under gateway traffic. v1 returned 100 % errors for the whole outage because the client queued commands and every request hung until the 2 s timeout; v2 (fail-fast client, 200 ms command timeout, no offline queue) had 0 errors on availability and a fast 503 on holds and queue calls [measured, drill 1, [failure-drills](../failure-drills.md)]. Policy: fail open for reads, fail closed for anything that spends scarce state. The waiting room is a single point of failure for the sale; worst case users re-join (idempotent), and order is lost, not money [waiting-room ADR].

## Kafka / Redpanda

**When yes.** Replay (re-send a day's notifications after a bug), several independent consumers on one stream later, per-key order, a producer that must not depend on consumer availability. Partition throughput: about 10 MB/s is a safe planning number [folk, numbers-to-know].

**When no.** Pure task queues where per-message ack, delay and a built-in DLQ are what you need (SQS or RabbitMQ is "simpler for this one consumer" [notifications ADR 001]); and lookups like "what is my position in the queue", which a log cannot answer (waiting-room ADR: "offsets are per partition").

**What this repo chose it for.**
- Payments events to notifications, via a transactional outbox: 400 events/s x about 300 B = 120 KB/s, one partition is already 80x oversized; 3 partitions only for consumer parallelism [derived, payments CAPACITY.md].
- Notifications consumer group with 3 partitions: 447 vs 1 393 deliveries/s for 1 vs 3 partitions consumed (x3.1) [measured, [notifications RESULTS](../../services/notifications/RESULTS.md)]. [ADR 001 to 003](../../services/notifications/adr/001-kafka-for-notifications.md).

**Rejected here and why.** Direct HTTP call from payments ("latency and availability would depend on the email provider; no replay"). SQS/RabbitMQ as runner-up. CDC/Debezium instead of a polling outbox relay: correct but more infrastructure, "the production upgrade" [payments ADR 002].

**Operational cost.** Highest of the stores run here. What the log does not provide must be written in the application: retry, backoff, DLQ, dedup (that code is the point of the notifications lab; with SQS it would be configuration). Partition count is hard to change later because it reorders keys. Storage is trivial at this scale: 300 B x 21k events = 6 MB per sale [derived].

**Failure behaviour.** Drilled: Redpanda stopped while 300 payments were made: 300 of 300 OK in 0.7 s, events buffered in the outbox, caught up 1.2 s after the broker returned, topic grew by exactly 300 (drill 2). Consumer SIGKILL at 6 492 of 12 000: 12 000 of 12 000 delivered, 0 duplicate rows, 33.6 s because of the 30 s lease (drill 3) [measured, [failure-drills](../failure-drills.md)]. Delivery is at-least-once; consumers deduplicate.

## Elasticsearch / OpenSearch [paper design]

**Not run in this repo.** The catalog ADR says so explicitly: "Not run in this lab." Nothing below is a measurement.

**When yes.** From the ADR's own revisit triggers: typo tolerance, synonyms or language analysers beyond Postgres dictionaries; a corpus beyond what one node serves at target latency (tens of millions of documents); faceting and aggregations as the core feature. Wins on "typo tolerance, facets, synonyms, relevance tuning, horizontal scale" [catalog ADR 001].

**When no.** Anything that needs the answer to be consistent with the transactional data, or any corpus that one Postgres node serves at target latency. Catalog: 200k events, table 63 MB, indexes 24 MB; under 1M rows in 5 years, "no sharding, no search cluster" [measured sizes, stated conclusion in catalog CAPACITY.md].

**What was rejected and why (copied reasoning).** "A second system, an indexing pipeline (CDC or dual write), eventual consistency, an operations burden." Postgres FTS is "transactional with the data (no sync pipeline, no stale index)".

**Operational cost.** [folk] A cluster to size and upgrade, a sync pipeline to monitor for lag and drift, reindexing when mappings change. A node serves "hundreds to low thousands of queries/s; query complexity dominates" [folk, numbers-to-know]; compare with the measured 684 to 4 387 RPS per Postgres instance on this laptop for the catalog queries, which says nothing about a tuned cluster.

**Failure behaviour.** Not drilled. The failure to design for is index lag or divergence from the source of truth; the repo's pattern for such a feed is the transactional outbox (drill 2), not run against a search index.

**What would settle it.** Load the same 200 000 events into OpenSearch, run the same `services/catalog/load/search.js` scenarios (common term ranked, rare term) and compare RPS, p99 and index-lag after writes. Not done.

## MongoDB [folk] / [paper design]

**Not run in this repo and not discussed in any ADR.** What follows is general knowledge, not a repo decision.

**When yes [folk].** Records are documents read and written whole by one key, the schema varies per record, and horizontal sharding by that key is wanted from day one.

**When no [folk].** Multi-entity invariants and conditional updates across records (this repo's inventory and payments), joins, and anything where a relational constraint is the correctness mechanism. Postgres with `jsonb` covers many "flexible schema" needs without a second system.

**Operational cost and failure behaviour.** Not measured, not drilled. Treat any figure about it as unverified until measured with the same style of `load/` script used elsewhere.

## Object storage [paper design]

For large immutable blobs (uploads, images, exports) with no query beyond "get by key": store the bytes in object storage, keep the key and metadata in Postgres, and move the bytes outside the request path. Cheap per GB and effectively unbounded, with no secondary index, no conditional update and no partial update. Nothing in this repo stores blobs; the design is in [file-pipeline](worked-scenarios/file-pipeline.md) [paper design]. Sizing uses `storageBytes` from [`packages/capacity`](../../packages/capacity/src/index.ts): records/day x bytes x 365 x years x replication.

## Where this is proven in the repo / what is still paper

Proven:
- Postgres: [inventory](../../services/inventory/RESULTS.md), [payments](../../services/payments/RESULTS.md), [catalog](../../services/catalog/RESULTS.md).
- Redis: [catalog cache](../../services/catalog/RESULTS.md), [waiting-room](../../services/waiting-room/RESULTS.md), [gateway](../../services/gateway/RESULTS.md); Redis outage drill 1 in [failure-drills](../failure-drills.md).
- Kafka/Redpanda: [notifications](../../services/notifications/RESULTS.md), [payments outbox](../../services/payments/README.md); drills 2 and 3.

Still paper or unmeasured:
- Elasticsearch/OpenSearch and MongoDB: never run, no code.
- Object storage: [file-pipeline](worked-scenarios/file-pipeline.md).
- Not drilled: Postgres failover, a slow dependency, network partitions ([failure-drills](../failure-drills.md)).
- Redis as seat hold, SQS/RabbitMQ as transport, CDC instead of a polling outbox: named as alternatives, not built or measured.
