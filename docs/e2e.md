# End-to-end proof: the whole flash-sale pipeline, with crashes

Every service has its own tests. This suite (`packages/e2e`, `@boxoffice/e2e`) proves the claims that only exist **between** services, with the real built services as child processes and nothing mocked except the payment provider and the e-mail provider, which are the lab's own fakes:

```
client -> gateway -> waiting-room (Redis)            queue join, status polling, signed admission token
client -> gateway -> inventory (Postgres)            hold with the token
client -> payments -> inventory /confirm             pay with an Idempotency-Key (payments is called directly, as in the lab design)
payments outbox relay -> Redpanda -> notifications   e-mail and push, deduplicated
```

## Run it

```bash
docker compose up -d                 # Postgres, Redis and Redpanda must be running
pnpm -r build                        # the suite also recompiles each service it starts (tsc, a few seconds)
pnpm test:e2e                        # about 2.5 minutes; not part of the default per-package unit run
pnpm --filter @boxoffice/e2e exec vitest run src/chaos.e2e.test.ts -t 2001   # one scenario / one seed
node packages/e2e/mutation-check.mjs [--list] [--only id,id]               # the system-level mutation check
```

## Isolation

The suite shares the lab infrastructure with other suites and drills, so each scenario builds a private world and removes it at the end:

- **Postgres:** a scratch database (`createScratchDatabase`), passed to every service as `DATABASE_URL`, dropped afterwards.
- **Redis:** the first empty logical DB among 11 to 15; only keys `wr:1:*` and `rl:*` of that DB are deleted at the end. No `FLUSHDB`/`FLUSHALL`.
- **Ports:** free ports from the OS for every service and the notifications ops port.
- **Kafka:** consumer group and topic of notifications are private (`TOPIC`, `GROUP_ID`). Payments publishes to the fixed topic `payments` (the name is stored in the outbox rows; there is no environment switch) and notifications reads from the beginning, so it must not read that topic directly: foreign events would collide with our outbox ids. A **bridge** in the test process consumes `payments` with its own group (from the end), keeps only events whose `userId` carries this run's prefix and republishes them unchanged (key, value, headers) to the private topic. The bridge also injects duplicates on purpose (20% of events twice back to back, 10% again 2 s later), because the relay itself only duplicates after a crash and we want the dedup proof to bite in every run. Private topics and groups are deleted at the end.
- **Processes:** every child is killed in `afterAll`, and on `process.exit`.

## Load

`src/load.ts`: a seeded generator (mulberry32 stream per user, so a user's choices do not depend on scheduling) over `fetch`, bounded concurrency. Each user: queue join, poll status until admitted and a token arrives, hold 1 or 2 random seats through the gateway (up to 4 attempts on conflicts), pay with `Idempotency-Key` and an `x-request-id`, polling the same key while the answer is 202 or the service is down. Mix: 10% abandon after the hold, 6% **cheaters** pay for a seat held by another user (inventory must say no, the payment must be refunded), 10% submit the payment twice concurrently. The fake PSP declines a fraction of charges and has latency. The same seed gives the same plan; the interleaving of the race is not reproducible, so a failure is investigated from the printed summary, not by replay.

## Invariants (checked by reading the databases, `src/invariants.ts`)

| | Invariant |
|---|---|
| a | No seat is sold or held to two users: no seat got HTTP 2xx for two users, and every seat in the seats table equals an exact reference model (free, held by its single winner, or sold to the winner of a CONFIRMED payment). |
| b | Seats sold == union of the seats of CONFIRMED payments, exactly; every CONFIRMED payment's seats are sold to that payment's user; no seat in two CONFIRMED payments; no REFUNDED payment whose seats are sold to its user (the ADR 005 residual risk is looked for explicitly and would be reported). |
| c | Money: charges taken (confirmed + refunded events) minus refunds == sum of CONFIRMED amounts == what clients were told was confirmed == sold seats x price. The fake PSP lives in the payments process (memory only, lost on `kill -9`), so its own ledger cannot be read from outside; the check uses the payments table, the outbox events and the client view. |
| d | Exactly one terminal outbox event per payment, of the right type, matching the row, all published; every outbox row reached the broker; no dead letters. One Idempotency-Key gives one payment row (double submits return the same id and status). |
| e | Notifications delivered == unique (event, channel) pairs of the terminal events, all SENT, none missing, none extra. Without crashes, the consumer's own counter shows exactly that many sends and at least as many suppressions as there were duplicate copies on the broker. |
| f | The `x-request-id` the client sent at the purchase is in the payment row's trace, in the outbox payload and in the Kafka headers of every copy of the event. In scenario 1 (debug logs on) the hold request ids are in the gateway and inventory logs and the pay request ids in the payments and inventory logs. |

Also checked: the client's final answer equals the stored state, and quiescence is reached by polling with a deadline (all payments terminal, outbox drained, all deliveries SENT).

## Scenarios

1. **Happy flash sale** (`happy.e2e.test.ts`): 300 users, 100 seats, PSP declines 20% with 40 ms latency, no faults. All invariants, no 5xx, every 429 would carry Retry-After. Last run: 92 payments (58 confirmed, 16 refunded, 18 declined), 67 seats sold, 166 deliveries, 32 duplicate copies on the broker, 0 duplicate sends.
2. **Chaos** (`chaos.e2e.test.ts`), seeds 2001 and 2002: 250 users, 80 seats, PSP 250 ms and 15% declines. `kill -9` payments when 25 payments exist (25 to 28 were still in flight), restart after 2 s on the same port; then `kill -9` the notifications consumer while it delivers, restart in the same group. Recovery may use only the product's mechanisms. The same invariants hold afterwards.
3. **Overload** (`overload.e2e.test.ts`): a second gateway with `USER_RATE=2 USER_BURST=3 IP_RATE=10 IP_BURST=30`; 40 users each fire 25 concurrent holds, then 300 concurrent availability reads. Asserted: 836 of about 950 holds were 429 with Retry-After >= 1, no 5xx and no network error, admitted holds per user <= burst + rate x elapsed + 1, availability answers only 200 or 429 and the admitted count respects the IP bucket, then all invariants. Plus: a gateway whose Redis is unreachable answers holds 503 with Retry-After 1, changes no seat, and still serves availability (fail open).

## Failure injection matrix

| Fault | How | Mechanism that must recover | Scenario |
|---|---|---|---|
| payments process killed mid-saga | SIGKILL, restart | client retry with the same key (202 while in progress), sweeper resumes PENDING/CHARGED/REFUNDING, CAS transitions | 2 |
| outbox relay killed with the process | same kill | unpublished rows are republished (at-least-once) | 2 |
| notifications consumer killed mid-batch | SIGKILL, restart in the same group | uncommitted offsets are redelivered, dedup key `(outbox_id, channel)` | 2 |
| duplicate events on the broker | bridge injects back-to-back and late copies | dedup key and lease (`InFlight`) | 1, 2, 3 |
| declined charges | `PSP_FAIL_RATE` | FAILED + event, no seats confirmed | 1, 2, 3 |
| payment for seats not held | cheater users | inventory owner check, compensation REFUNDING -> REFUNDED | 1, 2, 3 |
| limiter overload | tiny limits, concurrent storm | 429 + Retry-After | 3 |
| limiter store down | gateway pointed at a dead Redis port (the shared server is not touched) | fail closed (holds), fail open (reads) | 3 |

Not injected: Redis server outage for the waiting room, Postgres or Redpanda outage, inventory crash (see limits).

## Mutation results

`packages/e2e/mutation-check.mjs` breaks one thing in a service file, runs the scenario that must notice, restores the file from a backup under `$TMPDIR` and verifies the bytes. All files were restored identically (checked with md5 and `git diff`).

| id | break | caught by | result |
|---|---|---|---|
| `inv-confirm-owner` | inventory confirm skips the owner check | scenario 1: cheaters' payments become CONFIRMED on other users' seats (invariants a, b) | KILLED |
| `inv-hold-overlap` | inventory hold takes held or sold seats | scenario 1: seats granted to two users (a) | KILLED |
| `pay-confirm-blind` | payments stores CONFIRMED although inventory said no | scenario 1 (a, b, c) | KILLED |
| `pay-no-outbox` | payments writes no outbox event | scenario 1: outbox empty, nothing delivered (d, quiescence) | KILLED |
| `relay-drops` | relay marks rows published without publishing | scenario 1: no delivery (d, e) | KILLED |
| `not-dedup` | notifications re-sends an already SENT delivery | scenario 1: sends exceed unique deliveries (e), thanks to the injected duplicates | KILLED |
| `pay-no-sweeper` | the sweeper never resumes sagas | scenario 2 seed 2001: 25 payments stay open, not quiescent (e.g. `payments=79/54 open=25`) | KILLED |

7 of 7 killed.

## Findings

- **Product bug found and fixed: every real payment event was dead-lettered.** The outbox relay published `outboxId` as a JSON string (Postgres `bigserial` comes back from `pg` as a string), while the notifications consumer, since the commit that routes malformed events to the DLQ, accepts only a safe integer. All unit tests passed because they build events with numbers by hand. The first run of scenario 1 showed it: 91 payments, 0 deliveries, every message in `<topic>.dlq`. Fix: `outbox-relay.ts` sends `Number(r.id)`; regression test in `services/payments/src/payments.test.ts` ("publishes outboxId as a JSON number"), verified to fail without the fix. Events already on a real `payments` topic with string ids sit in `payments.dlq` and need `replay-dlq` after normalising the id, or a tolerant consumer.
- Observation, not changed: `paymentId` is also a string in the HTTP answer and in the events (same cause); the suite compares it as a number.
- Observation, not changed: the gateway verifies the admission token but forwards the body unchanged, so an admitted user can hold seats under another `userId` (the per-user limiter uses the token's user, inventory uses the body's). Payments takes the user and the seats from the body with no authentication at all (it is not behind the gateway). Worth a design note before this faces the internet.
- The ADR 005 residual risk (REFUNDED payment with seats sold to its user) was looked for in every run and never occurred.

## Known limits

- The PSP is the in-process fake: `kill -9` of payments forgets its charges (a real provider would not), so money conservation is asserted on the durable records, not on the provider. Decline injection uses `Math.random`, so counts differ between runs; the invariants do not depend on them.
- The notifications provider is a no-op with latency; "delivered" means the `deliveries` row is SENT and, without crashes, the process counter agrees. A crash between sending and recording can legitimately send twice (documented in the handler), so exact send counts are asserted only in scenarios without a consumer kill.
- Notifications continue the trace from the Kafka headers, but nothing logs a successful delivery, so correlation (f) is proven up to the broker headers, not inside the consumer's logs.
- The topic `payments` is shared and its name is fixed, hence the bridge: the path outbox relay -> Redpanda is real, the last hop reads from a private copy.
- The kill of the consumer waits for Kafka's session timeout to hand the partition to the restarted member, which is most of the scenario's runtime.
- Not covered: crashes of inventory, gateway and waiting-room, Redis/Postgres/Redpanda outages, hold expiry (600 s, hard-coded), the catalog, multiple events (the admission tick serves event 1), multiple instances of a service, real network partitions.
- Interleavings are not reproducible by seed; only the load plan is. A failing run prints the whole violation list and a summary.
