# From 100 to 1M users: a growth path for a product engineer

What to build first, what to postpone, and the number that ends the postponement, at four stages of one product. Every trigger is a formula you can evaluate with [`packages/capacity`](../../packages/capacity/src/index.ts) and the lab figures in [numbers-to-know.md](../numbers-to-know.md). The ladder of techniques is in [scaling-ladder.md](scaling-ladder.md); this page orders them by user count and adds cost, build-vs-buy and team size.

Labels: [measured] lab figure with its source file (one MacBook Air M1, load generator on the same machine, so conservative and not a production claim); [derived] arithmetic shown; [folk] common ballpark, not measured here; [paper design] a design with no code in this repo. Money is never in real prices: every unit price below is a placeholder you must replace (see the cost section).

## Assumptions shared by all stages

These are inputs, not facts. Replace them with your product's numbers; the structure of the page stays valid.

- Daily active users (DAU) are 20% of registered users (placeholder).
- 20 actions per active user per day, peak factor 10 (the "evening or announcement spike" value in [numbers-to-know.md](../numbers-to-know.md) section e; use 3 for a quiet B2B product, 50-100 for a flash sale).
- Each action issues about 5 database statements (placeholder), 30% of actions write, a write costs 1.5 commits.
- One application instance handles 300 RPS of a real handler with DB calls (placeholder; the lab's measured per-instance figures are 2 359 holds/s, 7 656 queue RPS and 528 payments/s, [measured] in the services' RESULTS.md, but a real product handler must be measured).

Traffic by stage (`pnpm --filter @boxoffice/capacity calc -- traffic --dau <DAU> --actions 20 --peak 10`):

| Stage (registered users) | DAU | Actions per day | Average RPS | Peak RPS | Peak DB statements/s (x5) |
|---|---|---|---|---|---|
| 100 | 20 | 400 | 0.0046 | 0.046 | 0.23 [derived] |
| 10 000 | 2 000 | 40 000 | 0.46 | 4.6 | 23 [derived] |
| 100 000 | 20 000 | 400 000 | 4.6 | 46.3 | 231 [derived] |
| 1 000 000 | 200 000 | 4 000 000 | 46.3 | 463 | 2 315 [derived] |

The first finding is uncomfortable and the main point of the page: at a million registered users this product peaks at 463 RPS and 2 315 statements per second [derived]. One Postgres primary serves 10k-50k+ simple indexed reads per second [folk] ([numbers-to-know.md](../numbers-to-know.md) section b). The technique needed at each stage is usually operational (backups, indexes, observability), not distributed.

## Trigger formulas (used in every stage)

Each is "postpone until the left side exceeds the right side".

| Capability | Trigger | Arithmetic |
|---|---|---|
| Read replica or cache for the database | peak read QPS > 0.6 x single-node read budget | budget 10 000 QPS [folk] x 0.6 = 6 000; at 5 statements per action that is 1 200 peak RPS, reached at DAU = 1 200 x 86 400 / (20 x 10) = 518 400, about 2.6M registered users [derived]. Measure your own budget, then rerun. |
| Cache a specific query | that query is a large share of DB time and repeated, or its uncached p99 exceeds the budget | required hit rate = 1 - 6 000 / peak QPS; at 2 315 QPS the answer is negative (no cache needed on throughput grounds). Measured gain when it does apply: ranked search 684 to 15 236 RPS, p99 292.4 to 8.1 ms ([catalog RESULTS.md](../../services/catalog/RESULTS.md)). Try an index first: GIN vs ILIKE on a rare term was 2 177 vs 25 RPS in the same file. |
| Shard or split writes | peak commits/s > 0.6 x commit ceiling | lab floor 697 RPS x 3 commits = 2 091 commits/s on a laptop ([derived from payments RESULTS.md](../../services/payments/RESULTS.md)), budget 1 255. At this product's 463 RPS x 0.3 writes x 1.5 commits = 208 commits/s at 1M users, 17% of the budget [derived]. Re-measure on target hardware. |
| Connection pooler | instances x pool size > 0.8 x `max_connections` | 3 instances x 20 = 60 connections at 1M users; trouble starts when instances x pool approaches the server limit (about 100 by default, [folk]), so around 4 instances at pool 20 [derived]. Pool size itself: Little's law, `concurrency --rps 463 --latency-ms 5` = 2.3 in flight, so a pool of 20 per instance is generous. |
| Queue for a task | task takes longer than the request budget, calls a dependency that can be down, or in-flight work exceeds the pool | Little's law: payments at 400 RPS with a 100 ms PSP is 40 in flight, more than a pool of 20, which is why the lab never holds a connection across the PSP call ([numbers-to-know.md](../numbers-to-know.md) section e). Evidence that a queue (outbox) keeps the request path alive: broker stopped, 300 of 300 payments OK, events caught up 1.2 s after return ([failure-drills.md](../failure-drills.md) drill 2). |
| Move jobs out of Postgres | job state writes > 10% of the commit budget | 0.1 x 1 255 = 125 writes/s [derived]; below that a jobs table with `SKIP LOCKED` or an outbox is enough. |
| Split a service | (a) component scales 3x or more differently from the rest, (b) different failure domain you must isolate, (c) team ownership boundary | (a) waiting-room 7 656 RPS vs inventory 2 359 RPS per instance = 3.2x ([derived from measured](../../services/waiting-room/RESULTS.md)); the hop itself costs: gateway direct 2 244 to 1 742 through it, 22% fewer RPS ([measured](../../services/gateway/RESULTS.md); 1 - 1 742 / 2 244 = 0.224 [derived]). |
| Dedicated search system | revisit triggers in [catalog adr/001](../../services/catalog/adr/001-postgres-fts-before-elasticsearch.md): typo tolerance, tens of millions of documents, facets as the core feature | no formula; a feature or size threshold, stated in the ADR. |

## Stage 1: about 100 users

Peak 0.046 RPS [derived]. Capacity is irrelevant; the risks are losing data and losing time.

Build first
- One deployable (a modular monolith, one process type), one managed Postgres, one environment per branch if cheap, a staging copy.
- Backups with a restore you have actually run once; migrations in version control.
- Managed auth, a payment provider's hosted checkout, a transactional email service.
- Structured logs with a request id, error tracking, an uptime check.
- Idempotency keys on any write that moves money or sends something (the unique-column pattern, [payments adr/003](../../services/payments/adr/001-saga-over-2pc.md)).

Postpone, and the trigger that ends it
- Cache, queue, replica, container orchestrator, search engine, any second service: postpone until the formulas above fire. At this stage none is within four orders of magnitude of its trigger (0.23 statements/s against 6 000 [derived]).

## Stage 2: about 10 000 users

Peak 4.6 RPS, 23 statements/s [derived]. `instances --peak 4.6 --per-instance 300` = 1, but run two for availability (a deploy or a crash must not take the site down), not for capacity.

Build first
- Two instances behind a load balancer, zero-downtime deploys, health checks.
- Indexes for every query that appears in the slow-query log; a pool sized by Little's law, not copied.
- Metrics on rate, errors and duration per endpoint; an alert on error rate and on p99; one dashboard.
- Email and other side effects through a table (outbox) written in the same transaction as the state change, sent by a worker loop in the same codebase.
- Rate limits on login and signup endpoints (token bucket, see [gateway adr/001](../../services/gateway/adr/001-token-bucket-redis.md); in-process is wrong with two instances, use a shared store once there are two, as the ADR measured).

Postpone
- Cache: ends when `1 - 6 000 / peak QPS` is positive for a query you cannot fix with an index; at 23 statements/s that is 260x away [derived: 6 000 / 23].
- Queue product: ends when job writes exceed 125 per second or a task needs consumers beyond your own worker.
- Microservices: ends at the team-size triggers below, not at this traffic.

## Stage 3: about 100 000 users

Peak 46.3 RPS, 231 statements/s [derived], 26x below the cache trigger.

Build first
- Load test the two or three endpoints that matter, on production-like data size; copy the pattern of [services/catalog/load](../../services/catalog/load/run.sh) (same data, change one variable at a time, record the setup next to the number).
- SLOs written down (availability and p99), with the error budget: 99.9% is 8.8 h per year, 99.99% is 52 minutes ([numbers-to-know.md](../numbers-to-know.md) section d).
- A real job runner (still on Postgres) with retries, backoff, a dead-letter state, and the attempt counter incremented before the work starts; the notifications handler shows the shape with measured exact counts ([notifications RESULTS.md](../../services/notifications/RESULTS.md)).
- Point-in-time recovery, a documented restore time, one failure drill per dependency (the five in [failure-drills.md](../failure-drills.md), plus a slow dependency, which that file lists as not drilled).
- A data retention rule for the biggest tables (events, logs, audit): 146 GB per year at 400 000 events/day of 1 KB [derived: `storage --records-per-day 400k --bytes 1000 --years 1 --replication 1`].

Postpone
- Replica: ends at 6 000 statements/s, or earlier if reports or exports slow interactive queries (then a replica for those, not for traffic).
- Cache: only for one named query, after its index exists.
- Sharding, service split, search cluster: the triggers are in the table; none is near.

## Stage 4: about 1 000 000 users

Peak 463 RPS, 2 315 statements/s [derived], 39% of the read budget and 17% of the commit budget. Still one primary.

Build first
- Three or more application instances (`instances --peak 463 --per-instance 300` = 3 [derived]), autoscaled or scheduled for the evening peak.
- A read replica (for reports and failover, not because of load), a pooler once instances x pool approaches 80% of `max_connections`, a documented failover test.
- A cache for the named hot queries, with single-flight and TTL jitter ([catalog adr](../../services/catalog/adr/001-postgres-fts-before-elasticsearch.md) ADR 002), and a failure policy per route (fail open for public reads, fail closed for anything that spends a scarce resource: [gateway adr/001](../../services/gateway/adr/001-token-bucket-redis.md), drill 1: 100% errors before the fix, 0 after).
- Partition the largest append-only tables by time (events 1.5 TB per year at 4M events/day, [derived: `storage --records-per-day 4M --bytes 1000 --years 1 --replication 1`]).
- A cost review (next section) and a capacity review each quarter: re-run the trigger table with measured numbers.
- If a sale-like spike exists in your product (peak factor 50 or more), the waiting-room and gateway patterns of this lab become relevant here, not before ([waiting-room](../../services/waiting-room/README.md), [gateway](../../services/gateway/README.md)).

Postpone
- Sharding: ends at 1 255 commits/s of measured budget (you are at 208).
- Search cluster: ends at the ADR triggers.
- Multi-region: ends when the availability target or the user latency needs it; a cross-region round trip is 150 ms against 0.5 ms inside a data centre ([numbers-to-know.md](../numbers-to-know.md) section a, [folk]).
- Splitting into services by domain: ends at the team-size triggers.

## Build versus buy

Decision rule for any capability: buy when it is not your differentiator and `vendor cost at your volume x horizon < (build cost + run cost, including on-call and incident time) x horizon`; build when a vendor cannot meet a hard requirement (data residency, latency, a feature) or when the vendor bill grows faster than your engineering cost. Re-run it whenever volume changes by 10x. Break-even volume = (annual build + run cost) / (vendor price per unit per year). No vendor is recommended here; the rule is the product.

| Capability | Buy until | Build (and own) always | Decision numbers |
|---|---|---|---|
| Auth (passwords, MFA, social login, sessions) | per-monthly-active-user price x MAU exceeds the annual cost of one engineer owning it, or a hard residency or protocol requirement appears | authorization: who may do what in your domain | break-even MAU = annual engineer cost / (price per MAU-year); both inputs are yours |
| Payments | never build card handling; a provider hosts the sensitive part | the state machine around it: idempotency, saga with compensation, outbox, reconciliation ([payments adr/001-003](../../services/payments/adr/001-saga-over-2pc.md)); ledger if you hold balances ([worked-scenarios/ledger.md](worked-scenarios/ledger.md)) | the lab shows 3 commits per payment, 528 RPS with a 100 ms PSP ([payments RESULTS.md](../../services/payments/RESULTS.md)) |
| Email and SMS delivery | per-message price x volume is below the cost of running deliverability and reputation yourself (almost always) | templates, preferences, the dedup key and retry policy ([notifications](../../services/notifications/README.md): 0 duplicates, exact dead letters) | at the model below, email is the largest line at 1M users, so negotiate or reduce volume before building |
| Search | Postgres full-text first; buy a managed search service when a trigger in [catalog adr/001](../../services/catalog/adr/001-postgres-fts-before-elasticsearch.md) fires | the indexing pipeline contract (what is indexed, how fast, how to rebuild) | measured: GIN 87x faster than ILIKE on rare terms; ranking costs O(matches), 684 vs 4 387 RPS ([catalog RESULTS.md](../../services/catalog/RESULTS.md)) |
| Queue | start with a jobs table; managed task queue when job writes exceed 10% of the commit budget; a log when you need replay or several independent consumers ([notifications adr/001](../../services/notifications/adr/001-kafka-for-notifications.md)) | retry, backoff, idempotency and dead-letter policy, which a vendor does not remove | thresholds in the trigger table |
| Observability (logs, metrics, traces, errors) | hosted until the ingest bill exceeds the cost of someone running it and you have the people | what you emit: request id, RED metrics, SLO alerts, sampling policy | log bytes = requests/day x bytes per request; at 4M requests/day x 1 KB = 4 GB/day, 120 GB per month [derived]; cut volume (sampling, level) before switching vendor |

## Relative cost drivers

Unit prices are placeholders. Replace every `U` value with your real price before reading any total. What matters here is which line grows with what.

Placeholder prices (all in U, an abstract unit): application instance 1 U per month, database primary 4 U, read replica 4 U, cache node 2 U, storage 0.02 U per GB-month, log ingest 0.5 U per GB, email 0.0005 U per message. Other inputs: 1 KB stored per action (one year retained, one replica), 1 KB of logs per request, 0.1 emails per active user per day.

| Line | Grows with | 100 users | 10k | 100k | 1M | Arithmetic at 1M |
|---|---|---|---|---|---|---|
| App instances | peak traffic | 1 | 2 | 2 | 3 | `instances` result x 1 U |
| Database nodes | peak traffic and data size | 4 | 4 | 4 | 8 | primary + replica |
| Cache | peak traffic (hot reads) | 0 | 0 | 0 | 2 | one node |
| Storage | data (events x retention) | 0 | 0.3 | 2.9 | 29.2 | 1 460 GB x 0.02 |
| Logs | requests (traffic volume, not peak) | 0 | 0.6 | 6 | 60 | 4M x 1 KB = 4 GB/day, 120 GB/month x 0.5 |
| Email | active users | 0.03 | 3 | 30 | 300 | 200 000 x 0.1 x 30 = 600 000 x 0.0005 |
| Total | | about 5 | 9.9 | 44.9 | 402.2 | |

[derived] throughout, from the placeholders above. Readings that survive a change of prices:
- Cost per registered user falls from 0.05 U (5 / 100) to 0.0004 U (402.2 / 1 000 000) as fixed costs are spread, then flattens because the remaining lines are per-event.
- Compute and database (13 of 402.2 U, 3%) are the smallest share at 1M under these placeholders; per-message and per-GB lines (email 75%, logs 15%, storage 7%) dominate. This is why build-versus-buy for email and observability matters more than instance type. If your real prices invert this, the ranking changes; the method does not.
- Three kinds of growth, in order of how often they surprise: linear in active users (email, auth per MAU), linear in request volume (logs, tracing), linear in data times retention (storage, backups, replicas; `storage` multiplies by replication 3 by default). Peak traffic drives only instances, database size and cache, which are the small lines.
- Retention is the cheapest lever: halving log retention halves a 15% line; no architecture change gives that.

## Team size and the shape of the deployment

Communication paths between n people are n(n-1)/2 [derived]: 5 people 10, 10 people 45, 20 people 190, 30 people 435. Service boundaries are a way to cut paths; they cost network hops, deploy pipelines and on-call surfaces.

| Team | Deployable shape | Why |
|---|---|---|
| 1-8 engineers, up to about 500 peak RPS | modular monolith: one codebase and deployable, modules with explicit interfaces, one database with a schema per module, workers as a second entry point of the same codebase | one pipeline, one on-call, in-process calls; this product's 463 RPS peak at 1M users is within one instance of every lab component's measured laptop capacity (528 to 2 359 RPS, 684 for uncached ranked search [measured]) |
| 8-20 engineers | monolith plus a few extracted deployables where a trigger fired: a worker fleet, an edge or queueing layer for spikes, a search service | extraction only where scaling ratio is 3x or more, failure isolation is needed, or one team's release cadence is blocked by another's |
| 20+ engineers, several teams | services along team boundaries, each team owning at most two or three | the path count (190 at 20 people) becomes the bottleneck before the CPU does ([folk] threshold, adjust to your org) |

Strong claim, stated plainly: this repo's six services (inventory, waiting-room, gateway, payments, notifications, catalog) are a LAB split. They exist so each pattern can be built, measured and failed on its own, with its own README, capacity sheet and results. In production, below about 8 engineers and about 500 peak RPS, they would not be six deployables:
- inventory, payments and catalog would be modules of one deployable sharing a Postgres (each already has its own schema or tables), calling each other in process; in-process calls avoid a network hop, whose cost in this lab was 22% fewer RPS for the gateway ([derived](../../services/gateway/RESULTS.md)) and which adds a failure mode per call.
- notifications would be a worker entry point of the same codebase consuming an outbox table, until a replay or multi-consumer need justifies a log ([notifications adr/001](../../services/notifications/adr/001-kafka-for-notifications.md), which itself calls a managed queue the simpler fit for one consumer).
- waiting-room and gateway are the exception: they earn separation only if the product has a flash-sale-shaped spike (peak factor 50-100), because their job is to scale differently (3.2x per instance, [derived](../../services/waiting-room/RESULTS.md)) and to stay up while the core is saturated. Without that shape, a rate limiter is a library in the monolith and a waiting room is not built.

## One-page checklist per stage

Copy a block, tick it with measured numbers, and note the date and setup next to each.

Stage 1 (about 100 users)
- [ ] One deployable and one Postgres; migrations in the repo.
- [ ] Backup exists and a restore was run once; restore time written down.
- [ ] Auth, payments, email are bought; authorisation and idempotency are yours.
- [ ] Request id in every log line; error tracking; uptime check.
- [ ] Idempotency key on money-moving and message-sending writes.

Stage 2 (about 10 000 users)
- [ ] Two instances, health checks, zero-downtime deploy.
- [ ] Slow-query log reviewed; indexes added; pool sized with Little's law.
- [ ] Rate, error, duration metrics per endpoint; alerts on errors and p99.
- [ ] Side effects through an outbox in the same transaction.
- [ ] Login and signup rate limits with shared state across instances.
- [ ] Cost lines tagged: instances, database, storage, logs, email.

Stage 3 (about 100 000 users)
- [ ] SLOs written, error budget known (99.9% is 8.8 h per year).
- [ ] Load test of the key endpoints on production-sized data, results stored with their setup.
- [ ] Job runner with retries, backoff, dead letter, attempt counter before work.
- [ ] Point-in-time recovery tested; one failure drill per dependency, including a slow one.
- [ ] Retention rule for events and logs; storage forecast (146 GB per year in the model).
- [ ] Trigger table re-evaluated with measured budgets; headroom ratios recorded.

Stage 4 (about 1 000 000 users)
- [ ] Three or more instances, evening scale-up; pooler if instances x pool is over 80% of connections.
- [ ] Replica with a tested failover; reports moved to it.
- [ ] Cache only for named queries, with single-flight, TTL jitter and a fail-open or fail-closed policy per route.
- [ ] Large append-only tables partitioned by time; archival rule.
- [ ] Quarterly capacity and cost review with the trigger table; commit rate versus 1 255 budget (replace with your measured ceiling).
- [ ] Decision recorded for each postponed item: the number that triggers it and today's value.
- [ ] Deployment shape justified by team size and scaling ratios, not by fashion.

## Where this is proven in the repo / what is still paper

Proven (measured in the lab, laptop): cache effect and index effect on search ([catalog RESULTS.md](../../services/catalog/RESULTS.md)); commit-bound payments and idempotent retries ([payments RESULTS.md](../../services/payments/RESULTS.md)); the cost of a gateway hop and of fail-open versus hang ([gateway RESULTS.md](../../services/gateway/RESULTS.md), [failure-drills.md](../failure-drills.md)); queue per-instance capacity ([waiting-room RESULTS.md](../../services/waiting-room/RESULTS.md)); consumer scaling and exact dead-letter counts ([notifications RESULTS.md](../../services/notifications/RESULTS.md)); hold throughput under contention ([inventory RESULTS.md](../../services/inventory/RESULTS.md)).

Still paper: every stage's traffic, the 20% DAU ratio, the 300 RPS per instance, all unit prices and the cost table, the team-size thresholds ([folk]), the modular-monolith recommendation (no monolith version of this repo exists), and the production read and commit budgets (10 000 QPS is [folk]; 2 091 commits/s is a laptop floor). Worked examples of other load shapes: [url-shortener](worked-scenarios/url-shortener.md), [feed-fanout](worked-scenarios/feed-fanout.md), [ledger](worked-scenarios/ledger.md), [event-ingestion](worked-scenarios/event-ingestion.md), [file-pipeline](worked-scenarios/file-pipeline.md); how the load shape selects the architecture: [workload-to-architecture.md](workload-to-architecture.md); consistency choices: [consistency-and-contention.md](consistency-and-contention.md); stores: [data-store-selection.md](data-store-selection.md); failure handling: [reliability-patterns.md](reliability-patterns.md).
