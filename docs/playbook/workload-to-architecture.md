# Workload shape to architecture

Given the shape of the load: what breaks first, which pattern answers it, at which number you switch, and where this repo proves it.

Labels used everywhere: **[measured]** from a RESULTS.md or drill in this repo; **[derived]** computed with the formulas in [`packages/capacity`](../../packages/capacity/src/index.ts) or the CAPACITY.md files, arithmetic shown; **[folk]** a widely quoted ballpark, not measured here; **[paper design]** no code in this repo. All measurements come from one MacBook Air M1 with the load generator on the same machine, so they are per-instance planning figures, not production claims (see [numbers-to-know](../numbers-to-know.md)).

## The table

| Shape | What breaks first | Pattern | Trigger number | Proof in this repo |
|---|---|---|---|---|
| Read-heavy | The database repeats the same expensive read (here: ranked search). | Cheap sort key before ranking; cache-aside with single-flight and TTL jitter; replica only after that. | `instancesNeeded(1 157, 536)` = 4 and DB-bound [derived]; with cache 10 275 RPS per instance [measured], 1 instance. | [catalog](../../services/catalog/README.md) |
| Write-heavy | The primary's commit rate (fsync per commit), then index maintenance and storage. | Fewer commits per unit of work, then shard by key, then a log in front. | `shardsNeeded(peakWrites, writesPerShard)`; payments is Postgres-bound at 3 commits per payment [measured]. | Commit-bound part only: [payments](../../services/payments/README.md). Ingestion at scale is [paper design]: [event-ingestion](worked-scenarios/event-ingestion.md). |
| Bursty / flash sale | The protected service, then the connection layer. | Admission control (virtual queue) with a fixed rate derived from the protected capacity; edge rate limit. | admit/s = 2 600 x 0.6 / 3 = 520 [derived]. | [waiting-room](../../services/waiting-room/README.md), [gateway](../../services/gateway/README.md) |
| Fan-out | Delivery rate and the slowest downstream, not request rate. | Partitioned log, consumer group, per-channel state, retries, DLQ. | required rate = 38 000 / 60 = 633/s [derived]; parallelism bounded by partitions. | [notifications](../../services/notifications/README.md) (small fan-out). Feed scale is [paper design]: [feed-fanout](worked-scenarios/feed-fanout.md). |
| Hot-row contention | Lock queue on a few rows; successful throughput falls while failures stay cheap. | Single conditional UPDATE, sorted lock order, all-or-nothing multi-row, lazy expiry. | concurrency = 2 500 x 0.02 = 50 connections [derived]. | [inventory](../../services/inventory/README.md) |
| Long-running jobs | Holding a connection or thread while something slow happens. | Saga with persisted state and `resume`; never hold a DB connection across the external call. | in flight = 400 x 0.1 = 40 [derived]. | External call: [payments](../../services/payments/README.md). Pipeline jobs are [paper design]: [file-pipeline](worked-scenarios/file-pipeline.md). |
| Strict consistency | Every shortcut that is fast by being approximate: caches, replicas, dual writes. | One database as arbiter (conditional UPDATE, unique key), outbox, saga instead of 2PC. | No throughput number; the requirement is the trigger. | [inventory ADR](../../services/inventory/adr/001-hold-strategy.md), [payments ADR](../../services/payments/adr/001-saga-over-2pc.md). Ledger: [ledger](worked-scenarios/ledger.md) [paper design]. |

## Read-heavy

**Recognise it.** Read:write ratio of 10:1 or more (catalog: about 100:1, an assumption stated in the catalog README), staleness tolerated in seconds (a renamed event may show the old title for up to 36 s: a 30 s TTL with +-20% jitter), tight latency budget (catalog p99 under 50 ms). Catalog arithmetic: 1M DAU x 10 searches / 86 400 = 116 RPS average; x10 peak factor = about 1 157 RPS [derived; catalog CAPACITY.md rounds to 1 200].

**What breaks first.** The database, specifically the cost of one query, not the number of Node instances. The measured ordering of costs: ranked FTS 536 RPS, p99 155.6 ms; FTS ordered by date 3 199 RPS (p99 75.4 ms); ranked FTS with Redis cache 10 275 RPS, p99 9.0 ms [measured, [catalog RESULTS](../../services/catalog/RESULTS.md)]. Ranking is O(matches): `ts_rank` scores every match, a b-tree order stops early (6.0x difference for common terms) [measured, same file].

**Pattern and trigger.**
1. Make the query cheap first. GIN beat ILIKE about 390x on a rare term (6 230 vs 16 RPS) but only 1.1x on a common term with a city filter (3 199 vs 2 839 RPS, with a higher p99 for FTS: 75.4 vs 41.6 ms) [measured].
2. Cache-aside with single-flight and TTL jitter: 19x the ranked query (10 275 / 536) [derived from measured]. TTL 30 s +-20 % bounds staleness [stated in CAPACITY.md].
3. Cache size = data x hot fraction = 300 MB x 0.2 = 60 MB [derived, CAPACITY.md; the 300 MB rests on an assumed 100k distinct keys x 3 KB].
4. Move up only when a number says so: instances = ceil(1 157 / (536 x 0.6)) = ceil(3.6) = 4, DB-bound [derived]. Next rungs: [scaling-ladder](scaling-ladder.md); store choice: [data-store-selection](data-store-selection.md).

**Service.** [catalog](../../services/catalog/README.md), [catalog ADRs 001 and 002](../../services/catalog/adr/001-postgres-fts-before-elasticsearch.md).

## Write-heavy

**Recognise it.** Write:read ratio near or above 1:1 (telemetry, ingestion, audit trails), little cache benefit, durability required, sustained rate. Peak writes per second is the number everything keys off.

**What breaks first.** The primary's commit path. One Postgres primary on SSD handles "a few thousand simple TPS" [folk, numbers-to-know], limited by fsync per commit. The only measured write-bound system here is payments: 904 payments/s per instance at PSP 0 ms and 561 at PSP 100 ms, both with a 20-connection pool; Postgres container about 243 % CPU with LWLock waits was measured before the NestJS 12 / Fastify 5 upgrade and not repeated; 3 commits per payment [measured, [payments RESULTS](../../services/payments/RESULTS.md)].

**Pattern and trigger.**
1. Cut commits per unit of work before adding hardware. Payments CAPACITY.md: "scaling beyond means batching state transitions (fewer commits per payment) before sharding". The options named in RESULTS.md (collapse transitions, `synchronous_commit=off` for an intermediate step) were not implemented or measured.
2. Shard by key when `shardsNeeded(peakWrites, writesPerShard)` is above 1. Example [derived, hypothetical]: 30 000 writes/s at 10 000 per shard = ceil(30 000 / (10 000 x 0.6)) = 5 shards (the example in [numbers-to-know](../numbers-to-know.md)). The per-shard figure must be measured on target hardware.
3. Put a log in front when the producer must not wait for the consumer: with the broker stopped, 300 of 300 payments succeeded [measured, drill 2 in [failure-drills](../failure-drills.md)].

**[paper design]** There is no write-heavy ingestion service. Worked design: [event-ingestion](worked-scenarios/event-ingestion.md). What would settle the numbers: a `load/` script that inserts N rows per commit and reports TPS per N on one Postgres (not written).

**Service.** [payments](../../services/payments/README.md), for the commit-bound measurement only.

## Bursty / flash sale

**Recognise it.** Peak factor of 50 to 100 or more [folk range, numbers-to-know]. Inventory: average day 1M DAU x 2 holds / 86 400 = 23 RPS; flash sale 150 000 attempts / 60 s = 2 500 RPS, a factor of about 100 [derived, inventory CAPACITY.md]. Payments: 0.03/s on an ordinary day vs 333/s in the sale, factor above 10 000 [derived, payments CAPACITY.md]. "Sized for the spike, not the average."

**What breaks first.** The protected service and its database, then the connection layer: when 2 000 users dialled in the same millisecond, 96 of them (4.8 %) failed with `dial: i/o timeout` in k6 in the saved instantaneous run (96 to 944 across runs of that variant; earlier runs were not saved). On macOS `kern.ipc.somaxconn` is 128 and caps the accept queue whatever the application asks for, so `backlog: 4096` alone did not fix it: this is a load-generator and OS artefact, and the scenario now spreads arrivals over 3 s (0 failures in two saved runs) [measured; [gateway RESULTS](../../services/gateway/RESULTS.md), [gateway CAPACITY](../../services/gateway/CAPACITY.md)].

**Pattern and trigger.**
1. Do not scale the protected service to the spike; admit users at a rate it can take: admit/s = protected capacity x headroom / attempts per admitted user = 2 600 x 0.6 / 3 = 520 (531 unrounded), configured as 500, deliberately a little below the derived value; drain time 50 000 / 500 = 100 s [derived, [waiting-room CAPACITY](../../services/waiting-room/CAPACITY.md)]. The 2 600 is the measured hold RPS of one inventory instance (2 654) rounded down.
2. The queue is cheap relative to what it protects: 10 134 RPS, p99 22.3 ms, 7.68 MB of Redis for 57 497 queued users, which is up to 140 B per user (100 B is the planning figure; the 7.68 MB includes 10 000 admitted keys and the Redis baseline) [measured, [waiting-room RESULTS](../../services/waiting-room/RESULTS.md)]. Polling instances: ceil(10 000 / (10 100 x 0.6)) = 2 [derived].
3. Enforce admission at the edge without a lookup: signed token verified by HMAC; per-user 5/s burst 10, per-IP 50/s burst 100 [chosen limits, gateway CAPACITY.md]. The hop costs 2 485 to 2 001 RPS [measured].
4. Decide the failure mode per route before the outage: fail open for reads, fail closed for holds [drill 1, [failure-drills](../failure-drills.md)].
5. End to end: 2 000 users, 500/s admission, arrivals spread over 3 s: 3 442 holds + 2 558 conflicts (second run 3 486 + 2 514), held seats in Postgres equal to successful holds, no oversell, 0 failed requests; the instantaneous variant had 96 failed requests and the same invariant [measured, gateway RESULTS]. Latency percentiles from that run are not claimed (generator-bound).

**Service.** [waiting-room](../../services/waiting-room/README.md), [gateway](../../services/gateway/README.md).

## Fan-out

**Recognise it.** One input event produces many deliveries, the work is asynchronous, and the metric is time to drain, not RPS. Notifications: 20 000 confirmed payments, 90 % x 2 channels + 10 % x 1 = 38 000 deliveries; target 60 s gives 38 000 / 60 = 633/s [derived, [notifications CAPACITY](../../services/notifications/CAPACITY.md)].

**What breaks first.** The slowest downstream and the consumer parallelism. One partition at a time: 447 deliveries/s, 85.1 s; three at once: 1 393/s, 27.3 s (x3.1) [measured, [notifications RESULTS](../../services/notifications/RESULTS.md)]. Then provider limits: email providers often throttle at 10 to 100 msg/s per account, depending on plan [folk, quoted in notifications CAPACITY.md; check the chosen provider's quota], so 633/s needs an outbound token bucket or several accounts.

**Pattern and trigger.**
1. Partitioned log: 3 partitions, at most 3 busy consumers. Choose the count from the peak parallelism you will ever need; raising it later reorders keys [stated in CAPACITY.md].
2. deliveries/s about concurrency x partitions in parallel / (sender latency + DB claim time) [stated]. Required 633/s is above the measured 447 (one partition) and below 1 393 (three).
3. At-least-once with a DB dedup key `(outbox_id, channel)`, lease claim, 4 attempts with backoff and jitter, DLQ: 38 000 of 38 000 delivered, 0 duplicate rows, 10 dead letters equal to the 10 poison messages [measured].
4. Killing the consumer at 6 229 of 12 000: finished 12 000 of 12 000, 0 duplicates, recovery bounded by the 30 s lease [measured, drill 3].

**Limit of the code.** Fan-out here is one event to at most 2 channels. One post to millions of followers (write vs read fan-out, celebrity accounts) is **[paper design]**: [feed-fanout](worked-scenarios/feed-fanout.md).

**Service.** [notifications](../../services/notifications/README.md), [ADR 001 to 003](../../services/notifications/adr/001-kafka-for-notifications.md).

## Hot-row contention

**Recognise it.** Many requests target the same small set of rows (seats in one event, a counter, a balance) and correctness beats availability. Inventory: 20 000 seats, 50 000 users in 60 s, about 3 attempts each [inventory README and CAPACITY.md].

**What breaks first.** Row locks serialise writers on the hot rows. The measured effect is subtle: hot seats were faster per request (3 222 RPS with 20 hot seats vs 2 654 with 100k seats, atomic-update) because losers get an immediate 409 and no write happens; successful-hold throughput is what drops, so measure both [measured, [inventory RESULTS](../../services/inventory/RESULTS.md)]. The structural limit is the one primary all instances write to.

**Pattern and trigger.**
1. One conditional `UPDATE ... WHERE free RETURNING`, not check-then-write (race) and not `SELECT ... FOR UPDATE` + UPDATE. The reason is correctness and one round trip; the first-version speed gap (about 18 % at low contention) did not reproduce on the final code, so do not cite it as a measured benefit [measured, [benchmarks](../benchmarks.md)].
2. Sorted seat ids (every multi-row statement first locks its rows with `ORDER BY seat_id FOR UPDATE`, in the same statement for the single-UPDATE path; the test forces different plans for hold and confirm and sees no deadlock), all-or-nothing multi-seat, lazy expiry in the WHERE clause so no sweeper exists [[ADR 001](../../services/inventory/adr/001-hold-strategy.md), tested].
3. Sizing: instances = ceil(2 500 / (2 600 x 0.6)) = 2; concurrency = 2 500 x 0.018 s = 45 connections [derived].
4. When many events sell at once, shard by `event_id`: shards = `shardsNeeded(peak writes, writes per shard)`. Hypothetical: 10 simultaneous events at 2 500 holds/s with the measured 2 654 as a conservative per-shard figure: ceil(25 000 / (2 654 x 0.6)) = 16 [derived; the per-shard figure is laptop-bound]. Sharding by event keeps one event's lock behaviour unchanged.
5. Redis `SET NX EX` as the hold was rejected for now (second source of truth); revisit if the DB becomes the bottleneck [ADR 001]. Not measured here.

Mechanics in depth: [consistency-and-contention](consistency-and-contention.md).

**Service.** [inventory](../../services/inventory/README.md).

## Long-running jobs

**Recognise it.** A unit of work that waits on something slow or external (a payment provider, file conversion, a batch), so its duration dwarfs the database work. Payments: PSP call about 100 ms, which we cannot speed up.

**What breaks first.** Pools and threads, because slow work multiplies in-flight work: 400/s x 0.1 s = 40 concurrent payments [derived]. If each held a DB connection during the PSP call, a pool of 20 would cap throughput at 20 / 0.1 = 200 per second [derived]. The code opens a transaction only for state changes, so a pool of 20 serves 40+ in-flight payments [stated, payments CAPACITY.md]. Measured at PSP 100 ms vs 0 ms: 561 vs 904 RPS; Postgres, not the PSP wait, is the limit. Both figures are from before the REFUNDING state added a fourth commit to the compensation path they exercised, and before the metrics and logging existed; they are marked to-be-remeasured in [payments CAPACITY](../../services/payments/CAPACITY.md).

**Pattern and trigger.**
1. Persist state, move it by compare-and-set transitions, give the process `resume(id)` so a crash at any step continues from stored state [payments README; crash-at-each-step tests].
2. Orchestrated saga with compensation, not 2PC (the PSP cannot join a distributed transaction): charge first, confirm seats second, refund if the confirm fails [[ADR 001](../../services/payments/adr/001-saga-over-2pc.md)]. The refund is claimed first (`CHARGED -> REFUNDING`, a compare-and-set) so two racing runners cannot both decide [[ADR 005](../../services/payments/adr/005-claim-refund-before-issuing-it.md)].
3. Events through a transactional outbox: with the broker down, 300 of 300 payments succeeded and events caught up 0.7 s after it returned [measured, drill 2].

**[paper design]** Jobs lasting seconds to hours (file pipelines, transcoding, reports) have no code here: [file-pipeline](worked-scenarios/file-pipeline.md). The slow-PSP drill is done (drill 4 in [failure-drills](../failure-drills.md)); slow Postgres, Redis and broker are not drilled.

**Service.** [payments](../../services/payments/README.md).

## Strict consistency

**Recognise it.** Requirements phrased as "never twice", "never lost", "never oversold". Inventory: a seat is never sold or held twice. Payments: never charge twice, never lose an event, survive a crash at any step.

**What breaks first.** The shortcuts: check-then-write races; a cache or replica answers stale; a dual write loses an event if the process dies between the writes; a Redis lock has failure semantics that must match the database's.

**Pattern.** Let one database decide, in one statement:
- Inventory: conditional UPDATE; held seats in Postgres = successful holds in all three flash-sale runs (3 442, 3 486 and 3 408) [measured, gateway RESULTS].
- Payments: idempotency key as a unique column, `INSERT ... ON CONFLICT DO NOTHING`; of 50 concurrent identical requests exactly one runs the saga [[ADR 003](../../services/payments/adr/001-saga-over-2pc.md), tested]; 0 duplicate idempotency keys over 15 097 payments (and over 9 407 in the PSP 100 ms run) [measured, payments RESULTS].
- Events: transactional outbox, at-least-once, consumers deduplicate by `outboxId` [[ADR 002](../../services/payments/adr/001-saga-over-2pc.md)]; payments rows 15 097, outbox rows 15 097, published 15 097 [measured].
- Exactly-once delivery to an external provider cannot be guaranteed by the sender alone; use at-least-once plus a dedup key [[notifications ADR 002](../../services/notifications/adr/001-kafka-for-notifications.md)].

**Trigger.** No throughput number; the requirement is the trigger. The cost is that every writer shares one primary, so the first scale-out step is fewer commits per operation, then sharding by the entity that owns the invariant (event, account). See [consistency-and-contention](consistency-and-contention.md) and [reliability-patterns](reliability-patterns.md).

**Service.** [inventory](../../services/inventory/README.md), [payments](../../services/payments/README.md).

## Decision procedure

Ask in this order. Stop at the first question whose answer changes the design, then return to the table.

1. **What is the peak, not the average?** avg RPS = DAU x actions / 86 400; peak = avg x peak factor (3 normal, 10 evening spike, 50 to 100 flash sale [folk]). If the factor is above about 50, you have a burst: put admission control in front of the protected service first, sized by `admit/s = capacity x 0.6 / attempts`.
2. **What is the read:write ratio?** Above about 10:1 with staleness tolerated: read-heavy, start the [scaling-ladder](scaling-ladder.md) at rung 1. Near 1:1 or write-dominant: write-heavy; find commits per unit of work and TPS per primary.
3. **Is there an invariant that must never be violated?** If yes, one database decides with one statement and a unique key; no cache, replica or lock service on that path. Arrange everything else around it.
4. **Do many requests hit the same rows?** If yes: one conditional UPDATE, sorted lock order, measure successful throughput as well as RPS. Shard by the owning entity only when `shardsNeeded` says so.
5. **Does one input create many outputs?** If yes the metric is drain time: required rate = deliveries / target seconds. Use a log and a consumer group; parallelism = partitions; check the downstream's own rate limit.
6. **Does a unit of work wait on something slow or external?** If yes: in flight = RPS x latency; never hold a DB connection across the wait; persist state; make every step resumable; saga over 2PC.
7. **What happens when a dependency dies?** Decide per route: fail open (cheap reads) or fail closed (anything that spends scarce state). If you have not drilled it, say so.
8. **Which inputs to the trigger formulas are missing?** For each (per-instance RPS, per-shard writes, cache hit rate), name the script that would produce it (`load/` in the service). Do not substitute a guess; mark it [folk] or leave it open.
9. **Choose the store last.** Name the access pattern (point lookup, range scan, ranked text, append and replay, ordered set with rank, atomic counter), then use [data-store-selection](data-store-selection.md).

Most systems are several shapes at once (the ticket sale is bursty + hot-row + strict + long-running + fan-out). Solve in the order above; each earlier answer constrains the later ones.

## Where this is proven in the repo / what is still paper

Proven (code and measurements):
- Read-heavy: [catalog RESULTS](../../services/catalog/RESULTS.md).
- Bursty: [waiting-room RESULTS](../../services/waiting-room/RESULTS.md), [gateway RESULTS](../../services/gateway/RESULTS.md).
- Hot-row and strict consistency: [inventory RESULTS](../../services/inventory/RESULTS.md), [inventory ADR](../../services/inventory/adr/001-hold-strategy.md).
- Small fan-out: [notifications RESULTS](../../services/notifications/RESULTS.md).
- Long-running external call, saga, outbox: [payments RESULTS](../../services/payments/RESULTS.md), [payments ADR](../../services/payments/adr/001-saga-over-2pc.md).
- Failure behaviour: drills 1 to 3 in [failure-drills](../failure-drills.md).

Still paper:
- Write-heavy ingestion: [event-ingestion](worked-scenarios/event-ingestion.md).
- Fan-out at feed scale: [feed-fanout](worked-scenarios/feed-fanout.md).
- Long-running pipeline jobs: [file-pipeline](worked-scenarios/file-pipeline.md).
- Money-grade ledger: [ledger](worked-scenarios/ledger.md).
- Not measured: rows per commit vs TPS, per-shard write capacity, a Redis-based hold, slow Postgres/Redis/broker drills (the slow PSP drill is done).
