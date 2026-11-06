# boxoffice-lab

A system-design interview cheat sheet for senior engineers, built as running code. The scenario is a ticket box office with a flash sale: 20 000 seats, 50 000 users, one minute. Six small services (TypeScript, NestJS and Fastify) each answer a classic interview question, and each one carries requirements, a `CAPACITY.md` with formulas, ADRs with the rejected options, and a `RESULTS.md` with k6 measurements.

It is my own preparation material. It is written for someone who has to say "I would use X because of Y, and here is the number" in a 45-minute interview.

## The idea: numbers are derived and measured

Every capacity claim is done twice. First it is derived on paper from a few stated assumptions (`packages/capacity` holds the formulas). Then the service is load-tested and the measured figure is written next to the derived one. Where they disagree, the disagreement is written down, because that is where the lessons are.

![Architecture with measured numbers](docs/img/architecture.svg)

![Flash sale estimation chain](docs/img/flash-sale-math.svg)

The admission budget in the second picture is derived as 2 300 x 0.6 / 3 = 460 users/s and configured as 500.

## Interview question, service, decision, number

| Interview question | Service | Key decision | Measured number |
|---|---|---|---|
| How do you prevent double booking? | [inventory](services/inventory) | [One conditional `UPDATE ... WHERE free`, not check-then-write](services/inventory/adr/001-hold-strategy.md) | ~2 300 hold RPS per instance, p99 37.7 ms; held seats equal successful holds, no oversell |
| 50 000 people open the page at once | [waiting-room](services/waiting-room) | [Redis sorted set, sequence as score](services/waiting-room/adr/001-redis-sorted-set-queue.md) | ~7 600 RPS per instance, p99 27.8 ms, ~100 B per queued user |
| Design a rate limiter | [gateway](services/gateway) | [Token bucket in Redis + Lua](services/gateway/adr/001-token-bucket-redis.md), [signed admission token](services/gateway/adr/001-token-bucket-redis.md) | 1 742 RPS through the gateway vs 2 244 direct (about 22% less) |
| Saga vs 2PC, safe retries, DB write plus event | [payments](services/payments) | [Orchestrated saga, outbox, idempotency key](services/payments/adr/001-saga-over-2pc.md) | ~700 payments/s per instance, Postgres-bound; 8 874 payments = 8 874 outbox rows = 8 874 Kafka messages |
| Design a notification system | [notifications](services/notifications) | [Kafka log, at-least-once plus dedup key, DLQ](services/notifications/adr/001-kafka-for-notifications.md) | 1 393 deliveries/s on 3 partitions (447 on 1); 38 000 drained in 27.3 s; 0 duplicates |
| Design search; Postgres FTS vs Elasticsearch | [catalog](services/catalog) | [tsvector + GIN first, cache-aside in front](services/catalog/adr/001-postgres-fts-before-elasticsearch.md) | 15 236 RPS cached (p99 8.1 ms); 684 RPS ranked uncached; GIN 87x faster than ILIKE on a rare term |

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

More material: [docs/interview-template.md](docs/interview-template.md) (how to structure a 45-minute answer) and [docs/failure-drills.md](docs/failure-drills.md) (what breaks and what you say about it).

## Quick start

Requirements: Node 22, pnpm, Docker, [k6](https://k6.io) for the load scripts.

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
| gateway flash sale | start inventory with `SEED_SEATS=5000`, waiting-room, gateway, then `k6 run services/gateway/load/flash-sale.js` (`USERS`, `SEATS`, `BASE`) |
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
docs/             numbers-to-know, interview-template, failure-drills, img/
docker-compose.yml
```

## Lessons the measurements taught

- **Ranking cost is O(matches).** ORDER BY `ts_rank` on common terms ran at 684 RPS; ordering by a b-tree column ran at 4 387 RPS. An index does not help if you score every match. Rank only the top candidates or cache the result ([catalog](services/catalog/RESULTS.md)).
- **ILIKE vs GIN depends on the query.** On a rare term GIN was 87x faster (25 vs 2 177 RPS). On common terms with a city filter and date order the gap was only 1.8x, because ILIKE stops early via the `(city, starts_at)` index.
- **A cache beats the better index** for hot queries: 22x the ranked query, p99 8 ms.
- **Benchmarks lie quietly.** The first catalog run compared different ORDER BYs and "proved" ILIKE was 7x faster; one run reported 8 400 RPS because an empty `city=` matched nothing. Both are kept in the catalog results as method notes.
- **Hot seats are faster per request.** Losers get an immediate 409 and no write happens. Measure successful holds, not only RPS ([inventory](services/inventory/RESULTS.md)).
- **The connection backlog is a capacity limit.** 2 000 simultaneous new connections caused connection resets (289 in the gateway run, about 3.5% of joins) on the default listen backlog. `backlog: 4096` fixed it ([gateway](services/gateway/CAPACITY.md)).
- **Do not trust latency from an overloaded load generator.** 2 000 k6 VUs on the same laptop dominate the timings, so the gateway flash-sale run claims only correctness and counts.
- **The database is the payments limit, not Node.** At PSP latency 0 ms Postgres used about 243% CPU against 84% for Node. Three commits per payment is the cost, and never hold a DB connection while waiting for the PSP ([payments](services/payments/RESULTS.md)).
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
