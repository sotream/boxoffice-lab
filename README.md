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
  <img alt="PostgreSQL 17" src="https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white">
  <img alt="Redis 7" src="https://img.shields.io/badge/Redis-7-FF4438?logo=redis&logoColor=white">
  <img alt="Kafka API (Redpanda)" src="https://img.shields.io/badge/Kafka%20API-Redpanda-231F20?logo=apachekafka&logoColor=white">
  <img alt="k6" src="https://img.shields.io/badge/load%20tests-k6-7D64FF?logo=k6&logoColor=white">
</p>

<p align="center">
  <a href="docs/playbook/README.md"><b>Playbook</b></a> &middot;
  <a href="#architecture-and-the-flash-sale">Architecture</a> &middot;
  <a href="#question-service-decision-number">Services</a> &middot;
  <a href="docs/failure-drills.md">Failure drills</a> &middot;
  <a href="docs/numbers-to-know.md">Numbers to know</a> &middot;
  <a href="#quick-start">Quick start</a>
</p>

| 6 services | 5 failure drills | 5 worked scenarios | 4 evidence labels |
|:---:|:---:|:---:|:---:|
| inventory, waiting-room, gateway, payments, notifications, catalog | broker, cache, consumer, provider down or slow; DLQ replay | URL shortener, feed, ledger, ingestion, file pipeline (paper designs) | `measured` `derived` `folk` `paper design` |

## What this is

A design playbook for workload-driven architecture decisions, built as running code: given a shape of load, which pattern to use and at which number to switch. The reference scenario is a ticket box office with a flash sale: 20 000 seats, 50 000 users, one minute. Six small services (TypeScript, NestJS and Fastify) each prove one pattern, and each one carries requirements, a `CAPACITY.md` with formulas, ADRs with the rejected options, and a `RESULTS.md` with k6 measurements.

The layer above the services is the [playbook](docs/playbook/README.md): it maps workload shapes to architectures and trigger numbers, and it separates what was measured here from what is derived on paper or only a design sketch. It is written for someone who has to say "I would use X because of Y, and here is the number".

## The idea: numbers are derived and measured

Every capacity claim is done twice. First it is derived on paper from a few stated assumptions (`packages/capacity` holds the formulas). Then the service is load-tested and the measured figure is written next to the derived one. Where they disagree, the disagreement is written down, because that is where the lessons are.

<a id="architecture-and-the-flash-sale"></a>

![Architecture with measured numbers](docs/img/architecture.svg)

![Flash sale estimation chain](docs/img/flash-sale-math.svg)

The admission budget in the second picture is derived as 2 600 x 0.6 / 3 = 520 users/s (531 from the unrounded 2 654) and configured as 500, deliberately a little below the derived value. The 2 600 is the measured 2 654 hold RPS rounded down; rounded figures like this one are listed in [numbers-to-know](docs/numbers-to-know.md).

## Question, service, decision, number

| Design question | Service | Key decision | Measured number |
|---|---|---|---|
| How do you prevent double booking? | [inventory](services/inventory) | [One conditional `UPDATE ... WHERE free`, not check-then-write](services/inventory/adr/001-hold-strategy.md) | 2 654 hold RPS per instance (planned as 2 600), p99 31.7 ms; held seats equal successful holds, no oversell |
| 50 000 people open the page at once | [waiting-room](services/waiting-room) | [Redis sorted set, sequence as score](services/waiting-room/adr/001-redis-sorted-set-queue.md) | 10 134 RPS per instance (planned as 10 100), p99 22.3 ms, 100 to 150 B per queued user |
| Design a rate limiter | [gateway](services/gateway) | [Token bucket in Redis + Lua](services/gateway/adr/001-token-bucket-redis.md), [signed admission token](services/gateway/adr/001-token-bucket-redis.md) | 2 001 RPS through the gateway vs 2 485 direct (about 19% less) |
| Saga vs 2PC, safe retries, DB write plus event | [payments](services/payments) | [Orchestrated saga, outbox, idempotency key](services/payments/adr/001-saga-over-2pc.md) | 561 payments/s per instance at a 100 ms PSP (904 at 0 ms), Postgres-bound when last profiled (before the upgrade); 15 097 payments = 15 097 outbox rows = 15 097 published, 0 duplicate keys |
| Design a notification system | [notifications](services/notifications) | [Kafka log, at-least-once plus dedup key, DLQ](services/notifications/adr/001-kafka-for-notifications.md) | 1 393 deliveries/s on 3 partitions (447 on 1); 38 000 drained in 27.3 s; 0 duplicates |
| Design search; Postgres FTS vs Elasticsearch | [catalog](services/catalog) | [tsvector + GIN first, cache-aside in front](services/catalog/adr/001-postgres-fts-before-elasticsearch.md) | 10 275 RPS cached (p99 9.0 ms); 536 RPS ranked uncached; GIN about 390x faster than ILIKE on a rare term |

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

Requirements: Node 26 (the version the numbers were measured on and CI uses; the services run on NestJS 12 and Fastify 5), pnpm, Docker, [k6](https://k6.io) for the load scripts.

```bash
docker compose up -d      # Postgres :55432, Redis :56379, Redpanda :59092
pnpm install
pnpm -r test              # unit and integration tests of all packages
pnpm build                # compile; the load scripts run the compiled dist/
```

Service ports: gateway 3100, inventory 3101, waiting-room 3102, payments 3103, catalog 3104.

Load scripts (run from the service directory, after `pnpm build`):

| Service | Command |
|---|---|
| inventory | `cd services/inventory && load/run.sh` (starts the service itself and runs both strategies at low and hot contention) |
| catalog | `cd services/catalog && load/run.sh` (seeds 200 000 events, runs all six scenarios; needs the Redis container name `boxoffice-lab-redis-1`) |
| waiting-room | start with `node dist/main.js`, then `k6 run services/waiting-room/load/join.js` (`VUS`, `DURATION`, `BASE`) |
| payments | start with `node dist/main.js`, then `k6 run services/payments/load/pay.js` (`VUS`, `DURATION`, `BASE`) |
| gateway overhead | start inventory (3101) and gateway (3100), then `BASE=http://localhost:3101 k6 run services/gateway/load/overhead.js` and again with `BASE=http://localhost:3100` |
| gateway flash sale | start inventory with `SEED_SEATS=5000`, waiting-room, gateway, then `k6 run services/gateway/load/flash-sale.js` (`USERS`, `SEATS`, `BASE`, `ARRIVAL_SPREAD_S`, default 3) |
| notifications | `cd services/notifications && node load/bench.js` (needs postgres and redpanda up) |

Each service README lists the exact environment variables it reads; check the service `src/main.ts` if a run needs a different setup.

## Repository layout

```
services/
  inventory/      seat holds, confirm, availability (Postgres)
  waiting-room/   virtual queue (Redis)
  gateway/        rate limiter and admission-token check (Fastify, Redis)
  payments/       saga, idempotency, outbox relay (Postgres, Kafka)
  notifications/  consumer, dedup, retries, DLQ (Kafka, Postgres)
  catalog/        search, cache-aside (Postgres FTS, Redis)
  each with: README.md, CAPACITY.md, RESULTS.md, adr/, load/
packages/
  capacity/       the estimation formulas as code
  admission/      HMAC admission token shared by waiting-room and gateway
docs/             playbook/, numbers-to-know, interview-template, failure-drills, img/
docker-compose.yml
```

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

- Everything runs on one MacBook Air M1: server, Postgres, Redis, Redpanda and k6 share the machine, so the numbers are conservative and noisy.
- The figures are per-instance planning numbers for the capacity formulas, not production claims. Re-measure on target hardware.
- No multi-node setup was tested: no Redis failover, no Postgres replicas, no real network between services.
- OpenSearch/Elasticsearch was not run; the catalog ADR argues from its documented trade-offs, not from measurements.
- The gateway is plain Fastify standing in for Envoy or Kong; the PSP and email providers are fakes with fixed latency.
- Admission is a fixed budget, not adaptive to inventory latency.
