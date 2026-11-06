# From 100 to 1M users: a growth path for a product engineer

What to build first, what to postpone, and the number that ends the postponement, at four stages of one product. Every trigger is a formula you can evaluate with [`packages/capacity`](../../packages/capacity/src/index.ts) and the lab figures in [numbers-to-know.md](../numbers-to-know.md). The ladder of techniques is in [scaling-ladder.md](scaling-ladder.md); this page orders them by user count and adds cost, build-vs-buy and team size.

Labels: [measured] lab figure with its source file (one MacBook Air M1, load generator on the same machine, so conservative and not a production claim); [derived] arithmetic shown; [folk] common ballpark, not measured here; [paper design] a design with no code in this repo; [public price, 2026-11-06] an AWS on-demand list price for eu-central-1, listed in the [Price sources](#price-sources) table. List prices change; recompute with the date shown.

## Assumptions shared by all stages

These are inputs, not facts. Replace them with your product's numbers; the structure of the page stays valid.

- Daily active users (DAU) are 20% of registered users (placeholder).
- 20 actions per active user per day, peak factor 10 (the "evening or announcement spike" value in [numbers-to-know.md](../numbers-to-know.md) section e; use 3 for a quiet B2B product, 50-100 for a flash sale).
- Each action issues about 5 database statements (placeholder), 30% of actions write, a write costs 1.5 commits.
- One application instance handles 300 RPS of a real handler with DB calls (placeholder; the lab's measured per-instance figures are 2 654 holds/s, 10 134 queue RPS and 561 payments/s at a 100 ms PSP, [measured] in the services' RESULTS.md, but a real product handler must be measured).

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
| Cache a specific query | that query is a large share of DB time and repeated, or its uncached p99 exceeds the budget | required hit rate = 1 - 6 000 / peak QPS; at 2 315 QPS the answer is negative (no cache needed on throughput grounds). Measured gain when it does apply: ranked search 536 to 10 275 RPS, p99 155.6 to 9.0 ms ([catalog RESULTS.md](../../services/catalog/RESULTS.md)). Try an index first: GIN vs ILIKE on a rare term was 6 230 vs 16 RPS in the same file. |
| Shard or split writes | peak commits/s > 0.6 x commit ceiling | one laptop run: 904 RPS x 3 commits = 2 712 commits/s ([derived from payments RESULTS.md](../../services/payments/RESULTS.md)); budget 2 712 x 0.6 = 1 627. This is one Docker-on-laptop run, not a floor for production hardware, where fsync cost differs. At this product's 463 RPS x 0.3 writes x 1.5 commits = 208 commits/s at 1M users, 13% of the budget [derived]. Re-measure on target hardware. |
| Connection pooler | instances x pool size > 0.8 x `max_connections` | 3 instances x 20 = 60 connections at 1M users; trouble starts when instances x pool approaches the server limit (about 100 by default, [folk]), so around 4 instances at pool 20 (4 x 20 = 80 = 0.8 x 100) [derived]. Pool size itself: Little's law, `concurrency --rps 463 --latency-ms 5` = 2.3 in flight, so a pool of 20 per instance is generous. |
| Queue for a task | task takes longer than the request budget, calls a dependency that can be down, or in-flight work exceeds the pool | Little's law: payments at 400 RPS with a 100 ms PSP is 40 in flight, more than a pool of 20, which is why the lab never holds a connection across the PSP call ([numbers-to-know.md](../numbers-to-know.md) section e). Evidence that a queue (outbox) keeps the request path alive: broker stopped, 300 of 300 payments OK, events caught up 0.7 s after return ([failure-drills.md](../failure-drills.md) drill 2). |
| Move jobs out of Postgres | job state writes > 10% of the commit budget | 0.1 x 1 627 = 163 writes/s [derived]; below that a jobs table with `SKIP LOCKED` or an outbox is enough. |
| Split a service | (a) component scales 3x or more differently from the rest, (b) different failure domain you must isolate, (c) team ownership boundary | (a) waiting-room 10 134 RPS vs inventory 2 654 RPS per instance = 3.8x ([derived from measured](../../services/waiting-room/RESULTS.md)); the hop itself costs: gateway direct 2 485 to 2 001 through it, 19% fewer RPS (1 - 2 001 / 2 485 = 0.195 [derived] from [measured](../../services/gateway/RESULTS.md) figures). |
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
- Point-in-time recovery, a documented restore time, one failure drill per dependency (the five in [failure-drills.md](../failure-drills.md), which include a slow PSP; slow Postgres, Redis and broker are listed there as not drilled).
- A data retention rule for the biggest tables (events, logs, audit): 146 GB per year at 400 000 events/day of 1 KB [derived: `storage --records-per-day 400k --bytes 1000 --years 1 --replication 1`].

Postpone
- Replica: ends at 6 000 statements/s, or earlier if reports or exports slow interactive queries (then a replica for those, not for traffic).
- Cache: only for one named query, after its index exists.
- Sharding, service split, search cluster: the triggers are in the table; none is near.

## Stage 4: about 1 000 000 users

Peak 463 RPS, 2 315 statements/s [derived], 39% of the read budget and 13% of the commit budget. Still one primary.

Build first
- Three or more application instances (`instances --peak 463 --per-instance 300` = 3 [derived]), autoscaled or scheduled for the evening peak.
- A read replica (for reports and failover, not because of load), a pooler once instances x pool approaches 80% of `max_connections`, a documented failover test.
- A cache for the named hot queries, with single-flight and TTL jitter ([catalog adr](../../services/catalog/adr/001-postgres-fts-before-elasticsearch.md) ADR 002), and a failure policy per route (fail open for public reads, fail closed for anything that spends a scarce resource: [gateway adr/001](../../services/gateway/adr/001-token-bucket-redis.md), drill 1: 100% errors before the fix, 0 after).
- Partition the largest append-only tables by time (events 1.5 TB per year at 4M events/day, [derived: `storage --records-per-day 4M --bytes 1000 --years 1 --replication 1`]).
- A cost review (next section) and a capacity review each quarter: re-run the trigger table with measured numbers.
- If a sale-like spike exists in your product (peak factor 50 or more), the waiting-room and gateway patterns of this lab become relevant here, not before ([waiting-room](../../services/waiting-room/README.md), [gateway](../../services/gateway/README.md)).

Postpone
- Sharding: ends at 1 627 commits/s of measured budget (you are at 208).
- Search cluster: ends at the ADR triggers.
- Multi-region: ends when the availability target or the user latency needs it; a cross-region round trip is 150 ms against 0.5 ms inside a data centre ([numbers-to-know.md](../numbers-to-know.md) section a, [folk]).
- Splitting into services by domain: ends at the team-size triggers.

## Build versus buy

Decision rule for any capability: buy when it is not your differentiator and `vendor cost at your volume x horizon < (build cost + run cost, including on-call and incident time) x horizon`; build when a vendor cannot meet a hard requirement (data residency, latency, a feature) or when the vendor bill grows faster than your engineering cost. Re-run it whenever volume changes by 10x. Break-even volume = (annual build + run cost) / (vendor price per unit per year). No vendor is recommended here; the rule is the product.

| Capability | Buy until | Build (and own) always | Decision numbers |
|---|---|---|---|
| Auth (passwords, MFA, social login, sessions) | per-monthly-active-user price x MAU exceeds the annual cost of one engineer owning it, or a hard residency or protocol requirement appears | authorization: who may do what in your domain | break-even MAU = annual engineer cost / (price per MAU-year); both inputs are yours |
| Payments | never build card handling; a provider hosts the sensitive part | the state machine around it: idempotency, saga with compensation, outbox, reconciliation ([payments adr/001-003](../../services/payments/adr/001-saga-over-2pc.md)); ledger if you hold balances ([worked-scenarios/ledger.md](worked-scenarios/ledger.md)) | the lab shows 3 commits per payment, 561 RPS with a 100 ms PSP ([payments RESULTS.md](../../services/payments/RESULTS.md)) |
| Email and SMS delivery | per-message price x volume is below the cost of running deliverability and reputation yourself (almost always) | templates, preferences, the dedup key and retry policy ([notifications](../../services/notifications/README.md): 0 duplicates, exact dead letters) | at the SES list price in the cost section, 600 000 emails a month cost 60 USD, 5.6% of the 1M-user total [public price, 2026-11-06]; price does not decide this one, deliverability work does. Other providers and SMS were not priced here |
| Search | Postgres full-text first; buy a managed search service when a trigger in [catalog adr/001](../../services/catalog/adr/001-postgres-fts-before-elasticsearch.md) fires | the indexing pipeline contract (what is indexed, how fast, how to rebuild) | measured: GIN about 390x faster than ILIKE on rare terms; ranking costs O(matches), 536 vs 3 199 RPS ([catalog RESULTS.md](../../services/catalog/RESULTS.md)) |
| Queue | start with a jobs table; managed task queue when job writes exceed 10% of the commit budget; a log when you need replay or several independent consumers ([notifications adr/001](../../services/notifications/adr/001-kafka-for-notifications.md)) | retry, backoff, idempotency and dead-letter policy, which a vendor does not remove | thresholds in the trigger table |
| Observability (logs, metrics, traces, errors) | hosted until the ingest bill exceeds the cost of someone running it and you have the people | what you emit: request id, RED metrics, SLO alerts, sampling policy | log bytes = requests/day x bytes per request; at 4M requests/day x 1 KB = 4 GB/day, 120 GB per month [derived]; at the CloudWatch Logs ingest list price that is 75.60 USD per month [public price, 2026-11-06]; cut volume (sampling, level) before switching vendor |

## Cost drivers at public list prices

All prices here are AWS on-demand list prices for eu-central-1 (Frankfurt), Linux, no Savings Plans, no free tier, retrieved on 2026-11-06 [public price, 2026-11-06]. Each price and its SKU is in the [Price sources](#price-sources) table; the rows below cite it as P1 to P7. List prices change; recompute with the date shown. What matters is which line grows with what.

Sizing assumptions (inputs, not prices): an application instance is one Fargate task of 1 vCPU and 2 GB (the 300 RPS per instance above is still a placeholder); the database primary is db.m6g.large single-AZ and a read replica is a second db.m6g.large (AWS bills a replica at the same rate as a standard instance of that class, source in the table); the cache node is cache.m6g.large; one month is 730 hours; 1 KB stored per action, one year retained, kept on the primary and, at 1M, also on the replica; 1 KB of logs per request, 30 days per month; 0.1 emails per active user per day.

Unit costs per month [public price, 2026-11-06], arithmetic:
- Application instance (P1, P2): (1 x 0.04656 + 2 x 0.00511) USD/h = 0.05678 USD/h x 730 = 41.45 USD.
- Database node (P3): 0.189 x 730 = 137.97 USD.
- Cache node (P5): 0.177 x 730 = 129.21 USD.
- Storage (P4): 0.137 USD per GB-month. Logs (P6): 0.63 USD per GB ingested. Email (P7): 0.0001 USD per recipient.

| Line | Grows with | 100 users | 10k | 100k | 1M | Arithmetic at 1M (USD per month) |
|---|---|---|---|---|---|---|
| App instances | peak traffic | 41.45 (1) | 82.90 (2) | 82.90 (2) | 124.35 (3) | `instances` result 3 x 41.45 |
| Database nodes | peak traffic and data size | 137.97 (1) | 137.97 (1) | 137.97 (1) | 275.94 (2) | primary + replica, 2 x 137.97 |
| Cache | peak traffic (hot reads) | 0 | 0 | 0 | 129.21 (1) | one node |
| Storage | data (events x retention) | 0.02 | 2.00 | 20.00 | 400.04 | 1 460 GB x 0.137 x 2 copies (primary and replica) |
| Logs | requests (traffic volume, not peak) | 0.01 | 0.76 | 7.56 | 75.60 | 4M x 1 KB = 4 GB/day, 120 GB/month x 0.63 |
| Email | active users | 0.01 | 0.60 | 6.00 | 60.00 | 200 000 x 0.1 x 30 = 600 000 x 0.0001 |
| Total | | 179.45 | 224.22 | 254.43 | 1 065.14 | |
| Total, Multi-AZ primary | | 318.17 | 364.92 | 413.13 | 1 403.86 | primary node 0.379 x 730 = 276.67 (P3b) instead of 137.97, primary storage 0.274 (P4b) instead of 0.137; the read replica stays single-AZ |

[derived] from the [public price, 2026-11-06] unit costs, with the stored data counted at its end-of-year size (146 GB at 100k, 1 460 GB at 1M, from the storage commands in the stage sections; 14.6 GB at 10k, 0.15 GB at 100). Provisioned gp3 storage is billed by allocated size, so the small stages are a lower bound. Not included: data transfer, load balancer, NAT, backups and snapshots, log storage, Multi-AZ, support, taxes, payment-provider fees, an auth vendor, monitoring beyond logs. Multi-AZ matters: with a Multi-AZ primary (0.379 USD/h and 0.274 USD per GB-month, P3b and P4b) and the same single-AZ replica, the 1M total is 1 403.86 USD instead of 1 065.14 [derived].

Readings (they follow from these prices; change the prices and the ranking can change):
- Total cost grows 5.9x (179.45 to 1 065.14) while users grow 10 000x. Cost per registered user falls from 1.79 USD (179.45 / 100) to 0.0011 USD (1 065.14 / 1 000 000) as fixed costs are spread, then flattens because the remaining lines are per-event.
- Multi-AZ (a standby in a second availability zone for automatic failover) adds the node price difference (0.379 - 0.189) x 730 = 138.70 USD per primary plus the doubled storage rate on the primary: +77% at 100 users (318.17 vs 179.45), +32% at 1M (1 403.86 vs 1 065.14). It is a fixed cost per primary, so it hurts most when the product is small. Whether it is worth it is an availability decision (how long an outage the product can accept), not a cost-optimisation one. Arithmetic: 1 065.14 + 138.70 + 1 460 x 0.137 = 1 403.86.
- At 1M under these prices, nodes (app 124.35 + database 275.94 + cache 129.21 = 529.50 USD) are 49.7% of the total, storage 37.6%, logs 7.1%, email 5.6%. Email is not the dominant line at the SES list price, so build-versus-buy for email is decided by deliverability work, not by the bill. If you add Multi-AZ, nodes and storage grow further.
- Storage is the largest single line only because it keeps one unpartitioned year of events on provisioned gp3 on two nodes. Moving closed partitions out of the database to S3 Standard (0.0245 USD per GB-month for the first 50 TB, P8) would price 1 460 GB at 35.77 USD against 200.02 USD on gp3 (0.137 / 0.0245 = 5.6x), before request and retrieval costs, which were not priced.
- Three kinds of growth, in order of how often they surprise: linear in active users (email, auth per MAU), linear in request volume (logs, tracing), linear in data times retention (storage, backups, replicas; `storage` multiplies by replication 3 by default). Peak traffic drives only instances, database size and cache; they step up (1 to 3 instances, 1 to 2 database nodes) instead of growing smoothly.
- Retention and volume are the cheapest levers: halving event retention halves the storage line (200 USD at 1M); halving log volume (sampling, level) halves the 75.60 USD ingest line. No architecture change gives either.

### Price sources

Retrieved 2026-11-06 from the AWS Price List bulk files (official), region eu-central-1 unless stated. Offer version is the `version` field of the downloaded file. "Hrs" prices are per hour.

| ID | Item | SKU / instance type | Region | Unit | Price (USD) | Source | Date |
|---|---|---|---|---|---|---|---|
| P1 | AWS Fargate vCPU, Linux/X86 | SKU CVZB3RCF48N5AH4A, usage type `EUC1-Fargate-vCPU-Hours:perCPU` | eu-central-1 | vCPU-hour | 0.04656 | [AmazonECS offer file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/eu-central-1/index.json), version 20261019224317 | 2026-11-06 |
| P2 | AWS Fargate memory, Linux/X86 | SKU X7HM34A7GZK89N7Y, usage type `EUC1-Fargate-GB-Hours` | eu-central-1 | GB-hour | 0.00511 | same file | 2026-11-06 |
| P3 | RDS for PostgreSQL, db.m6g.large, Single-AZ, on-demand | SKU 4CNEP8PYGNGARJCU, `EUC1-InstanceUsage:db.m6g.large` | eu-central-1 | instance-hour | 0.189 | [AmazonRDS offer file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/eu-central-1/index.json), version 20261029070635 | 2026-11-06 |
| P3b | RDS for PostgreSQL, db.m6g.large, Multi-AZ (sensitivity only) | SKU 3EPYZ9JVNEYAMVNM, `EUC1-Multi-AZUsage:db.m6g.large` | eu-central-1 | instance-hour | 0.379 | same file | 2026-11-06 |
| P4 | RDS provisioned gp3 storage, PostgreSQL, Single-AZ | SKU JN8MTUNBMV3GFTFY, `EUC1-RDS:GP3-Storage` | eu-central-1 | GB-month | 0.137 | same file | 2026-11-06 |
| P4b | RDS provisioned gp3 storage, Multi-AZ (sensitivity only) | SKU 6TQECZDJQGPDX8VF, `EUC1-RDS:Multi-AZ-GP3-Storage` | eu-central-1 | GB-month | 0.274 | same file | 2026-11-06 |
| P5 | ElastiCache for Redis, cache.m6g.large, on-demand node | SKU 3XA44VSREYXCC4ZG, `EUC1-NodeUsage:cache.m6g.large` | eu-central-1 | node-hour | 0.177 | [AmazonElastiCache offer file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonElastiCache/current/eu-central-1/index.json), version 20261028192450 | 2026-11-06 |
| P6 | CloudWatch Logs ingestion, Standard log class | SKU XAE7GPNAZR6AWCQK, `EUC1-DataProcessing-Bytes` | eu-central-1 | GB ingested | 0.63 | [AmazonCloudWatch offer file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonCloudWatch/current/eu-central-1/index.json), version 20261104213532 | 2026-11-06 |
| P7 | Amazon SES, recipients of SendEmail / SendRawEmail | SKU 6R99TSTZJPBE6N5E, `EUC1-Recipients` | eu-central-1 | recipient | 0.0001 | [AmazonSES offer file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonSES/current/index.json), version 20261104174109 | 2026-11-06 |
| P8 | Amazon S3 Standard storage, first 50 TB per month (next 450 TB: 0.0235, above 500 TB: 0.0225) | SKU NRYRNCXF5TWHB476, `EUC1-TimedStorage-ByteHrs` | eu-central-1 | GB-month | 0.0245 | [AmazonS3 offer file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/eu-central-1/index.json), version 20261104174445 | 2026-11-06 |
| P9 | Read replica billing rule: "Read replicas are billed as standard DB instances at the same rates as the DB instance class used for the replica." | not a price | n/a | n/a | n/a | [RDS user guide, read replicas](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html) | 2026-11-06 |

The vendor pricing pages (for example https://aws.amazon.com/rds/postgresql/pricing/) show the same list prices in a browser; the bulk files above are the source used. The index of all offer files is https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json.

## Team size and the shape of the deployment

Communication paths between n people are n(n-1)/2 [derived]: 5 people 10, 10 people 45, 20 people 190, 30 people 435. Service boundaries are a way to cut paths; they cost network hops, deploy pipelines and on-call surfaces.

| Team | Deployable shape | Why |
|---|---|---|
| 1-8 engineers, up to about 500 peak RPS | modular monolith: one codebase and deployable, modules with explicit interfaces, one database with a schema per module, workers as a second entry point of the same codebase | one pipeline, one on-call, in-process calls; this product's 463 RPS peak at 1M users is within one instance of every lab component's measured laptop capacity (561 to 2 654 RPS, 536 for uncached ranked search [measured]) |
| 8-20 engineers | monolith plus a few extracted deployables where a trigger fired: a worker fleet, an edge or queueing layer for spikes, a search service | extraction only where scaling ratio is 3x or more, failure isolation is needed, or one team's release cadence is blocked by another's |
| 20+ engineers, several teams | services along team boundaries, each team owning at most two or three | the path count (190 at 20 people) becomes the bottleneck before the CPU does ([folk] threshold, adjust to your org) |

Strong claim, stated plainly: this repo's six services (inventory, waiting-room, gateway, payments, notifications, catalog) are a LAB split. They exist so each pattern can be built, measured and failed on its own, with its own README, capacity sheet and results. In production, below about 8 engineers and about 500 peak RPS, they would not be six deployables:
- inventory, payments and catalog would be modules of one deployable sharing a Postgres (each already has its own schema or tables), calling each other in process; in-process calls avoid a network hop, whose cost in this lab was 19% fewer RPS for the gateway ([derived](../../services/gateway/RESULTS.md)) and which adds a failure mode per call.
- notifications would be a worker entry point of the same codebase consuming an outbox table, until a replay or multi-consumer need justifies a log ([notifications adr/001](../../services/notifications/adr/001-kafka-for-notifications.md), which itself calls a managed queue the simpler fit for one consumer).
- waiting-room and gateway are the exception: they earn separation only if the product has a flash-sale-shaped spike (peak factor 50-100), because their job is to scale differently (3.8x per instance, [derived](../../services/waiting-room/RESULTS.md)) and to stay up while the core is saturated. Without that shape, a rate limiter is a library in the monolith and a waiting room is not built.

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
- [ ] Quarterly capacity and cost review with the trigger table; commit rate versus 1 627 budget (replace with your measured ceiling).
- [ ] Decision recorded for each postponed item: the number that triggers it and today's value.
- [ ] Deployment shape justified by team size and scaling ratios, not by fashion.

## Where this is proven in the repo / what is still paper

Proven (measured in the lab, laptop): cache effect and index effect on search ([catalog RESULTS.md](../../services/catalog/RESULTS.md)); commit-bound payments and idempotent retries ([payments RESULTS.md](../../services/payments/RESULTS.md)); the cost of a gateway hop and of fail-open versus hang ([gateway RESULTS.md](../../services/gateway/RESULTS.md), [failure-drills.md](../failure-drills.md)); queue per-instance capacity ([waiting-room RESULTS.md](../../services/waiting-room/RESULTS.md)); consumer scaling and exact dead-letter counts ([notifications RESULTS.md](../../services/notifications/RESULTS.md)); hold throughput under contention ([inventory RESULTS.md](../../services/inventory/RESULTS.md)).

Still paper: every stage's traffic, the 20% DAU ratio, the 300 RPS per instance, the sizing assumptions behind the cost table (the unit prices themselves are [public price, 2026-11-06]), the team-size thresholds ([folk]), the modular-monolith recommendation (no monolith version of this repo exists), and the production read and commit budgets (10 000 QPS is [folk]; 2 091 commits/s is one laptop run). Worked examples of other load shapes: [url-shortener](worked-scenarios/url-shortener.md), [feed-fanout](worked-scenarios/feed-fanout.md), [ledger](worked-scenarios/ledger.md), [event-ingestion](worked-scenarios/event-ingestion.md), [file-pipeline](worked-scenarios/file-pipeline.md); how the load shape selects the architecture: [workload-to-architecture.md](workload-to-architecture.md); consistency choices: [consistency-and-contention.md](consistency-and-contention.md); stores: [data-store-selection.md](data-store-selection.md); failure handling: [reliability-patterns.md](reliability-patterns.md).
