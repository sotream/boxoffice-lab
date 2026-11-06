# Consistency and contention: which technique, and what proves it here

This page answers one question: many actors touch the same data (or the same side effect) at the same time, which technique keeps it correct, and what does it cost? Every technique below has the same five parts: the problem it solves, when to pick it over the others, its cost, its failure mode, and where this repo proves it.

Labels used on every number or claim:

- **[measured]** a figure from a RESULTS.md or drill in this repo, with the file path.
- **[derived]** computed from stated assumptions, arithmetic shown.
- **[folk]** a widely quoted ballpark, not measured here.
- **[paper design]** a design with no code in this repo.

Setup for all measured numbers: one MacBook Air M1, load generator and server on the same machine, so they are per-instance planning numbers and not production claims (see each RESULTS.md header). Related pages: [reliability patterns](reliability-patterns.md), [workload to architecture](workload-to-architecture.md), [scaling ladder](scaling-ladder.md), [data store selection](data-store-selection.md).

## Decision flowchart

```
What is contended?

1. One row (or one counter), the rule fits in a WHERE clause?
     yes -> conditional single-statement UPDATE ............ section 1
            (hold a seat, decrement stock, state transition)
     no  -> continue

2. Many rows touched together, all-or-nothing?
     -> can you always touch them in the same order (sort ids)?
          yes -> conditional UPDATE ... WHERE id = ANY(sorted ids), compare rowCount   (inventory does this)
                 or SELECT ... ORDER BY id FOR UPDATE then UPDATE                      section 3
          no  -> pessimistic lock with a global ordering rule, or one advisory lock
                 per aggregate .......................................... section 4 [paper design]

3. Read, think for a while (human, network call), then write the same row?
     low conflict rate  -> optimistic version column ................... section 2 [paper design]
     high conflict rate -> do not hold a lock while thinking: split into
                           "hold" (short, atomic) + "confirm" (short, atomic)       (inventory hold/confirm)

4. A side effect outside your database (charge a card, send an email)?
     -> idempotency key as a unique column + provider-side key ......... section 5
     -> several services involved? saga with compensation, not 2PC ..... section 6

5. A state change AND an event must both happen?
     -> transactional outbox ........................................... section 7
     -> consumers dedup on the outbox id (at-least-once) ............... section 8

6. Only one worker may do a job at a time, but workers crash?
     -> lease (claim with a timestamp, takeover after expiry) .......... section 9
     -> many relays on one table, no overlap wanted: FOR UPDATE SKIP LOCKED  (payments relay)

7. Nothing above fits (cross-database invariant, global uniqueness over a
   huge key space)? -> a serialisation point (single owner shard / queue per key),
   see scaling-ladder.md
```

## Anomalies and what prevents them

| Anomaly | Example in this domain | Prevented by | Proven here |
|---|---|---|---|
| Lost update | Two processes read `tokens=5`, both write `4`; or read status, then write | Single atomic statement or script (conditional UPDATE, Lua); compare-and-set on a state column | Gateway token bucket in one Lua script: 300 concurrent takes on a bucket of 100 allow between 100 and 101 (`services/gateway/src/gateway.test.ts`); payments `UPDATE ... WHERE id=$1 AND status=$2` (`payments.service.ts`) |
| Double spend / double booking | Two buyers hold seat 1 | Conditional UPDATE or FOR UPDATE, DB as arbiter | 100 concurrent holders on one seat, exactly 1 wins, both strategies (`services/inventory/src/inventory.test.ts`) |
| Double charge | Client retries a timed-out payment | Idempotency key as a unique column, plus the same key to the provider | 50 concurrent same-key requests, `psp.chargeCalls == 1`, one payments row (`services/payments/src/payments.test.ts`) |
| Phantom / oversell on a predicate | "at most N holds per event" enforced by `SELECT count(*)` then insert: two transactions both count N-1 and both insert | Lock a parent row or an advisory lock per event, or a counter row updated with a conditional UPDATE; SERIALIZABLE with retries as the heavy option | [paper design]. Inventory avoids the phantom class because each seat is its own row and the rule is a per-row predicate. |
| Deadlock | Request A locks seats 4,5; request B locks 5,4 | Global lock order (sort ids) | 40 concurrent holds in opposite order, one wins, no deadlock error (`inventory.test.ts`) |
| Duplicate event | Relay crashes after publish, before marking published; Kafka redelivers | Dedup key on the consumer side, at-least-once producer | `deliveries` PK `(outbox_id, channel)`; 20 concurrent deliveries of one event send once per channel (`services/notifications/src/handler.test.ts`) |
| Lost event | State committed, process dies before `producer.send` | Transactional outbox | Crash-after-confirm and broker-down tests; drill 2 (300/300 events arrive) |
| Duplicate concurrent processing | Two workers pick the same notification | Lease with takeover, `SKIP LOCKED` for table queues | Lease takeover test; two relays at once never publish the same row |
| Stuck claim after a crash | Worker dies holding a claim | Lease expiry | Drill 3: SIGKILL at 6 492 / 12 000, finished 12 000 / 12 000 in 33.6 s [measured] `docs/failure-drills.md` |

## 1. Conditional single-statement UPDATE

**Problem.** A check followed by a write has a gap between them. Moving the check into the WHERE clause of the write closes the gap, and the database row lock serialises the competing statements.

**When to pick it.** The rule is expressible as a predicate on the row being changed, and the work is one round trip. It is the default choice for "claim a scarce thing" and for state-machine transitions (`... WHERE status = $from`).

**Cost.** One round trip, row lock held only for the statement. Cannot do logic that needs values from other tables or an external call between check and write.

**Failure mode.** Forgetting to check the affected row count (a silent no-op). Multi-row versions need `rowCount == requested` and a rollback, otherwise you get a partial success.

**Where this repo proves it.**
- Code: `services/inventory/src/inventory.service.ts`, `holdAtomic`: `UPDATE seats SET status='held', ... WHERE event_id=$1 AND seat_id = ANY($2) AND (status='free' OR (status='held' AND hold_until < now())) RETURNING hold_until`, then `if (res.rowCount !== ids.length) ROLLBACK`. Expiry is lazy: an expired hold counts as free inside the WHERE, so there is no sweeper job. ADR: `services/inventory/adr/001-hold-strategy.md`.
- Tests (`services/inventory/src/inventory.test.ts`, run for both strategies): "never double-books one seat under 100 concurrent holders" (exactly 1 ok), "is all-or-nothing for multi-seat holds" (`[1,2]` ok, `[2,3]` fails, 18 of 20 seats still free), "expired holds become free again", "only the holder can confirm, and not after expiry".
- Same idea in payments: `transition()` runs `UPDATE payments.payments SET status=$3 WHERE id=$1 AND status=$2` and inserts the outbox row only if `rowCount === 1`. Test "crash after confirm: resume does not duplicate the event" calls `resume` twice and expects exactly one `payment.confirmed` outbox row.
- Numbers [measured] `services/inventory/RESULTS.md` (pool 20, 50 VUs, 20 s):

| Strategy | Contention | RPS | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|
| atomic-update | low (100k seats) | 2359 | 20.3 | 28.8 | 37.7 |
| atomic-update | hot (20 seats) | 2780 | 17.1 | 24.8 | 30.7 |
| for-update | low (100k seats) | 1924 | 25.0 | 35.7 | 46.3 |
| for-update | hot (20 seats) | 2834 | 16.8 | 23.7 | 30.7 |

  Reading from the same file: hot seats are faster per request because losers get an immediate 409 and no write happens, so measure the rate of successful holds too (this run does not report it). At low contention atomic-update is 2359 vs 1924 RPS: 1 - 1924/2359 = 18.4% [derived], which matches the "~18%" in the ADR. At hot contention the two strategies are within 2% (2780 vs 2834) and for-update is nominally higher; with a single run per cell that difference is noise, not a result.
- Caveat on lock order: `holdAtomic` sorts the ids in JavaScript before the statement, but an `UPDATE ... WHERE seat_id = ANY(...)` has no `ORDER BY`, so the order in which Postgres locks the rows is up to the plan. The opposite-order test passes (40 concurrent holds, one winner), but that is evidence for the tested plan, not a guarantee. `holdForUpdate` uses an explicit `ORDER BY seat_id FOR UPDATE`.

## 2. Optimistic locking (version column) [paper design]

**Problem.** A user (or a long computation) reads a row, works for seconds, then writes. You do not want to hold a lock during the work, and conflicts are rare.

**When to pick it.** Low conflict probability per row, read-modify-write spread over time (edit forms, profile updates, admin screens). Not for hot rows: under heavy contention most attempts fail and retry, wasting work.

**Cost.** One extra column, a retry or a "someone else changed this" message in the client. No lock waits.

**Failure mode.** Retry storms on hot rows (livelock-like behaviour: everyone retries, one wins per round). Forgetting to bump the version in one code path silently disables protection.

**Where this repo proves it.** Nowhere: there is no `version` column in this repo. The nearest thing is a compare-and-set on a state column (`WHERE status = $from` in payments, `WHERE status='free' OR expired` in inventory), which is the same idea with the state acting as the version. Untested sketch:

```sql
-- [paper design], UNTESTED. Add: version int NOT NULL DEFAULT 0
-- 1. read:  SELECT seat_id, status, version FROM seats WHERE ...;  (app remembers version = 7)
-- 2. write:
UPDATE seats SET status = 'held', held_by = $user, version = version + 1
WHERE event_id = $1 AND seat_id = $2 AND version = 7;
-- rowCount = 0 -> somebody changed it: reload and retry or tell the user.
```

Why inventory does not use it: a seat is contended by thousands of buyers within a minute, so the conflict rate is the normal case; a one-statement predicate avoids the read round trip altogether.

## 3. Pessimistic locking (SELECT ... FOR UPDATE), with lock ordering

**Problem.** You must read, decide using several rows or application logic, then write, and conflicts are likely, so you take the lock first.

**When to pick it.** The decision needs data you cannot put in a WHERE clause (values from several rows, a computation), and the critical section is short and stays inside the database. Over the conditional UPDATE only when the single-statement form cannot express the rule.

**Cost.** Two round trips and locks held across them. Measured here: 1924 vs 2359 RPS at low contention, 18.4% less (table above).

**Failure mode.** Deadlock when two transactions lock the same rows in different orders; lock pile-ups if anything slow (an HTTP call) runs while locks are held; idle-in-transaction connections exhausting the pool.

**Where this repo proves it.**
- Code: `holdForUpdate` in `services/inventory/src/inventory.service.ts`: `SELECT seat_id FROM seats WHERE ... ORDER BY seat_id FOR UPDATE`, check the count, then `UPDATE`. Ids are de-duplicated and sorted before either strategy runs (`[...new Set(seatIds)].sort((a, b) => a - b)`).
- Test: "does not deadlock on overlapping seat sets in opposite order": 40 concurrent holds, half `[4,5]`, half `[5,4]`; exactly 1 succeeds and none throws (`inventory.test.ts`, both strategies). ADR: "Seat ids are sorted before locking so two requests for `[4,5]` and `[5,4]` cannot deadlock (tested)".
- Design rule: never call out of the database while holding the lock. Payments follows it from the other side: it opens a transaction only for the state change, so a pool of 20 serves 40+ in-flight payments (`services/payments/CAPACITY.md`).
- Not tested: a test that proves the deadlock exists without the sort. The test shows absence of the failure with the sort, not that it would fail without it.

## 4. Advisory locks [paper design]

**Problem.** You need mutual exclusion on something that is not a row: "only one process may rebalance event 42", "one cron instance", "serialise all writes for this tenant", or a lock across several tables with one key.

**When to pick it.** Coordination inside one Postgres instance, short critical sections, no lock table wanted. Transaction-scoped (`pg_advisory_xact_lock`) releases automatically at commit or rollback; prefer it over session-scoped locks, which leak when a pooler reuses the connection.

**Cost.** Lock keys are 64-bit integers you must map from names (hash collisions are possible and harmless but cause needless waiting). Locks are per database instance, so they do not survive failover to a different design (they do move with a replica promotion, but held locks are lost).

**Failure mode.** Session-level locks with transaction-mode connection poolers (the lock stays on a connection another client then uses). Waiting forever with no `lock_timeout`.

**Where this repo proves it.** Nowhere: no advisory lock is used. Untested sketch:

```sql
-- [paper design], UNTESTED
BEGIN;
SELECT pg_try_advisory_xact_lock(hashtextextended('event:' || $1::text, 0)) AS got;
-- got = false -> another worker owns this event: return, or retry later
-- got = true  -> do the work; the lock is released at COMMIT / ROLLBACK
COMMIT;
```

For "only one worker per job" with crash recovery this repo uses a lease (section 9) and `SKIP LOCKED` (section 7), not an advisory lock.

## 5. Idempotency keys (unique-column approach)

**Problem.** A client, a queue or a relay may repeat a request. The effect (a charge) must happen once while every repetition gets a sensible answer.

**When to pick it.** Any operation exposed to retries whose effect cannot be undone cheaply: payments, order creation, emails. Pick the unique column over a Redis `SETNX` lock when the result lives in the same database anyway: one system decides.

**Cost.** One unique index and one stored row per key; keys need a retention policy. The key must be chosen by the caller (so a retry reuses it).

**Failure mode.** Same key with a different body (the repo does not detect this; the sibling lab below does). A key stored before the work finishes leaves an "in progress" state that needs handling. The provider call also needs the key, otherwise a crash between charge and record double charges.

**Where this repo proves it.**
- Code: `PaymentsService.pay` in `services/payments/src/payments.service.ts`: `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id, status`; zero rows inserted means "seen before", so it reads the stored row and returns `done` (final status) or `in-progress`. The same key is passed to `psp.charge`. Schema: `idempotency_key text NOT NULL UNIQUE` in `services/payments/migrations/001_init.sql`. ADR 003 (in `services/payments/adr/001-saga-over-2pc.md`, which holds ADRs 001 to 003) rejects Redis `SETNX` as a lock because it adds a second system whose failure semantics must match the database's.
- Tests (`services/payments/src/payments.test.ts`): "idempotency: 50 concurrent requests with one key charge exactly once" (`chargeCalls == 1`, one payments row, a later retry returns CONFIRMED without charging); "crash after charge: resume finishes the saga and does not double charge" (status stays CHARGED after the crash, `resume` ends CONFIRMED, `psp.charges.size == 1`).
- Measured [measured] `services/payments/RESULTS.md`: every 5th payment is retried with the same key; after the run payments rows 8 874, outbox rows 8 874, published 8 874, Kafka high watermark 8 874, duplicate idempotency keys 0.
- Not tested: a crash between `psp.charge` returning and the `PENDING -> CHARGED` commit. The state would still be PENDING, and `resume` would call `psp.charge` again with the same key; correctness then depends on the PSP honouring the key (the `FakePsp` does, `psp.ts`). Concurrent losers get `in-progress` immediately and do not wait for the winner.
- Sibling repo (verified by reading it): kafka-pay-lab `docs/adr/0015-client-idempotency-keys.md` stores the key plus a SHA-256 fingerprint of the body on the payments row with a partial unique index, returns 422 for the same key with a different body, and lets the unique index serialise concurrent requests instead of returning 409.

## 6. Saga vs two-phase commit

**Problem.** One business operation spans systems that cannot share a transaction (a payment provider, another service's database).

**When to pick it.** Saga whenever any participant is external or owned by another team. 2PC only inside one trust and operations boundary with a real coordinator and short-lived locks, which is rare outside a single database cluster.

**Cost.** Saga: you design compensations, tolerate intermediate states (CHARGED but not yet CONFIRMED), and make every step idempotent. 2PC: locks held across network calls, and everything blocks if the coordinator dies.

**Failure mode.** Saga: a missing compensation leaves money or inventory stranded; ordering that sells goods before the money is safe. 2PC: coordinator failure blocks participants.

**Where this repo proves it.**
- Decision: `services/payments/adr/001-saga-over-2pc.md`: charge first, then confirm seats, refund if confirm fails. The reverse order "would sell seats for money we may never collect". The cost of this order is a refund when the 10-minute hold expired mid-payment. Orchestration over choreography because the service owns the state machine and each step can be crash-tested.
- Code: state machine `PENDING -> CHARGED -> CONFIRMED | REFUNDED | FAILED` in `payments.service.ts`; `crashAt` test hook; `resume(id)` continues from stored state.
- Tests: happy path (one `payment.confirmed` outbox row), "compensates: hold expired -> refund" (refunds.size 1, one `payment.refunded`), "failed charge ends FAILED and never touches inventory" (confirms == 0).
- 2PC itself: [paper design], rejected in the ADR, no code.

## 7. Transactional outbox

**Problem.** A state change and the event announcing it must both happen or neither. A dual write (UPDATE then `producer.send`) loses the event if the process dies between them; publishing inside the transaction lets commit and publish disagree.

**When to pick it.** Any service that changes its database and tells others. Pick CDC (Debezium) over a polling relay when the polling delay or write load of the relay matters; ADR 002 names CDC as the production upgrade.

**Cost.** Delivery becomes at-least-once; polling delay about 50 ms in this repo (the relay sleeps 50 ms when empty, `src/main.ts`); an extra insert per transition; published rows need pruning.

**Failure mode.** Duplicates after a relay crash between publish and `UPDATE ... published_at`. Outbox table growth if never pruned. Ordering is by outbox `id`, which only matches commit order approximately under concurrent writers.

**Where this repo proves it.**
- Code: `transition()` inserts the outbox row in the same transaction as the status change. `OutboxRelay.drainOnce` in `services/payments/src/outbox-relay.ts` selects `WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, publishes, then sets `published_at`, all inside one transaction. Partial index `outbox_unpublished ... WHERE published_at IS NULL`.
- Tests: "publishes each row once per successful drain and marks it" (5 rows, drain returns 5 then 0); "a broker failure keeps rows unpublished (at-least-once, retry later)"; "two relays at once never publish the same row (SKIP LOCKED)": 40 payments, two relays with batch 10 and a 30 ms publish delay, `a + b == 20` and all published ids unique.
- Drill 2 [measured] `docs/failure-drills.md`: broker stopped while 300 payments are made: 300/300 payments OK in 0.7 s, 300 events buffered in the outbox, caught up 1.2 s after the broker returned, topic grew by exactly 300.
- Bottleneck [measured] `services/payments/RESULTS.md`: at PSP 0 ms, 697 RPS; Postgres container about 243% CPU with LWLock waits, payments Node about 84% CPU. The limit is the database: 3 commits per payment (insert, `PENDING -> CHARGED`, final state with the outbox row) plus inventory's confirm. The file's suggested next step is to collapse transitions that need no durability between them, or use `synchronous_commit=off` for the intermediate step. Commit count per business operation is the number to watch: [derived] at the planned 400 payments/s, 400 x 3 = 1 200 commits/s (`services/payments/CAPACITY.md`).
- Detail worth knowing: the relay holds its row locks and a pool connection while it publishes (the publish happens inside the open transaction). A slow broker therefore holds one connection per relay; see the slow-dependency section in [reliability patterns](reliability-patterns.md). (Update: the relay now runs on its own 3-connection pool and the publish has a 5 s timeout, so a slow broker cannot starve the saga.)
- Sibling repo: kafka-pay-lab has the same shape (`apps/api/src/infrastructure/outbox/outbox-relay.ts`: pessimistic write lock with `skip_locked`, batch of 50, "at-least-once ... consumers must be idempotent").

## 8. At-least-once delivery plus dedup

**Problem.** Exactly-once delivery to an external system does not exist: if the process dies after the provider accepted the email but before `SENT` is recorded, you cannot know. You choose between losing and duplicating.

**When to pick it.** At-least-once when a lost message is worse than a rare duplicate ("your tickets are confirmed"). At-most-once when a duplicate is worse (rarely). Then make duplicates harmless with a dedup key.

**Cost.** A dedup table keyed by the event id, a retention policy (rows older than the provider's idempotency window can go), and one extra statement per delivery.

**Failure mode.** Dedup by "row exists" is not exclusive under concurrency (see bug 2 below). A crash after the provider accepted but before `SENT` is recorded still produces one duplicate after lease takeover.

**Where this repo proves it.**
- Code: `NotificationHandler.handle` in `services/notifications/src/handler.ts`; PK `(outbox_id, channel)` on `notifications.deliveries`; the provider receives `outboxId:channel` as its idempotency key.
- Tests (`handler.test.ts`): "dedup: 20 concurrent deliveries of one event send once per channel" (`n == 2`, each call either completes or is told `InFlight`, never an error; the redelivery then skips both channels); "serial duplicates are skipped"; "exhausted retries dead-letter, and a retry of the message does not resend the channel that worked".
- Measured [measured] `services/notifications/RESULTS.md`, 21 010 events (20 000 unique, 1 000 duplicate deliveries, 10 poison): deliveries sent 38 000 of 38 000 expected; duplicate `(event, channel)` rows 0; provider calls 38 180 = 38 000 + 90 flaky events x 2 retries, so the 1 000 duplicate deliveries cost no extra provider calls; dead letters 10 = exactly the poison messages.
- Drill 3 [measured] `docs/failure-drills.md`: consumer SIGKILLed at 6 492 / 12 000 deliveries; restart finished 12 000 / 12 000, 0 duplicate rows, 0 stuck rows, 33.6 s because 25 claims were mid-send and wait out the 30 s lease.

## 9. Leases

**Problem.** One worker must own a unit of work at a time, but workers die without releasing anything.

**When to pick it.** Per-item ownership with automatic recovery: claims on notifications, job rows, leader election with a heartbeat. Use `SKIP LOCKED` instead when a transaction can span the whole job and a crash simply aborts it (the payments relay).

**Cost.** Recovery time equals the lease length: drill 3 took 33.6 s, bounded by the 30 s lease [measured]. A short lease recovers faster but raises the chance of two workers sending at once.

**Failure mode.** A worker slower than the lease loses ownership while still working, so two workers act. The mitigation here is the provider idempotency key. Clock skew between workers matters if each compares its own clock.

**Where this repo proves it.**
- Code: the claim in `handler.ts` is `INSERT ... ON CONFLICT (outbox_id, channel) DO UPDATE SET status='SENDING', updated_at=now() WHERE status='FAILED' OR (status='SENDING' AND updated_at < now() - make_interval(secs => $3))`. Default `leaseMs` is 30 000. Time comes from the database `now()`, so every worker uses one clock. A row that is neither claimable nor `SENT` means another worker holds a fresh claim, and the handler throws `InFlight`.
- Tests: "a crashed worker's expired lease is taken over" (row `SENDING` a minute old is resent, the `SENT` push is not); the 20-way dedup test above exercises the `InFlight` path.
- Consumer side (`services/notifications/src/consumer.ts`): `handleWithInFlightRetry` waits 100 ms and re-checks, up to 20 attempts (about 2 s), then lets the batch redelivery take over.
- Not measured: how often a send outlives the lease. There is no timeout on the provider call in `handler.ts`, so the lease bounds recovery but nothing bounds the send itself.

## Bugs the tests found

Copied from the ADR and RESULTS files; they are the most reusable part of the lab.

**Notifications** (`services/notifications/adr/001-kafka-for-notifications.md`, section "Bugs found by tests and the load run"):
1. A `FAILED` channel could never be retried (claim only matched `SENDING`).
2. Dedup by "row exists" was not exclusive: 20 concurrent duplicates sent several emails. Fixed with a lease and an `InFlight` signal.
3. `InFlight` thrown in a batch crashed the consumer, which then restarted with a ~10 s backoff and stalled processing (15k of 38k delivered after 5 min). Fixed with a short local retry.

Lesson 2 is the general one: "insert if not exists, then act" is not a lock. The claim must be atomic and must expire. Lesson 3: a control-flow signal ("someone else has it, try later") is not an error and must not be allowed to take down the consumer.

**Inventory** (`services/inventory/adr/001-hold-strategy.md`, `RESULTS.md`):
- Check-then-write in the app was rejected as "the classic double booking bug".
- Redis `SET NX EX` as the hold was rejected for now: fast with a built-in TTL, but a second source of truth to reconcile with the sale in Postgres; revisit if the DB becomes the bottleneck.
- Serializable isolation was rejected as heavier than needed for single-row predicates (it needs retry loops on serialization failures).
- Hot seats produce a stream of 409s, not timeouts, so the client UX must handle "seat just taken"; the throughput that drops is that of successful holds.

**Gateway** (`services/gateway/adr/001-token-bucket-redis.md`): a `GET`-then-`SET` limiter from the app would race; tested with 300 concurrent takes on a bucket of 100. The first Redis-down design hung every request until the client timeout (drill 1, see [reliability patterns](reliability-patterns.md)).

**Catalog** (`services/catalog/RESULTS.md`, `adr/001`, `adr/002`): single-flight collapses 100 concurrent misses for one key into one query (tested), per process, so the worst case is instances x 1 query per key. TTL jitter avoids a synchronised miss wave. Method lessons from the benchmark itself: a first run compared ILIKE with date order against FTS with ranking and "proved" ILIKE 7x faster (different `ORDER BY`); synthetic data put each genre in exactly one city; an empty `city=` was read as a city named "" and reported ILIKE at 8 400 RPS when the real figure is 25 RPS. Wrong tests give confident wrong numbers, which is the same failure as a race that passes locally.

## Where this is proven in the repo / what is still paper

Proven by code and tests:
- Conditional UPDATE, FOR UPDATE with ordering, deadlock test: [inventory service](../../services/inventory/src/inventory.service.ts), [inventory tests](../../services/inventory/src/inventory.test.ts), [ADR 001](../../services/inventory/adr/001-hold-strategy.md), [RESULTS](../../services/inventory/RESULTS.md).
- Idempotency key, saga, outbox, SKIP LOCKED relay: [payments service](../../services/payments/src/payments.service.ts), [outbox relay](../../services/payments/src/outbox-relay.ts), [payments tests](../../services/payments/src/payments.test.ts), [ADRs](../../services/payments/adr/001-saga-over-2pc.md), [RESULTS](../../services/payments/RESULTS.md), [CAPACITY](../../services/payments/CAPACITY.md).
- At-least-once with dedup, lease, `InFlight`, DLQ: [handler](../../services/notifications/src/handler.ts), [consumer](../../services/notifications/src/consumer.ts), [tests](../../services/notifications/src/handler.test.ts), [ADRs](../../services/notifications/adr/001-kafka-for-notifications.md), [RESULTS](../../services/notifications/RESULTS.md).
- Atomic Lua token bucket: [gateway tests](../../services/gateway/src/gateway.test.ts), [ADR](../../services/gateway/adr/001-token-bucket-redis.md).
- Drills 2 and 3: [failure drills](../failure-drills.md).

Still paper (no code or tests here):
- Optimistic locking (version column) and advisory locks: sketches above are untested.
- 2PC: only the rejection in the ADR.
- Phantom-predicate protection (SERIALIZABLE or a counter row): not needed by the current data model, not built.
- Same key with a different body (422) and a request-fingerprint check: only in kafka-pay-lab, not here.
- A crash between `psp.charge` and the `CHARGED` commit has no dedicated test.
- DLQ replay: done (`services/notifications/src/replay-dlq.ts`, drill 5 in `docs/failure-drills.md`, [measured]: replay is safe because delivery state is per (event, channel)). Still paper: alerting on DLQ depth.
- Numbers not measured: successful-hold rate under hot contention, how often a send outlives the 30 s lease, Postgres lock wait times.
