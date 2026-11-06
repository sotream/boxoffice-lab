# Reliability patterns: what each protects against, which number to choose

Dependencies fail in three ways: they die (fast errors), they slow down (the most common and the most damaging), or they return wrong or duplicate answers. Each pattern below covers one of these. For each: what it protects against, the parameter to choose and how to derive it, and where this repo shows it.

Labels on every number or claim:

- **[measured]** a figure from a RESULTS.md or drill in this repo, with the file path.
- **[derived]** computed from stated assumptions, arithmetic shown.
- **[folk]** a widely quoted ballpark, not measured here.
- **[paper design]** a design with no code in this repo.

Setup for all measured numbers: one MacBook Air M1, load generator on the same machine, so they are conservative per-instance numbers and not production claims. Related pages: [consistency and contention](consistency-and-contention.md), [scaling ladder](scaling-ladder.md), [workload to architecture](workload-to-architecture.md).

One fact to keep in mind while reading: the only timeout configured anywhere in this repo's service code is the gateway's Redis `commandTimeout: 200` (`services/gateway/src/main.ts`). A search for `connectionTimeout`, `statement_timeout`, `AbortSignal`, `idleTimeout` and `headersTimeout` in `services/*/src` finds nothing else. The Postgres pools, the PSP call, the payments-to-inventory `fetch` and the gateway upstream `fetch` have no explicit timeout. That is why the slow-dependency section at the end exists.

## Summary table

| Pattern | Protects against | Parameter | In this repo |
|---|---|---|---|
| Timeout | A slow dependency holding your resources forever | p99 x k, nested inside the caller's deadline | Redis 200 ms only; rest [paper design] |
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

**Which service would host it and what to measure.** `services/payments`: today the saga's DB transitions and the outbox relay share one pg pool of 20 (`app.module.ts` exports the `pool` that `main.ts` gives the relay), and the relay holds a connection while it publishes. A separate small pool for the relay, and a concurrency limiter around the PSP and inventory calls, are the bulkheads. Measure: pool wait time and pool in-use count per consumer, in-flight PSP calls.

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

Gaps: there is no DLQ replay tool and no alert on DLQ depth [paper design]; the ADR says operations replay after a fix. A `DeadLetter` event's payload is republished raw, so replay is a produce back to `payments`.

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

## The slow dependency (not yet drilled)

`docs/failure-drills.md` states it plainly: a slow (not dead) dependency is the most common real failure and is not drilled. All three drills break a dependency completely. A dead dependency fails fast and the repo handles it; a slow one holds resources, and no code here bounds that (see the timeout note at the top). The drills below are proposals [paper design]; none has been run and no result exists.

### Drill A: slow PSP (payments)

- Inject: `PSP_LATENCY_MS=2000` (and a second run with 5000) on payments; the knob exists in `services/payments/src/app.module.ts`. Load: `services/payments/load/pay.js`, 100 VUs.
- Observe: requests per second, p99, in-flight requests, pool in-use and pool waiting count, error rate, memory.
- Expected arithmetic [derived], using the planned 400 payments/s: in flight = 400 x 2 s = 800 and at 5 s = 2 000, versus 40 healthy. The pool should stay out of it because no connection is held during the PSP call (a claim in `services/payments/CAPACITY.md` that this drill would actually test). With k6's closed loop of 100 VUs the throughput is bounded by VUs / time per payment: the compensation path calls the PSP twice, so about 4 s per payment at 2 s latency and 100 / 4 = 25 RPS, against the measured 528 RPS at 100 ms [measured] `services/payments/RESULTS.md`. Expect clients to time out and retry with the same key, which exercises idempotency under pressure: watch that PSP charges still equal one per key.
- Pass criteria to decide in advance: no duplicate charges, no payments stuck in `CHARGED` that `resume` cannot finish, bounded memory.

### Drill B: slow Postgres (inventory)

- Inject: latency per query. There is no tool for this in the repo; a TCP latency proxy between the service and Postgres (toxiproxy or `tc netem`) would have to be added to `docker-compose.yml`. A cheaper approximation: hold row locks in a separate session so holds wait.
- Expected arithmetic [derived]: pool 20 and 200 ms per hold gives a ceiling of 20 / 0.2 = 100 holds/s per instance, against 2 500 offered at the flash-sale peak and 2 300 measured healthy. The excess queues in the pool. Whether it queues forever depends on node-postgres's default `connectionTimeoutMillis`, which I believe is 0 (wait indefinitely) but have not verified here; confirm in the `pg` documentation before relying on it. Requests then pile up in Node's memory, latency grows without bound, and clients time out while the server still processes the abandoned work.
- Observe: pool waiting count, event loop lag, memory, 5xx and client timeouts, and whether the gateway keeps admitting users.
- Fix candidates to evaluate afterwards: `connectionTimeoutMillis` on the pool, `statement_timeout`, a server-side queue bound that returns 503 early.

### Drill C: slow Redis (gateway)

- Inject: 150 ms of added latency (below the 200 ms timeout), then 250 ms (above it).
- Expected arithmetic [derived]: at 150 ms no timeout triggers, so fail-open never engages and every request pays the extra time: in flight = 1 742 x (0.0264 + 0.15) = about 307 versus 46 healthy. At 250 ms every limiter call times out after 200 ms: availability fails open after waiting 200 ms and holds return 503 after 200 ms, so the bounded cost per request is 200 ms plus the normal path. The point of the drill: a slow Redis is worse than a dead one for this design, because a dead one fails immediately (offline queue disabled) and fail-open or closed applies instantly, while a slow one makes the policy wait. Candidate fixes: a lower timeout, a circuit breaker around the limiter that skips it while OPEN.

### Drill D: slow broker (payments relay)

- Inject: delay Redpanda responses or pause the container for a few seconds (drill 2 stops it fully).
- Expected: `drainOnce` publishes inside an open transaction, so each relay holds one pool connection and its row locks for as long as `producer.send` takes. With one relay per instance and a pool of 20 that is 1 connection of 20 [derived from the code]; the payment path should be unaffected unless the relay's connection and locks interfere. Observe pool in-use, outbox backlog age and `drainOnce` duration.

What every drill must record: the same four numbers (rate, in flight, pool in-use and waiting, p99), because the lab's value is that its numbers are measured. Add results to a new row in the drills table in `docs/failure-drills.md`.

## Discrepancies noticed between repo documents

- Listen backlog: `services/gateway/RESULTS.md` reports "289 connection resets at the 2 000-connection burst", while `services/gateway/CAPACITY.md` says "~3.5% of joins fail". The two are not necessarily the same unit (resets over connections versus joins over total attempts) and I could not reconcile them from the files; the 289 figure is the one in the measured results.
- `docs/failure-drills.md` calls the 2 s hang "the client timeout"; it is the drill script's own `AbortSignal.timeout(2000)`, not a service setting.

## Where this is proven in the repo / what is still paper

Proven by code and measurement:
- Fail-open / fail-closed and fail-fast Redis client, drill 1: [gateway service](../../services/gateway/src/gateway.service.ts), [gateway main](../../services/gateway/src/main.ts), [gateway ADR](../../services/gateway/adr/001-token-bucket-redis.md), [failure drills](../failure-drills.md), [drill script](../../drills/redis-down.mjs).
- Admission control and rate limiting: [waiting-room CAPACITY](../../services/waiting-room/CAPACITY.md), [waiting-room RESULTS](../../services/waiting-room/RESULTS.md), [gateway RESULTS](../../services/gateway/RESULTS.md), [gateway CAPACITY](../../services/gateway/CAPACITY.md).
- Retry with full jitter, DLQ, lease: [handler](../../services/notifications/src/handler.ts), [consumer](../../services/notifications/src/consumer.ts), [RESULTS](../../services/notifications/RESULTS.md).
- Outbox surviving a broker outage, drill 2: [outbox relay](../../services/payments/src/outbox-relay.ts), [payments RESULTS](../../services/payments/RESULTS.md).
- Little's law helper: [packages/capacity](../../packages/capacity/src/index.ts).

Still paper (no code or no measurement here):
- Circuit breaker and bulkhead (only kafka-pay-lab has a breaker).
- Explicit timeouts on pools, PSP, inventory confirm and gateway upstream.
- Retry budget enforcement; outbound rate limiter toward the email provider.
- DLQ replay tool and DLQ depth alerting; adaptive admission rate.
- All four slow-dependency drills above; their expected numbers are derived, none measured.
- Not measured anywhere: Redis, Postgres and PSP latency percentiles in isolation, pool wait times.
