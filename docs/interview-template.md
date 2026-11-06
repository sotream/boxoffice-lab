# System-design interview template (45 minutes)

A plan you can run from memory. Time boxes add up to 45 minutes; the last minutes are slack for questions from the interviewer.

| Phase | Minutes | Output |
|---|---|---|
| 1. Requirements | 5 | Functional list, non-functional targets, explicit out-of-scope |
| 2. Estimation | 5-7 | Average and peak RPS, storage, instance count, one bottleneck named |
| 3. API and data model | 8 | 3-5 endpoints, tables or keys, the consistency-critical write |
| 4. High-level design | 8 | Boxes and arrows, the hot path traced end to end |
| 5. Deep dive | 12 | One or two components in depth, with a rejected alternative |
| 6. Bottlenecks and failure | 5 | What breaks first, what happens when a dependency dies |

## Phase 1: requirements (5 min)

Ask:
1. Who are the users and what is the one action that must never fail? (the core flow)
2. Which features are in scope for the next 40 minutes, which are out? Say the cut-off out loud.
3. Read-heavy or write-heavy? Is there a spike (launch, sale, news event) or a flat load?
4. How many users: total, daily active, concurrent at peak?
5. Consistency: may two users ever see different state? Is overselling, double charging or losing a message acceptable? (usually: never for money and inventory, yes for feeds and counters)
6. Latency target for the main path (p99), and availability target (99.9% = 8.8 h downtime per year).
7. Data retention and compliance (how long, where, deletion rights).

Write the answers in a corner of the board. Everything later refers back to them.

## Phase 2: estimation (5-7 min)

Ask: "Is a rough order-of-magnitude estimate fine? I will round aggressively." Then in order:
1. Traffic: DAU x actions per user / 86 400 = average RPS; multiply by the peak factor (3 normal, 10 evening spike, 50-100 flash sale).
2. Instances: peak / (per-instance RPS x 0.6).
3. Concurrency (Little's law): RPS x latency = requests in flight; this sizes pools.
4. Storage: records per day x bytes x 365 x years x replication.
5. Bandwidth and cache size if the design needs them.

Use `pnpm --filter @boxoffice/capacity calc -- <command>` while preparing; in the interview write the same one-line formulas by hand. See `numbers-to-know.md`.

### Stating assumptions out loud

Pattern: "I will assume X, because Y. If X is wrong by 10x, then Z changes." Examples:
- "I will assume 1M DAU and 10 searches each. If it is 100M, search needs its own cluster; I will note that and continue with 1M."
- "I assume a PSP call takes 100 ms and we cannot speed it up, so at 400 payments/s about 40 are in flight."

Rules: number plus reason plus what breaks if wrong; round (86 400 is 100k); never leave an assumption silent; ask for confirmation once, not after each number.

## Phase 3: API and data model (8 min)

Ask:
1. Which resources are there, and which call is the consistency-critical write?
2. Is the write idempotent? What is the idempotency key, and who generates it? (client, for payments)
3. Pagination style for lists (cursor over offset when data changes under the reader).
4. Which queries must the data model answer cheaply? Design indexes from queries, not from entities.
5. What is the unit of sharding or partitioning, if any? (the key every hot query includes)
6. Sync response or async with a status endpoint?

Write: endpoint list with verbs and status codes (409 for conflicts, 429 for rate limits, 202 for async), the main tables with primary keys and the one index that matters.

## Phase 4: high-level design (8 min)

Ask:
1. Where is the single source of truth for each piece of data?
2. Which calls are synchronous on the user's path, and which can be async (queue, outbox, events)?
3. Where does state live: stateless services plus a database, cache, queue?
4. Where is the edge: load balancer, rate limiter, CDN?

Trace the hot path once, left to right, narrating each hop and what it costs. Then trace one failure path.

## Phase 5: deep dive (12 min)

Pick the component where the requirements are hardest (the interviewer often steers; follow). Ask yourself and say aloud:
1. What are the 2-3 realistic options? Why is each right or wrong at this scale?
2. What is the failure mode of my choice, and how do I detect it?
3. What would make me change the decision? (a "revisit when" trigger)
4. Which number proves it? Quote a measurement if you have one, otherwise a stated estimate.

### The trade-off sentence

"I chose A over B because [requirement]; the cost is [downside], which is acceptable because [number or constraint]; I would revisit if [trigger]."

Example: "I chose a Postgres full-text search over Elasticsearch because search must be transactional with the event data and we are at 200k rows; the cost is weaker relevance tuning, acceptable because the cached path serves 10 275 RPS in our measurement; I would revisit if we need typo tolerance."

## Phase 6: bottlenecks and failure (5 min)

Ask:
1. What is the first thing to saturate as load grows 10x? (name the resource: DB connections, CPU, partitions, a third-party rate limit)
2. What happens if each dependency is down or slow? (timeouts, retries with backoff and jitter, circuit breaker, degrade)
3. What gets duplicated or lost on a retry or crash? (at-least-once plus idempotency)
4. How do we observe it? (RED metrics, queue lag, saturation, one alert per user-visible symptom)
5. What do we do about hot keys and thundering herds?

## What interviewers listen for at senior level

- You drive the structure and the clock; you do not wait to be asked.
- Requirements are negotiated and written down before drawing.
- Numbers justify decisions; estimates are rounded, consistent and sanity-checked.
- Every choice comes with the rejected alternative and a trigger to revisit.
- Correctness before speed: idempotency, ordering, consistency boundaries, no double spend.
- Failure is designed, not an afterthought: partial failure, retries, poison messages, compensation.
- Operational thinking: metrics, deploys, migrations, cost.
- Simplicity: you do not add Kafka, sharding or microservices without a number that demands it.
- You say "I do not know, I would measure it by..." instead of bluffing.

## Common traps

- Drawing boxes before requirements; solving an unstated problem.
- Designing for the average instead of the peak (a flash sale is peak factor 100+).
- Reaching for sharding or a search cluster at 1M rows.
- Holding a DB connection while waiting for an external call.
- Dual write (DB then publish) with no outbox; "exactly once" claims without idempotency.
- Caching without a TTL, invalidation story or jitter; ignoring the cold-start herd.
- Treating a rate limiter as the fairness mechanism (it only protects; a queue gives fairness).
- Quoting benchmark numbers without the setup (hardware, data size, contention).
- Silent assumptions; mixing bits and bytes; forgetting replication in storage.
- Spending 25 minutes on one box and never reaching failure handling.

## Index: classic question -> service -> ADR -> number to quote

Numbers are from each service's `RESULTS.md` (MacBook Air M1, everything on one machine, k6 on the same machine). Say "measured on a laptop" when you quote them; they are planning numbers, not production claims.

| Classic interview question | Service in this repo | ADR | Number to quote |
|---|---|---|---|
| Design a ticket booking system / prevent double booking | [inventory](../services/inventory) | [001-hold-strategy.md](../services/inventory/adr/001-hold-strategy.md) | 2 654 hold RPS, p99 31.7 ms (atomic UPDATE, low contention); the for-update variant reaches 2 182 RPS |
| Design a flash-sale / virtual waiting room | [waiting-room](../services/waiting-room) | [001-redis-sorted-set-queue.md](../services/waiting-room/adr/001-redis-sorted-set-queue.md) | 10 134 RPS per instance, p99 22.3 ms, ~100 B of Redis per queued user |
| Design a rate limiter / API gateway | [gateway](../services/gateway) | [001-token-bucket-redis.md](../services/gateway/adr/001-token-bucket-redis.md) | The hop costs 2 485 -> 2 001 RPS (about 19%) and about 4 ms p50; 0 oversell in the 2 000-user flash sale |
| Design a payment system (idempotency, no double charge) | [payments](../services/payments/) | [001-saga-over-2pc.md](../services/payments/adr/001-saga-over-2pc.md) (the file also holds ADR 002 outbox, 003 idempotency key, 004 timeouts and sweeper) | 561 RPS at 100 ms PSP latency, 904 RPS at 0 ms; 15 097 payments = 15 097 outbox rows = 15 097 published, 0 duplicate idempotency keys |
| Design a notification service | [notifications](../services/notifications) | [001-kafka-for-notifications.md](../services/notifications/adr/001-kafka-for-notifications.md) | 447 deliveries/s with 1 partition, 1 393/s with 3 (x3.1); 38 000 of 38 000 delivered, 0 duplicates, 10 dead letters = 10 poison messages |
| Design search (event, product, catalog) | [catalog](../services/catalog) | [001-postgres-fts-before-elasticsearch.md](../services/catalog/adr/001-postgres-fts-before-elasticsearch.md) | Ranked FTS 536 RPS; with Redis cache 10 275 RPS, p99 9.0 ms (19x); GIN is about 390x faster than ILIKE on rare terms |
| Design a message queue consumer / retry and DLQ | [notifications](../services/notifications) | same ADR | 38 180 provider calls = 38 000 + 90 flaky events x 2 retries |
| Saga vs two-phase commit | [payments](../services/payments/) | [001-saga-over-2pc.md](../services/payments/adr/001-saga-over-2pc.md) | Database is the limit: 3 commits per payment, Postgres ~243% CPU at 0 ms PSP (measured before the NestJS 12 / Fastify 5 upgrade, not repeated) |
| Cache design (TTL, stampede, sizing) | [catalog](../services/catalog) | [001-postgres-fts-before-elasticsearch.md](../services/catalog/adr/001-postgres-fts-before-elasticsearch.md) | Cache beats the better index for hot queries: ranked + cache 10 275 RPS vs 3 199 RPS for FTS by date uncached |
| Capacity estimation walk-through | every `services/*/CAPACITY.md` | n/a | Flash sale: 150 000 attempts / 60 s = 2 500 RPS, 2 instances at 0.6 headroom |
