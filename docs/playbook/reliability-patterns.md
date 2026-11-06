# Reliability patterns: what each protects against, which number to choose

Dependencies fail in three ways: they die (fast errors), they slow down (the most common and the most damaging), or they return wrong or duplicate answers. Each pattern below covers one of these. For each: what it protects against, the parameter to choose and how to derive it, and where this repo shows it.

Labels on every number or claim:

- **[measured]** a figure from a RESULTS.md or drill in this repo, with the file path.
- **[derived]** computed from stated assumptions, arithmetic shown.
- **[folk]** a widely quoted ballpark, not measured here.
- **[paper design]** a design with no code in this repo.

Setup for all measured numbers: one MacBook Air M1, load generator on the same machine, so they are conservative per-instance numbers and not production claims. Related pages: [consistency and contention](consistency-and-contention.md), [scaling ladder](scaling-ladder.md), [workload to architecture](workload-to-architecture.md).

Status of timeouts: the first version of this playbook found that the only timeout in the service code was the gateway's Redis `commandTimeout: 200`. They were added afterwards, driven by drill 4 (slow PSP): Postgres pools (`connectionTimeoutMillis` 2 s, `statement_timeout` 5 s), gateway upstream calls 2 s (answered as 504), payments PSP and inventory-confirm steps 2 s (answered as 202 in-progress, finished by a sweeper), the outbox relay publish 5 s on its own pool, and the catalog cache degrades to the database when Redis fails. Still without a timeout: the provider call in notifications (`handler.ts`; the 30 s lease bounds recovery, not the call) and the waiting-room Redis client.

## Summary table

| Pattern | Protects against | Parameter | In this repo |
|---|---|---|---|
| Timeout | A slow dependency holding your resources forever | p99 x k, nested inside the caller's deadline | Pools, gateway upstream, PSP and confirm steps, Redis 200 ms; PSP case [measured] in drill 4 |
| Retry with backoff and jitter | Transient failures | attempts, base delay, budget | Notifications (full jitter, 4 attempts) |
| Circuit breaker | A failing dependency being hammered, your threads waiting on it | failure threshold, reset timeout | [paper design] here; exists in kafka-pay-lab |
| Backpressure | Producer faster than consumer | bounded queue, pull-based consumption | Kafka consumer batches, relay batch size |
| Load shedding | Demand above capacity | admission rate, limits | Waiting room, gateway 429 |
| Bulkhead | One dependency starving the others | pool size per dependency | [paper design] |
| Fail open / closed | Limiter or helper dependency down | policy per route | Gateway, drill 1 |
| Graceful degradation | Partial outage becoming total | which features to drop | Gateway availability, outbox |
| Idempotent retries | Retries causing duplicate effects | idempotency key | Payments, notifications |
| Dead-letter queue | One poison message blocking a stream | max attempts | Notifications `payments.dlq` |

## Timeouts

**Protects against.** A dependency that is slow, not dead. Without a timeout every caller waits as long as the dependency takes, and in-flight requests, sockets and pool connections pile up (Little's law, below).

**Parameter and derivation.** timeout = p99 of the dependency under realistic load x k, with k between 2 and 4 [folk], then check that it nests: client timeout > gateway upstream timeout > service-internal call timeouts, otherwise the outer caller gives up while inner work continues and then gets retried. The p99 values in this repo, with k = 3 as the stated assumption:

| Call | Measured p99 | Source | Timeout = p99 x 3 [derived] |
|---|---|---|---|
| hold, direct to inventory, atomic-update, low contention | 37.7 ms | `services/inventory/RESULTS.md` | 113 ms |
| availability direct to inventory | 44.9 ms | `services/gateway/RESULTS.md` | 135 ms |
| availability through the gateway | 63.0 ms | `services/gateway/RESULTS.md` | 189 ms |
| payment end to end, PSP 100 ms, saga on compensation path | 308 ms | `services/payments/RESULTS.md` | 924 ms |
| catalog search, common term, FTS date order | 52.7 ms | `services/catalog/RESULTS.md` | 158 ms |

Caveats: these p99s were measured with the load generator saturating one laptop, so they are inflated relative to an idle system and are a conservative starting point. The 3x factor is a folk rule, not a result. For the PSP the 100 ms is a fake (`FakePsp`, `PSP_LATENCY_MS`); a real timeout needs the real provider's p99, which this repo does not have. The inventory README states a goal of p99 below 100 ms for a hold; the derived 113 ms timeout is just above it, which is consistent.

The Redis value of 200 ms is a judgement, not derived from a measured Redis p99. For scale: the hop through the gateway (limiter round trip plus proxy) costs 26.4 - 20.8 = 5.6 ms at p50 [derived from `services/gateway/RESULTS.md`], so 200 ms is about 36 times a normal limiter call.

**Where shown.** `services/gateway/src/main.ts`: `enableOfflineQueue: false, commandTimeout: 200, maxRetriesPerRequest: 1`. Drill 1 (below) is the evidence of what the missing bound did before. kafka-pay-lab ADR 0008 uses a 1 second command timeout and one retry per command for the same reason (verified by reading it).

## Retry with exponential backoff and jitter

**Protects against.** Transient errors (a 503, a dropped connection). Without jitter, many clients retry at the same instants and re-overload the recovering dependency.

**Parameters and derivation.** Attempts, base delay, cap, and a retry budget. This repo uses 4 attempts and base 100 ms with full jitter: sleep = `random() x base x 2^(attempt-1)` (`withRetry` in `services/notifications/src/handler.ts`). The maximum waits are 100, 200 and 400 ms, so a message that exhausts its retries waits at most 700 ms in total [derived], 350 ms on average [derived, expectation of uniform draws]. This must stay far below the lease (30 s) so a retrying worker is not taken over.

Retry budget: retries multiply across layers. If three layers each make 3 attempts, one user request can become 3 x 3 x 3 = 27 calls to the bottom dependency [derived]. Rule of thumb: retry at one layer only, and cap retries to a fraction of traffic, such as 10% [folk]. Measured cost here: 38 180 provider calls for 38 000 deliveries, so retries added 180 calls = 0.47% [derived from `services/notifications/RESULTS.md`; 90 flaky events x 2 retries].

Only retry what is safe to repeat (next sections) and only on retryable errors; a permanent failure goes to the DLQ.

**Where shown.** Test "retries transient failures then succeeds" (`handler.test.ts`): email fails twice, third attempt succeeds, `attempts` column is 2. `services/notifications/load/bench.js` makes every 201st event's email fail twice. Contrast with kafka-pay-lab (verified in `apps/api/src/modules/payments/payment-retry.ts`): delay `retryBaseMs * 2 ** (attempt - 1)` with `PAYMENT_MAX_ATTEMPTS = 4` and `PAYMENT_RETRY_BASE_MS = 1000`, and no random term in the code I read, so it has backoff but no jitter.

## Circuit breaker [paper design here]

**Protects against.** A dependency that is failing or very slow: after N failures the caller stops calling it for a while, fails immediately, and frees its own resources, instead of every request waiting for a timeout.

**Parameter and derivation.** Failure threshold (consecutive failures or error rate over a window), reset timeout (how long to stay OPEN before one probe in HALF_OPEN). Derive the threshold from request rate: at 400 payments/s [CAPACITY], a threshold of 5 consecutive failures trips in about 12 ms of traffic, which is too jumpy for a noisy provider; an error-rate window (for example 50% of the last 20 calls) is steadier. The reset timeout should be longer than the dependency's typical recovery plus a few of your timeouts [folk].

**Which service would host it, and what to measure.** `services/payments`, around `psp.charge` and `psp.refund`, and around the `fetch` to inventory confirm in `app.module.ts`. When OPEN, the saga leaves the payment `PENDING` and answers "retry later" rather than holding a request open. Also a candidate in `services/gateway` around the upstream `fetch`. Measure first: error and timeout rate per dependency, in-flight count, and p99 per dependency, so the threshold is based on a baseline rather than a guess. The lab has none of these metrics yet.

**Sibling repo (verified by reading the code).** kafka-pay-lab `apps/api/src/modules/payments/circuit-breaker.ts` is a consecutive-failure breaker with CLOSED, OPEN and HALF_OPEN states, a single probe in HALF_OPEN, `failureThreshold` and `resetTimeoutMs` options, `CB_FAILURE_THRESHOLD = 5` as the default, and a spec file. Its payment processor sends exhausted messages to a DLQ topic through the outbox. Nothing equivalent exists in boxoffice-lab.

## Backpressure

**Protects against.** A fast producer overwhelming a slow consumer, which otherwise shows up as unbounded memory or queue growth.

**Parameter.** The bound: batch size, concurrency, queue length. Pull-based systems (Kafka consumer, DB polling) get backpressure for free because the consumer asks when ready.

**Where shown.**
- `services/notifications/src/consumer.ts` handles each batch in chunks of `concurrency` (25 by default) with `Promise.all`, commits offsets only after the chunk is handled, and does not fetch more until the batch is done. The consumer sets its own pace: [measured] 447 deliveries/s with one partition consumed and 1 393 with three (`services/notifications/RESULTS.md`).
- `OutboxRelay` takes at most `batch` rows (100) per drain and sleeps 50 ms when the outbox is empty (`services/payments/src/main.ts`).
- Not present: an outbound limiter toward the email provider. `services/notifications/CAPACITY.md` says providers throttle (typically 10 to 100 msg/s per account [folk]) and that a 630/s target needs an outbound token bucket or several accounts; no such code exists [paper design]. A provider 429 would be a retryable error with backoff.

## Load shedding and admission control

**Protects against.** Demand above capacity, where accepting everything makes every request slow and then fail. Shedding chooses who gets rejected, early and cheaply.

**Parameter and derivation.** The admission rate, from the protected capacity: `services/waiting-room/CAPACITY.md` computes admit/s = protected capacity x headroom / attempts per admitted user = 2 300 x 0.6 / 3 = about 460 users/s, configured as 500 [derived there, from the measured 2 300 hold RPS in `services/inventory/RESULTS.md`]. Drain time for 50 000 users is 50 000 / 500 = 100 s, the worst wait [derived].

**Where shown.**
- Waiting room as shedding by queueing: users are not rejected, they are ordered and admitted at a fixed rate. It costs far less than the protected resource: [measured] about 7 656 requests/s per instance for join plus status polls (`services/waiting-room/RESULTS.md`) against about 2 300 holds/s for inventory.
- Gateway: per-user token bucket 5/s burst 10, per-IP 50/s burst 100 (`services/gateway/CAPACITY.md`); a rejected request gets `429` with `Retry-After: 1` and never reaches inventory. Holds without a valid admission token get `403`. Tests: "forwards admitted holds and limits per user (burst 2, then 429)", "rejects holds without admission, never calling upstream".
- End to end [measured] `services/gateway/RESULTS.md`: 2 000 users join, wait for admission at 500/s, then try 3 seats out of 5 000: 3 530 ok + 2 470 conflicts = 6 000 attempts, 0 rate-limited, 0 admission timeouts, 0 failed requests; held seats in Postgres 3 530 equal successful holds, no oversell. Latency percentiles are deliberately not reported because the 2 000 VUs on one laptop dominate the timing.
- Limit of the design: the admission rate is a fixed budget, not adaptive; the waiting-room ADR names adaptive admission (watching inventory p99) as the next step [paper design].

## Bulkheads [paper design]

**Protects against.** One slow dependency consuming a shared resource (the connection pool, the worker threads) and starving unrelated work.

**Parameter and derivation.** A separate pool or concurrency cap per dependency, sized with Little's law: in flight = rate x latency (`concurrency()` in `packages/capacity`). Example from the repo: payments plans 400/s with a PSP of 100 ms, so 400 x 0.1 = 40 in flight [derived, `services/payments/CAPACITY.md`]; a PSP-only concurrency cap should therefore sit above 40 with headroom, for instance 60, and reject or queue beyond it, so a PSP slowdown cannot exhaust the process.

**Which service hosts it and what is still to measure.** `services/payments`: the outbox relay now has its own small pool (3 connections, `main.ts`), so a slow broker cannot take connections from the saga transitions (done, not yet drilled with a slow broker). Still paper: a concurrency limiter around the PSP and inventory calls. Measure: pool wait time and in-use count per consumer, in-flight PSP calls.

## Fail open vs fail closed

**Protects against.** A helper dependency (the limiter store) going down and taking the whole service with it. The question per route is: what is worse, serving without the check, or refusing?

**Decision rule.** Fail open when the guarded resource has its own protection and a wrong answer is cheap (a read). Fail closed when the guarded action spends something scarce or irreversible (a hold). Return the failure fast, with `Retry-After`, so clients back off.

**Where shown.** `services/gateway/src/gateway.service.ts`: availability reads fail open (the limiter result is replaced with `allowed: true`); holds, confirms and queue calls return `503` with `retry-after: 1`. Test: "limiter store down: public availability fails open, holds fail closed with a fast 503". ADR: `services/gateway/adr/001-token-bucket-redis.md`.

**Drill 1** [measured] `docs/failure-drills.md`: Redis stopped for 10 s under traffic on the gateway.
- v1: 100% errors for the whole outage, each request hung until the 2 s client timeout, because ioredis queues commands while offline.
- v2: 0 errors on availability; holds and queue calls return a fast 503. Change: fail-fast Redis client (no offline queue, 200 ms timeout) plus the per-route policy.
- ADR note: recovery after Redis returned needed no restart.
- The 2 s figure is the drill client's `AbortSignal.timeout(2000)` in `drills/redis-down.mjs`.

Sibling repo: kafka-pay-lab ADR 0008 fails open for the whole throttler and records the cost, that rate limits do not apply during an outage and credential stuffing is not slowed; it names fail-closed on the auth routes as the revisit option.

## Graceful degradation

**Protects against.** A partial outage turning into a total one. Decide in advance which features to drop.

**Where shown.**
- Gateway: availability keeps working with the limiter down (fail open).
- Payments: the broker is not on the payment's critical path. Drill 2 [measured]: Redpanda stopped while 300 payments are made: 300/300 payments OK in 0.7 s, 300 events buffered in the outbox, caught up 1.2 s after the broker returned, topic grew by exactly 300. No code change was needed.
- Catalog: stale results are a deliberate trade, event detail is invalidated on write, search results may age out (at most 36 s) (`services/catalog/adr/002`). Under pressure this is also a degradation lever: a longer TTL sheds database load.
- Waiting room ADR: if Redis fails, users re-join (the join is idempotent); order is lost, not money.

## Idempotent retries

**Protects against.** Retries (client, queue, relay) causing duplicate effects. Retrying is only safe on idempotent operations.

**Where shown.** The full treatment is in [consistency and contention](consistency-and-contention.md): payments idempotency key (50 concurrent identical requests charge once), notifications dedup by `(outbox_id, channel)`, the PSP called with the same key so a retry after a crash cannot charge twice. Retry-relevant numbers: `services/payments/load/pay.js` retries every 5th payment with the same key; after the run there were 0 duplicate keys across 8 874 payments [measured] `services/payments/RESULTS.md`.

## Dead-letter queues

**Protects against.** A message that can never succeed (invalid JSON, a permanently failing channel) blocking the partition or being retried forever.

**Parameter.** Max attempts before dead-lettering, and what is kept for diagnosis (the error, the original payload).

**Where shown.** `services/notifications/src/consumer.ts`: a `DeadLetter` or a `SyntaxError` is published to `<topic>.dlq` with the error in a header, then counts as handled so offsets move on. Measured [measured] `services/notifications/RESULTS.md`: 10 poison messages (invalid JSON) in a 21 010 event run produced exactly 10 dead letters. State is per channel, so a message whose email failed never re-sends the push that already succeeded (test "exhausted retries dead-letter, and a retry ... does not resend the channel that worked"). ADR: `services/notifications/adr/001-kafka-for-notifications.md` (ADR 003 there). Cost named in the ADR: no per-message ack or delay in Kafka, so retry, backoff and DLQ are application code (with SQS they would be configuration).

Replay: `services/notifications/src/replay-dlq.ts` republishes `<topic>.dlq` to the topic after the cause is fixed; drill 5 [measured] (`docs/failure-drills.md`): 200 dead letters while email was down, all 400 deliveries completed after replay, the push channel that had already worked was not resent, 0 duplicate rows. Gap [paper design]: no alert on DLQ depth, and the DLQ is not trimmed.

Sibling repo: kafka-pay-lab publishes a DLQ event through its outbox in the same transaction that marks a payment as dead-lettered (`apps/api/src/modules/payments/payment-processor.ts`), so the DLQ record cannot be lost either.

## Connection limits: the listen backlog lesson

Capacity also hides in the operating system. [measured] `services/gateway/RESULTS.md`: the first flash-sale run had 289 connection resets at the 2 000-connection burst. `services/gateway/CAPACITY.md` explains the cause as the default listen backlog and states the fix `backlog: 4096` (also applied in `services/waiting-room/src/main.ts` and `services/payments/src/main.ts`); it also notes the OS `somaxconn` accept queue is a real capacity limit, and recommends keep-alive and a load balancer. See the discrepancy note below about how that failure is quantified.

## Little's law: sizing pools and in-flight limits

in flight = rate x latency (`concurrency(rps, latencySeconds)` in `packages/capacity/src/index.ts`; CLI `concurrency --rps ... --latency-ms ...`).

| Case | Arithmetic | Source |
|---|---|---|
| Inventory holds at the flash-sale peak | 2 500 RPS x 0.02 s = 50 in flight, pool 20 per instance behind a pooler | `services/inventory/CAPACITY.md` [derived] |
| Payments in flight | 400 x 0.1 s = 40 concurrent payments; pool 20 is enough because no connection is held during the PSP call | `services/payments/CAPACITY.md` [derived] |
| Payments pool upper bound | If the pool was the limit at the measured 697 RPS, each payment held a connection for at most 20 / 697 = 28.7 ms | [derived] from `services/payments/RESULTS.md`; valid only if the pool was saturated, which the RESULTS file does not state |
| Gateway in flight, healthy | 1 742 RPS x 0.0264 s (p50) = 46 | [derived], p50 used as the mean, approximate |

Little's law is also the failure arithmetic: if latency grows 10x with the same arrival rate, in flight grows 10x, and a pool that was comfortable is exhausted.

## The slow dependency

A slow (not dead) dependency is the most common real failure: a dead one fails fast, a slow one holds resources. Drill 4 ([failure-drills](../failure-drills.md), `drills/slow-psp.mjs`) runs it for the PSP; drills B-D below are still proposals [paper design] with derived expectations and no results.

### Drill A: slow PSP (payments), done: drill 4

Setup: 300 payments, 100 clients, a held seat per payment, PSP latency raised at runtime (`POST /admin/psp`, enabled by `PSP_ADMIN=1`). Client abort at 15 s.

| | Before the timeouts | After (PSP step timeout 2 s) |
|---|---|---|
| PSP 20 s: what the client got | **300 of 300 client timeouts (15 s), no answer** | **300 x 202 in-progress at p50 2.09 s** |
| PSP 20 s: time until all payments final after the PSP recovered | 5.6 s | 3.2 s (sweeper, 10 in parallel) |
| PSP 3 s: what the client got | 300 x 200 CONFIRMED at p50 3.07 s | 300 x 202 in-progress at p50 2.07 s, finished later |
| DB connections active during the slow phase | 1 | 0 to 1 |
| Duplicate charges | 0 | 0 |

[measured] `drills/slow-psp.mjs`, laptop. Readings:
- The design claim in `services/payments/CAPACITY.md` is confirmed: no DB connection is held during the PSP call, so the pool never became the problem (1 active connection at 300 payments in flight).
- Without a timeout the harm is not the pool, it is that **the caller gets no answer** while the server keeps working on abandoned requests. A bounded wait plus a definite "accepted, not final" answer (202, retry with the same Idempotency-Key) fixes that.
- **The timeout is a trade-off, not free.** At PSP 3 s the old system answered every request correctly (just slowly), the new one with a 2 s step timeout turns every payment into the asynchronous path. The timeout must sit above the provider's p99 (for example 2-3 x p99, [folk]); a 2 s timeout is right only for a provider with a p99 well under 1 s.
- A timeout means **unknown outcome, not failure**. Treating a confirm timeout as "seats lost" would refund a sold seat. Payments therefore leaves the saga in `CHARGED`, and inventory's confirm is idempotent so the retry after a lost response succeeds (tests: "confirm timeout does NOT refund", "retry after a lost response is safe").
- The sweeper's throughput bounds recovery: sequential at 50 per sweep recovered 300 payments in 8.7 s, parallel by 10 in 3.2 s.

### Drill B: slow Postgres (inventory)

- Inject: latency per query. There is no tool for this in the repo; a TCP latency proxy between the service and Postgres (toxiproxy or `tc netem`) would have to be added to `docker-compose.yml`. A cheaper approximation: hold row locks in a separate session so holds wait.
- Expected arithmetic [derived]: pool 20 and 200 ms per hold gives a ceiling of 20 / 0.2 = 100 holds/s per instance, against 2 500 offered at the flash-sale peak and 2 300 measured healthy. The excess queues in the pool. Before the timeouts were added the pool waited indefinitely (node-postgres default `connectionTimeoutMillis` is 0, [folk], not verified here); the pools now fail after 2 s and statements after 5 s, which this drill would verify. Without them requests pile up in Node's memory, latency grows without bound, and clients time out while the server still processes the abandoned work.
- Observe: pool waiting count, event loop lag, memory, 5xx and client timeouts, and whether the gateway keeps admitting users.
- Already added, to be verified by this drill: `connectionTimeoutMillis` 2 s and `statement_timeout` 5 s. Still a candidate: a server-side queue bound that returns 503 early.

### Drill C: slow Redis (gateway)

- Inject: 150 ms of added latency (below the 200 ms timeout), then 250 ms (above it).
- Expected arithmetic [derived]: at 150 ms no timeout triggers, so fail-open never engages and every request pays the extra time: in flight = 1 742 x (0.0264 + 0.15) = about 307 versus 46 healthy. At 250 ms every limiter call times out after 200 ms: availability fails open after waiting 200 ms and holds return 503 after 200 ms, so the bounded cost per request is 200 ms plus the normal path. The point of the drill: a slow Redis is worse than a dead one for this design, because a dead one fails immediately (offline queue disabled) and fail-open or closed applies instantly, while a slow one makes the policy wait. Candidate fixes: a lower timeout, a circuit breaker around the limiter that skips it while OPEN.

### Drill D: slow broker (payments relay)

- Inject: delay Redpanda responses or pause the container for a few seconds (drill 2 stops it fully).
- Expected: `drainOnce` still publishes inside an open transaction, so the relay holds a connection and its row locks for as long as `producer.send` takes (bounded at 5 s by the publish timeout). Since the relay now has its own pool of 3 [derived from the code], the saga path should be unaffected. Observe the relay pool in-use, outbox backlog age and `drainOnce` duration.

What every drill must record: the same four numbers (rate, in flight, pool in-use and waiting, p99), because the lab's value is that its numbers are measured. Add results to a new row in the drills table in `docs/failure-drills.md`.

## Where this is proven in the repo / what is still paper

Proven by code and measurement:
- Fail-open / fail-closed and fail-fast Redis client, drill 1: [gateway service](../../services/gateway/src/gateway.service.ts), [gateway main](../../services/gateway/src/main.ts), [gateway ADR](../../services/gateway/adr/001-token-bucket-redis.md), [failure drills](../failure-drills.md), [drill script](../../drills/redis-down.mjs).
- Admission control and rate limiting: [waiting-room CAPACITY](../../services/waiting-room/CAPACITY.md), [waiting-room RESULTS](../../services/waiting-room/RESULTS.md), [gateway RESULTS](../../services/gateway/RESULTS.md), [gateway CAPACITY](../../services/gateway/CAPACITY.md).
- Retry with full jitter, DLQ, lease: [handler](../../services/notifications/src/handler.ts), [consumer](../../services/notifications/src/consumer.ts), [RESULTS](../../services/notifications/RESULTS.md).
- Slow PSP with timeouts, 202 in-progress and a sweeper (drill 4), DLQ replay (drill 5): [payments service](../../services/payments/src/payments.service.ts), [replay](../../services/notifications/src/replay-dlq.ts), [drill scripts](../../drills/).
- Outbox surviving a broker outage, drill 2: [outbox relay](../../services/payments/src/outbox-relay.ts), [payments RESULTS](../../services/payments/RESULTS.md).
- Little's law helper: [packages/capacity](../../packages/capacity/src/index.ts).

Still paper (no code or no measurement here):
- Circuit breaker and bulkhead (only kafka-pay-lab has a breaker).
- Timeouts on the notifications provider call and the waiting-room Redis client.
- Retry budget enforcement; outbound rate limiter toward the email provider.
- DLQ depth alerting; adaptive admission rate.
- Slow-dependency drills B-D above (slow Postgres, slow Redis, slow broker); their expected numbers are derived, none measured. Drill A (slow PSP) is done.
- Not measured anywhere: Redis, Postgres and PSP latency percentiles in isolation, pool wait times.
