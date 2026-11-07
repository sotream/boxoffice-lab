<h1 align="center">boxoffice-lab</h1>

<p align="center">
  <b>A design playbook for workload-driven architecture decisions, built as running code.</b><br>
  Given a shape of load: which pattern to use, and at which number to switch.
</p>

<p align="center">
  <a href="https://github.com/sotream/boxoffice-lab/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/sotream/boxoffice-lab/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node 26" src="https://img.shields.io/badge/Node-26-5FA04E?logo=nodedotjs&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white">
  <img alt="NestJS 12" src="https://img.shields.io/badge/NestJS-12-E0234E?logo=nestjs&logoColor=white">
  <img alt="Fastify 5" src="https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white">
  <img alt="PostgreSQL 18" src="https://img.shields.io/badge/PostgreSQL-18-4169E1?logo=postgresql&logoColor=white">
  <img alt="Redis 7" src="https://img.shields.io/badge/Redis-7-FF4438?logo=redis&logoColor=white">
  <img alt="Kafka API (Redpanda)" src="https://img.shields.io/badge/Kafka%20API-Redpanda-231F20?logo=apachekafka&logoColor=white">
  <img alt="k6" src="https://img.shields.io/badge/load%20tests-k6-7D64FF?logo=k6&logoColor=white">
</p>

<p align="center">
  <a href="docs/playbook/README.md"><b>Playbook</b></a> &middot;
  <a href="#proof-not-claims">Proof</a> &middot;
  <a href="#question-service-decision-number">Services</a> &middot;
  <a href="#architecture-and-the-flash-sale">Architecture</a> &middot;
  <a href="#quick-start">Quick start</a> &middot;
  <a href="docs/adr-index.md">ADRs</a> &middot;
  <a href="docs/failure-drills.md">Failure drills</a> &middot;
  <a href="docs/operations.md">Operations</a>
</p>


> **Status:** a learning and design lab, not a production system. Its known gaps are listed in [Limits of this lab](#limits-of-this-lab) and in [SECURITY.md](SECURITY.md).

| 6 services | 17 ADRs | 5 failure drills | 79 mutations, 79 killed | 5 paper designs |
|:---:|:---:|:---:|:---:|:---:|
| inventory, waiting-room, gateway, payments, notifications, catalog | [indexed with status](docs/adr-index.md) | broker, cache, consumer, provider down or slow; DLQ replay | [mutation check of the tests](docs/testing.md#mutation-check) | URL shortener, feed, ledger, ingestion, file pipeline |

## What this is

A design playbook for workload-driven architecture decisions, built as running code: given a shape of load, which pattern to use and at which number to switch. The reference scenario is a ticket box office with a flash sale: 20 000 seats, 50 000 users, one minute. Six small services (TypeScript, NestJS and Fastify) each prove one pattern. Each carries requirements, a `CAPACITY.md` with formulas, ADRs with the rejected options, a `RESULTS.md` with k6 measurements, and tests that attack the pattern's invariant. A shared package, `@boxoffice/platform`, gives every service the same health endpoints, metrics, JSON logs, trace context, config validation and graceful shutdown.

The layer above the services is the [playbook](docs/playbook/README.md): it maps workload shapes to architectures and trigger numbers, and it labels every figure as `measured`, `derived`, `folk` or `paper design`. It is written for someone who has to say "I would use X because of Y, and here is the number".

**In two minutes:** read the table [below](#question-service-decision-number) (question, service, decision, number), look at the [architecture picture](#architecture-and-the-flash-sale), then run `pnpm test` ([quick start](#quick-start)). Every number is either derived on paper from stated assumptions ([`packages/capacity`](packages/capacity/src/index.ts) holds the formulas) or measured by a load script whose raw output is saved in [`docs/load-output/`](docs/load-output/); where they disagree, the disagreement is written down.

## Proof, not claims

The headline claims are correctness claims, and each has a test that tries to break it. Details and the list of bugs these tests found: [docs/testing.md](docs/testing.md).

| Claim | How it is checked | Run |
|---|---|---|
| No seat is held or sold twice; confirm is all-or-nothing | fast-check model-based and concurrent tests against real Postgres (a property test found a `confirm` that sold part of a request while answering false) | `pnpm --filter @boxoffice/inventory test` |
| Admission is FIFO and nobody is admitted twice | model and happens-before properties against real Redis | `pnpm --filter @boxoffice/waiting-room test` |
| The rate limiter is exact and atomic across instances | Lua bucket compared with an exact model on a controllable clock; exact count under concurrency; 90-cell policy table for the gateway | `pnpm --filter @boxoffice/gateway test` |
| Admission tokens cannot be forged or re-spelled | tamper, truncation and canonical-form properties (a property test found malleable signatures) | `pnpm --filter @boxoffice/admission test` |
| The payments saga never double-charges, double-refunds or loses an event, whatever crashes | crash injected at 8 boundaries, a reusable PSP contract suite, model-based test with random crashes and 1 to 4 concurrent runners; `REFUNDING` is claimed before the refund ([ADR 005](services/payments/adr/005-claim-refund-before-issuing-it.md)) | `pnpm --filter @boxoffice/payments test` |
| Notifications are delivered at least once with no duplicate effects; poison messages never block a partition | random duplicates, redeliveries and flaky providers; the real consumer against a fake broker | `pnpm --filter @boxoffice/notifications test` |
| The cache never serves wrong data | TTL jitter bounds, unambiguous keys, input fuzz with no 5xx | `pnpm --filter @boxoffice/catalog test` |
| The tests themselves catch real breakage | a dependency-free mutation runner breaks the production code one way at a time and requires a named test to fail: 79 mutations in `scripts/mutations.json`, all killed (76 in one full run on 2026-11-08 and 3 more in an individual run after their `find` strings were made unique; 52 date from 2026-11-06, the rest cover payments and inventory authentication and signing, price, key scoping, the gateway routes and the pre-charge ownership check) | `pnpm test:mutation` (about 8 minutes, edits and restores source files) |
| The whole pipeline keeps its invariants, including through `kill -9` | `packages/e2e` starts the real built services as processes (private Postgres database, Redis logical DB and Kafka topic), runs a 300-user flash sale, the same sale with `kill -9` of payments and of the notifications consumer, and a limiter-overload storm, then reads the databases: no seat sold twice, sold seats equal confirmed payments, money conserved, one outbox event per payment, no duplicate deliveries, request id present end to end. A second, docker-based fault suite repeats the invariants through `kill -9` of inventory, gateway and waiting-room, Postgres paused and stopped, Redpanda stopped, Redis stopped and paused, hold expiry and two instances of gateway, payments and inventory, on private containers it creates and removes itself. Between them they found two bugs no unit test had: every real event was dead-lettered because the outbox id was a string, and `docker stop` of Postgres under load killed inventory (an unhandled `error` on a checked-out connection). Details and limits: [docs/e2e.md](docs/e2e.md) | `pnpm test:e2e` (about 2.5 minutes, needs Redpanda), `pnpm test:e2e:faults` (about 6 minutes, needs docker) |
| The system degrades the way the docs say | five failure drills with raw output saved in [`docs/drill-output/`](docs/drill-output/) | [docs/failure-drills.md](docs/failure-drills.md) |
| Alert rules and runbooks match the code | `pnpm ops:check` fails if an alert names a metric or label no service defines, or the metric table is stale | `pnpm ops:check` |

Coverage thresholds are set in the `vitest.config.ts` of every package except `packages/e2e` (payments is lower, 74% statements, because its HTTP and metrics layer is exercised by spawned processes that coverage does not see); CI runs `pnpm test:coverage` and `pnpm test:e2e`. The tests are correctness tests on one machine: they do not replace load tests, and they do not prove anything about multi-node behaviour.

<a id="architecture-and-the-flash-sale"></a>

![Architecture with measured numbers](docs/img/architecture.svg)

![Flash sale estimation chain](docs/img/flash-sale-math.svg)

The admission budget in the second picture is derived as 2 600 x 0.6 / 3 = 520 users/s (531 from the unrounded 2 654) and configured as 500, deliberately a little below the derived value. The 2 600 is the first measured hold RPS (2 654, MacBook Air M1, Postgres 17, before the metrics and logging of `@boxoffice/platform`) rounded down; rounded figures like this one are listed in [numbers-to-know](docs/numbers-to-know.md). The same formula on the final code gives very different values per machine ([benchmarks](docs/benchmarks.md), atomic-update at low contention, medians of 5 runs): about 342 users/s on a GitHub-hosted 4 vCPU runner (1 711 RPS), about 725 on a quieter M1 Air (3 624 RPS) and about 2 140 on an M4 Pro (10 679 RPS). So 500 users/s is an order-of-magnitude budget that happens to sit inside that range, not a property of the code: derive it on the target hardware.

## Question, service, decision, number

| Design question | Service | Key decision | Measured number |
|---|---|---|---|
| How do you prevent double booking? | [inventory](services/inventory) | [One conditional `UPDATE ... WHERE free`, not check-then-write](services/inventory/adr/001-hold-strategy.md) | 2 654 hold RPS per instance on the first version (planned as 2 600); on the final code 1 711 (runner), 3 624 (M1 Air) and 10 679 (M4 Pro) at low contention, so the level depends on the machine, see [benchmarks](docs/benchmarks.md) and [RESULTS](services/inventory/RESULTS.md); held seats equal successful holds, no oversell |
| 50 000 people open the page at once | [waiting-room](services/waiting-room) | [Redis sorted set, sequence as score](services/waiting-room/adr/001-redis-sorted-set-queue.md) | 10 134 RPS per instance (planned as 10 100), p99 22.3 ms, at most 140 B per queued user (planning figure 100 to 150 B) |
| Design a rate limiter | [gateway](services/gateway) | [Token bucket in Redis + Lua](services/gateway/adr/001-token-bucket-redis.md), [signed admission token](services/gateway/adr/001-token-bucket-redis.md#adr-002-signed-admission-token-instead-of-a-redis-lookup) | 2 001 RPS through the gateway vs 2 485 direct (about 19% less; single run each, within laptop run-to-run spread, not a stable cost) |
| Saga vs 2PC, safe retries, DB write plus event | [payments](services/payments) | [Orchestrated saga](services/payments/adr/001-saga-over-2pc.md), [outbox, idempotency key](services/payments/adr/001-saga-over-2pc.md#adr-002-transactional-outbox-not-write-db-then-publish), [refund claimed before it is issued](services/payments/adr/005-claim-refund-before-issuing-it.md) | 561 payments/s per instance at a 100 ms PSP (904 at 0 ms), Postgres-bound; **to be re-measured** (taken before the `REFUNDING` commit existed); 15 097 payments = 15 097 outbox rows = 15 097 published, 0 duplicate keys |
| Design a notification system | [notifications](services/notifications) | [Kafka log, at-least-once plus dedup key, DLQ](services/notifications/adr/001-kafka-for-notifications.md) | 1 393 deliveries/s on 3 partitions (447 on 1); 38 000 drained in 27.3 s; 0 duplicates |
| Design search; Postgres FTS vs Elasticsearch | [catalog](services/catalog) | [tsvector + GIN first, cache-aside in front](services/catalog/adr/001-postgres-fts-before-elasticsearch.md) | 10 275 RPS cached (p99 9.0 ms); 536 RPS ranked uncached; GIN about 390x faster than ILIKE on a rare term |

Numbers in this table are per-instance, from one MacBook Air M1 with the load generator on the same machine, on PostgreSQL 17 and before the platform instrumentation existed. They are planning figures, not production claims, and they have not been re-measured, except the inventory hold runs (final code, PostgreSQL 18, see above) and the repeated runs in [docs/benchmarks.md](docs/benchmarks.md) ([Limits](#limits-of-this-lab)). Every ADR with its status: [docs/adr-index.md](docs/adr-index.md).

## Capacity formulas

All use 0.6 as the default utilisation (headroom for GC, deploys, a lost node).

- average RPS = DAU x actions per user / 86 400
- peak RPS = average RPS x peak factor (about 3 on a normal day, 50 to 100 for a flash sale)
- instances = ceil(peak / (per-instance RPS x 0.6))
- concurrency (Little's law) = RPS x latency in seconds; sizes pools and connections
- storage = records per day x bytes x 365 x years x replication
- cache size: the hot 20% of the data serves about 80% of reads
- shards = ceil(peak writes / (writes per shard x 0.6))
- admission rate = protected capacity x headroom / attempts per admitted user
- drain time = users / admission rate; consumer throughput is about concurrency x partitions in parallel / (sender latency + DB time)

The full list with orders of magnitude is in [docs/numbers-to-know.md](docs/numbers-to-know.md). Code: [packages/capacity/src/index.ts](packages/capacity/src/index.ts).

More material: [docs/playbook/](docs/playbook/README.md) (workload shapes, scaling ladder, store selection, worked scenarios), [docs/interview-template.md](docs/interview-template.md) (how to structure a 45-minute design discussion) and [docs/failure-drills.md](docs/failure-drills.md) (what breaks and what you say about it).

## Quick start

Requirements: Node 26 (CI and the measurements use it), pnpm, Docker, [k6](https://k6.io) for the load scripts only.

```bash
docker compose up -d      # PostgreSQL 18 :55432, Redis 7 :56379, Redpanda :59092
pnpm install
pnpm build                # compile every package; services and load scripts run the compiled dist/
pnpm ops:check            # alert rules, runbooks and metric table agree with the code (no infrastructure needed)
pnpm test                 # all packages, one after another (they share one Postgres and one Redis)
pnpm test:e2e             # system-level end-to-end and chaos run, about 2.5 minutes, needs Redpanda (docs/e2e.md)
pnpm test:e2e:faults      # outages, crashes, hold expiry, two instances, on private docker containers, about 6 minutes (docs/e2e.md)
```

Run the system (one terminal each, after `pnpm build`; ports in the next table):

```bash
SEED_SEATS=20000 pnpm --filter @boxoffice/inventory start   # (re)creates 20 000 seats for event 1
pnpm --filter @boxoffice/waiting-room start
pnpm --filter @boxoffice/gateway start
pnpm --filter @boxoffice/payments start                     # needs Redpanda
pnpm --filter @boxoffice/notifications start                # needs Redpanda
SEED_EVENTS=1000 pnpm --filter @boxoffice/catalog start     # truncates and seeds catalog.events
```

A purchase through the gateway, including the payment (payments and inventory are internal: only the gateway calls them, and payments calls inventory, each with a request signature `x-internal-auth`; the `curl` calls below go through the gateway, a direct call to port 3101 or 3103 without a signature is 401):

```bash
curl -s -X POST localhost:3100/events/1/queue/join -H 'content-type: application/json' -d '{"userId":"alice"}'
curl -s 'localhost:3100/events/1/queue/status?userId=alice'      # {"state":"admitted","ttl":...,"token":"..."} within a moment
curl -s -X POST localhost:3100/events/1/holds -H 'content-type: application/json' -H "x-admission: $TOKEN" -d '{"seatIds":[1,2],"userId":"alice"}'
curl -s -X POST localhost:3100/events/1/pay -H 'content-type: application/json' -H "x-admission: $TOKEN" -H 'Idempotency-Key: k1' -d '{"userId":"alice","seatIds":[1,2]}'   # CONFIRMED; the price (2 x SEAT_PRICE_CENTS) is computed by payments
curl -s localhost:3106/readyz; curl -s localhost:3101/metrics | head
```

Optional: `docker compose --profile observability up -d prometheus grafana` starts Prometheus (127.0.0.1:59090, with the alert rules of [`ops/alerts.yml`](ops/alerts.yml)) and Grafana (127.0.0.1:53000) scraping the services on the host; see [docs/operations.md](docs/operations.md).

More: [docs/development.md](docs/development.md) (running one service, drills, load scripts, adding a test, a mutation, a metric or a service) and [docs/testing.md](docs/testing.md).

Load scripts (run from the service directory, after `pnpm build`; each service README lists its variables):

| Service | Command |
|---|---|
| inventory | `cd services/inventory && load/run.sh` (starts the service itself and runs both strategies at low and hot contention) |
| catalog | `cd services/catalog && load/run.sh` (seeds 200 000 events, runs all six scenarios; needs the Redis container name `boxoffice-lab-redis-1`) |
| waiting-room | start with `pnpm --filter @boxoffice/waiting-room start`, then `k6 run services/waiting-room/load/join.js` (`VUS`, `DURATION`, `BASE`) |
| payments | start with `pnpm --filter @boxoffice/payments start`, then `k6 run services/payments/load/pay.js` (`VUS`, `DURATION`, `BASE`) |
| gateway overhead | start inventory (3101) and gateway (3100), then `BASE=http://localhost:3101 k6 run services/gateway/load/overhead.js` and again with `BASE=http://localhost:3100` |
| gateway flash sale | start inventory with `SEED_SEATS=5000`, waiting-room, gateway, then `k6 run services/gateway/load/flash-sale.js` (`USERS`, `SEATS`, `BASE`, `ARRIVAL_SPREAD_S`, default 3) |
| notifications | `cd services/notifications && node load/bench.js` (needs postgres and redpanda up) |

Load scripts and drills write to the shared databases and stop containers: do not run them at the same time as the tests ([development.md](docs/development.md#troubleshooting-shared-database-races)).

## Ports and endpoints

| Service | Port | Business endpoints | Ops endpoints |
|---|---|---|---|
| gateway | 3100 | `/events/:id/queue/join`, `/events/:id/queue/status`, `/events/:id/availability`, `/events/:id/holds`, `/events/:id/confirm`, `POST /events/:id/pay` | none on 3100; ops endpoints on 3106 (`OPS_PORT`) |
| inventory | 3101 | `POST /events/:id/holds`, `POST /events/:id/holds/verify`, `POST /events/:id/confirm`, `GET /events/:id/availability` (all need `x-internal-auth`; internal, reached through the gateway and by payments) | same, no signature needed |
| waiting-room | 3102 | `POST /events/:id/queue/join`, `GET /events/:id/queue/status` | same |
| payments | 3103 | `POST /payments` (headers `Idempotency-Key` and `x-internal-auth`; internal, reached through the gateway's `/pay`), `POST /admin/psp` (only with `PSP_ADMIN=1`, also needs `x-internal-auth`) | same, no token needed |
| catalog | 3104 | `GET /search`, `GET /events/:id` | same |
| notifications | 3105 (`OPS_PORT`) | none: Kafka consumer | `/healthz` `/readyz` `/metrics` only |
| Postgres / Redis / Redpanda | 55432 / 56379 / 59092 | | |
| Prometheus / Grafana (profile `observability`) | 59090 / 53000, bound to 127.0.0.1 | | |

`/healthz` is liveness (never touches a dependency), `/readyz` is readiness (503 with a per-dependency body, or `shutting_down`), `/metrics` is Prometheus text. Details, SLOs, alerts and runbooks: [docs/operations.md](docs/operations.md). Request and response shapes: the "Endpoints" section of each service README.

## Environment variables

Each service validates its environment at start and exits with code 78 and one message listing every problem. With `NODE_ENV=production`, `ADMISSION_SECRET` must be set and must not be `dev-secret` (gateway and waiting-room refuse to start otherwise), and `PAYMENTS_INTERNAL_TOKEN` and `INVENTORY_INTERNAL_TOKEN` must be set and must not be `dev-internal-token` / `dev-inventory-internal-token` (gateway and payments; inventory for its own key). Per-service tables with defaults are in each service README; the main ones:

| Variable | Used by | Default |
|---|---|---|
| `PORT` | gateway, inventory, waiting-room, payments, catalog | 3100, 3101, 3102, 3103, 3104 |
| `OPS_PORT` | notifications, gateway | 3105, 3106 |
| `OPS_HOST` | gateway | `127.0.0.1` (ops port bind address; `0.0.0.0` in containers and for the `observability` profile) |
| `DATABASE_URL` | inventory, payments, catalog, notifications (via `@boxoffice/platform`) | `postgres://lab:lab@localhost:55432/lab` |
| `PG_POOL` | inventory, payments, catalog, notifications | 20 |
| `HOLD_SECONDS` | inventory | 600 (hold duration, validated >= 1) |
| `REDIS_URL` | gateway, waiting-room, catalog | `redis://localhost:56379` |
| `KAFKA_BROKER` | payments, notifications | `localhost:59092` |
| `INVENTORY_URL`, `QUEUE_URL`, `PAYMENTS_URL` | gateway (all three), payments (`INVENTORY_URL`) | `http://localhost:3101`, `http://localhost:3102`, `http://localhost:3103` |
| `ADMISSION_SECRET` | gateway, waiting-room (must match) | `dev-secret` (refused in production) |
| `PAYMENTS_INTERNAL_TOKEN` | gateway, payments (must match); the HMAC key of the request signature, never sent | `dev-internal-token` (refused in production) |
| `PAYMENTS_INTERNAL_TOKEN_PREVIOUS` | payments (optional) | unset; the previous key, accepted too while a rotation is in progress |
| `INVENTORY_INTERNAL_TOKEN` | gateway, payments (they sign with it), inventory (verifies; must match); a key of its own, separate from the payments one; never sent | `dev-inventory-internal-token` (refused in production) |
| `INVENTORY_INTERNAL_TOKEN_PREVIOUS` | inventory (optional) | unset; the previous key, accepted too while a rotation is in progress |
| `TRUST_PROXY` | gateway | empty: `x-forwarded-for` from clients is ignored; set the load balancer's addresses or CIDRs to use it |
| `IP_RATE` `IP_BURST` `USER_RATE` `USER_BURST` `UPSTREAM_TIMEOUT_MS` | gateway | 50, 100, 5, 10, 2000 |
| `ADMIT_PER_SECOND` | waiting-room | 500 |
| `PSP_LATENCY_MS` `PSP_FAIL_RATE` `PSP_TIMEOUT_MS` `CONFIRM_TIMEOUT_MS` `PSP_ADMIN` | payments | 100, 0, 2000, 2000, off |
| `SEAT_PRICE_CENTS` | payments | 5000 (price of one seat; the server computes the amount) |
| `CACHE_TTL` (seconds) | catalog | 30 |
| `SEED_SEATS`, `SEED_EVENTS` | inventory, catalog (seed at start, destructive for those tables) | 0 |
| `TOPIC` `GROUP_ID` `CONCURRENCY` `SENDER_LATENCY_MS` | notifications | `payments`, `notifications`, 25, 20 |
| `SHUTDOWN_DEADLINE_MS` `SHUTDOWN_DRAIN_DELAY_MS` | all services | 10000, 0 |
| `LOG_LEVEL` | all services | `info`, `silent` under tests |

## Repository layout

```
services/
  inventory/      seat holds, confirm, availability (Postgres)
  waiting-room/   virtual queue (Redis)
  gateway/        rate limiter, admission-token check, the only route to payments (Fastify, Redis)
  payments/       saga, idempotency, outbox relay, sweeper (Postgres, Kafka)
  notifications/  consumer, dedup, retries, DLQ (Kafka, Postgres)
  catalog/        search, cache-aside (Postgres FTS, Redis)
  each with: README.md, CAPACITY.md, RESULTS.md, adr/, load/ (and migrations/)
packages/
  platform/       shared: pool, JSON logger, trace context, metrics, health, shutdown, config validation
  capacity/       the estimation formulas as code and a CLI
  admission/      HMAC admission token shared by waiting-room and gateway
ops/              prometheus.yml, alerts.yml, grafana/, check.mjs (consistency check), overhead.mjs
scripts/          mutation-check.mjs, mutations.json
drills/           failure drills (node scripts)
docs/             playbook/, adr-index, operations, testing, development, failure-drills,
                  numbers-to-know, benchmarks, interview-template, img/, drill-output/, load-output/
docker-compose.yml, .github/workflows/ci.yml
```

CI (`.github/workflows/ci.yml`): Postgres 18 and Redis 7 as service containers, Redpanda started by hand, then `pnpm build`, `pnpm ops:check` and `pnpm test:coverage` (packages in sequence). A separate `automerge` job squash-merges Dependabot patch and minor PRs after the tests pass; majors are merged by hand.

## How to read this repo

1. [Playbook](docs/playbook/README.md): workload shape, what breaks first, pattern, trigger number, with an evidence label on every figure.
2. A service README: [inventory](services/inventory/README.md) is the shortest path to a full example.
3. Its ADRs ([index](docs/adr-index.md)): the options that were rejected and why.
4. Its `CAPACITY.md`: the derivation of the numbers from stated assumptions.
5. Its `RESULTS.md`: the measurement, with the setup and the disagreements with the derivation.
6. Then the proof ([testing](docs/testing.md), [failure drills](docs/failure-drills.md)) and the operation ([operations](docs/operations.md)).

## Lessons the measurements taught

- **Ranking cost is O(matches).** ORDER BY `ts_rank` on common terms ran at 536 RPS; ordering by a b-tree column ran at 3 199 RPS. An index does not help if you score every match. Rank only the top candidates or cache the result ([catalog](services/catalog/RESULTS.md)).
- **ILIKE vs GIN depends on the query.** On a rare term GIN full-text search was about 390x faster than an unindexed ILIKE (16 vs 6 230 RPS; no trigram index was tried). On common terms with a city filter and date order the gap was only 1.1x (3 199 vs 2 839 RPS, and the FTS p99 was higher, 75.4 vs 41.6 ms), because ILIKE stops early via the `(city, starts_at)` index.
- **A cache beats the better index** for hot queries: 19x the ranked query, p99 9 ms.
- **Benchmarks lie quietly.** The first catalog run compared different ORDER BYs and "proved" ILIKE was 7x faster; one run reported 8 400 RPS because an empty `city=` matched nothing. Both are kept in the catalog results as method notes.
- **Hot seats are faster per request.** Losers get an immediate 409 and no write happens. Measure successful holds, not only RPS ([inventory](services/inventory/RESULTS.md)).
- **The OS accept queue is a capacity limit, and it can fool a load test.** 2 000 simultaneous new connections showed up as `dial: i/o timeout` in k6 (96 failures in the saved instantaneous run, 96 to 944 across runs). On macOS `kern.ipc.somaxconn` is 128 and caps the queue whatever the app asks for; `backlog: 4096` alone did not fix it. It is a load-generator and OS artefact, so the scenario now spreads arrivals over 3 s (0 failures in two saved runs) and both variants are reported ([gateway](services/gateway/CAPACITY.md)).
- **Do not trust latency from an overloaded load generator.** 2 000 k6 VUs on the same laptop dominate the timings, so the gateway flash-sale run claims only correctness and counts.
- **The database is the payments limit, not Node.** At PSP latency 0 ms Postgres used about 243% CPU against 84% for Node (measured before the NestJS 12 / Fastify 5 upgrade, not repeated). Three commits per payment is the cost, and never hold a DB connection while waiting for the PSP ([payments](services/payments/RESULTS.md)).
- **Outbox relay is at-least-once.** A relay crash can publish twice, so consumers dedup by `outboxId`. The measured run had matching counts at every stage.
- **Consumer restart can stall a pipeline.** An in-flight duplicate threw inside a batch, the consumer crashed and restarted with a ~10 s backoff, and only 15k of 38k deliveries completed after 5 minutes. Fix: a short local retry.
- **"Row exists" is not a dedup lock.** 20 concurrent duplicates sent several emails until the claim became a lease ([notifications ADR](services/notifications/adr/001-kafka-for-notifications.md)).
- **Partitions bound consumer parallelism.** 1 partition 447/s, 3 partitions 1 393/s (x3.1).

## Limits of this lab

- Everything runs on one MacBook Air M1: server, Postgres, Redis, Redpanda and k6 share the machine, so the numbers are conservative and noisy. [docs/benchmarks.md](docs/benchmarks.md) repeats the runs (median, min, max) with `scripts/bench.sh` and has a manually dispatched workflow for a second environment (GitHub-hosted runner).
- Postgres: the compose file, CI and the full test suite run on PostgreSQL 18. The load figures in the `RESULTS.md` files and `CAPACITY.md` files were measured on PostgreSQL 17, before the metrics and logging of `@boxoffice/platform` existed, and have not been re-measured, except the inventory hold runs (final code, PostgreSQL 18) and the repeated runs in [docs/benchmarks.md](docs/benchmarks.md); each of those files says so at the top. The comparison between versions is an open item. The only measured cost of the instrumentation is a micro-benchmark on a route that does no work, 15 to 25% of throughput ([operations.md](docs/operations.md#overhead)); no service-level load run was repeated with it.
- Payments: the 561 and 904 payments/s figures were taken on the compensation path before the `REFUNDING` claim added a commit to it (ADR 005); they are marked to-be-remeasured in [payments CAPACITY](services/payments/CAPACITY.md).
- The figures are per-instance planning numbers for the capacity formulas, not production claims. Re-measure on target hardware.
- The SLO targets and alert thresholds in [operations.md](docs/operations.md) are proposals, not calibrated against production traffic. There is no tracing backend: trace ids are propagated and logged, spans are not exported.
- The mutation check covers inventory, waiting-room, gateway, admission, capacity, catalog, notifications and the payments saga, authentication and price (79 mutations); it deliberately does not mutate `packages/platform`, the service bootstraps (`main.ts`, `db.ts`, `app.module.ts`) and the gateway `app.ts`, which are wiring covered by the spawned-process tests.
- No multi-node setup was tested: no Redis failover, no Postgres replicas, no real network between services. The fault suite injects clean faults on single private nodes (process kill, container stop or pause); four scenarios put a TCP proxy (latency, silent partition, reset) on the inventory-to-Postgres, payments-to-inventory and gateway-to-Redis paths, but it does not cover packet loss, asymmetric partitions, disk full, clock skew or failover, and its two-instance scenario shares one fake PSP per process ([docs/e2e.md](docs/e2e.md#known-limits)).
- OpenSearch/Elasticsearch was not run; the catalog ADR argues from its documented trade-offs, not from measurements.
- Security: payments and inventory are reachable only with a request signed by a shared key (`x-internal-auth`: HMAC over timestamp, method, path and body, 30 s skew; a separate key for each callee), which is not mTLS and does not tell callers apart; the extra HMAC per inventory request was not benchmarked ([inventory ADR 002](services/inventory/adr/002-signed-internal-requests.md)); seat-hold ownership is checked before the charge ([ADR 007](services/payments/adr/007-verify-holds-before-charging.md)) but only as a snapshot, so an unknown answer or an expiry between check and confirm still ends in charge then refund. See [SECURITY.md](SECURITY.md) and [payments ADR 006](services/payments/adr/006-internal-authentication-and-server-side-price.md).
- The gateway is plain Fastify standing in for Envoy or Kong; the PSP and email providers are fakes with fixed latency.
- Admission is a fixed budget, not adaptive to inventory latency, and the admission tick serves event 1 only.
- Payments saga: a saga the sweeper can never finish is retried forever; there is no terminal `NEEDS_REVIEW` state or retry cap ([operations.md](docs/operations.md#known-gaps)).
- The waiting-room Redis client has no command timeout: a request that reaches it while Redis is gone hangs until Redis returns ([e2e.md](docs/e2e.md#what-a-redis-outage-loses-and-what-it-does-not-f4-f8)).
- `paymentId` is returned as a string in the HTTP answer and in events, because the outbox id is a string ([e2e.md](docs/e2e.md#findings)).

## How this was built

The repository was developed with an AI coding assistant (Claude Code), working under the author's direction: the author set the scope, the rules and the acceptance criteria; the assistant wrote most of the code and text, partly through parallel sub-agents (tests, operations, documentation, end-to-end suite). What this repository asks you to trust is therefore not who typed it but the evidence: property and model-based tests, a mutation runner that breaks the code and requires named tests to fail (79 mutations, all killed), a system-level end-to-end suite with `kill -9`, and three independent review passes whose findings are listed in [docs/testing.md](docs/testing.md#bugs-found-by-these-tests). Several of those bugs were found by the tests, not by reading the code. Commits carry no AI trailers by the author's choice (see `CLAUDE.md`); this section is the disclosure.

## License

[MIT](LICENSE)
