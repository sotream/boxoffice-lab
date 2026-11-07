# End-to-end proof: the whole flash-sale pipeline, with crashes

Every service has its own tests. This suite (`packages/e2e`, `@boxoffice/e2e`) proves the claims that only exist **between** services, with the real built services as child processes and nothing mocked except the payment provider and the e-mail provider, which are the lab's own fakes:

```
client -> gateway -> waiting-room (Redis)            queue join, status polling, signed admission token
client -> gateway -> inventory (Postgres)            hold with the token
client -> gateway -> payments -> inventory /confirm  pay with the token and an Idempotency-Key; the gateway binds user and event and adds the internal token
payments outbox relay -> Redpanda -> notifications   e-mail and push, deduplicated
```

## Run it

```bash
docker compose up -d                 # Postgres, Redis and Redpanda must be running
pnpm -r build                        # the suite also recompiles each service it starts (tsc, a few seconds)
pnpm test:e2e                        # about 2.5 minutes; not part of the default per-package unit run
pnpm test:e2e:faults                 # the outage/crash/expiry/multi-instance scenarios; needs the docker CLI, about 6 minutes (see "Fault suite")
pnpm --filter @boxoffice/e2e exec vitest run src/chaos.e2e.test.ts -t 2001   # one scenario / one seed
node packages/e2e/mutation-check.mjs [--list] [--only id,id]               # the system-level mutation check (fault-suite breaks need docker)
```

## Isolation

The suite shares the lab infrastructure with other suites and drills, so each scenario builds a private world and removes it at the end:

- **Postgres:** a scratch database (`createScratchDatabase`), passed to every service as `DATABASE_URL`, dropped afterwards.
- **Redis:** the first empty logical DB among 11 to 15; only keys `wr:1:*` and `rl:*` of that DB are deleted at the end. No `FLUSHDB`/`FLUSHALL`.
- **Ports:** free ports from the OS for every service and the notifications ops port.
- **Kafka:** consumer group and topic of notifications are private (`TOPIC`, `GROUP_ID`). Payments publishes to the fixed topic `payments` (the name is stored in the outbox rows; there is no environment switch) and notifications reads from the beginning, so it must not read that topic directly: foreign events would collide with our outbox ids. A **bridge** in the test process consumes `payments` with its own group (from the end), keeps only events whose `userId` carries this run's prefix and republishes them unchanged (key, value, headers) to the private topic. The bridge also injects duplicates on purpose (20% of events twice back to back, 10% again 2 s later), because the relay itself only duplicates after a crash and we want the dedup proof to bite in every run. Private topics and groups are deleted at the end.
- **Processes:** every child is killed in `afterAll`, and on `process.exit`.

## Load

`src/load.ts`: a seeded generator (mulberry32 stream per user, so a user's choices do not depend on scheduling) over `fetch`, bounded concurrency. Each user: queue join, poll status until admitted and a token arrives, hold 1 or 2 random seats through the gateway (up to 4 attempts on conflicts), pay **through the gateway** (`POST /events/1/pay`, with the admission token, an `Idempotency-Key` and an `x-request-id`), polling the same key while the answer is 202, 429, 5xx or the service is down (any other 4xx fails the user at once). Clients send `amountCents` as before; payments computes the price itself (`SEAT_PRICE_CENTS`, set to the load's price in `stack.ts`) and the equal value is accepted. Mix: 10% abandon after the hold, 6% **cheaters** pay, as themselves and with their own token, for a seat held by another user (the gateway cannot know who holds what: the card is charged, inventory refuses the confirm because only the confirm checks hold ownership, and the payment is refunded), 4% **impostors** put another user's id in the pay body (the gateway must answer 403 and nothing may be charged), 10% submit the payment twice concurrently. The fake PSP declines a fraction of charges and has latency. The same seed gives the same plan; the interleaving of the race is not reproducible, so a failure is investigated from the printed summary, not by replay.

## Invariants (checked by reading the databases, `src/invariants.ts`)

| | Invariant |
|---|---|
| a | No seat is sold or held to two users: no seat got HTTP 2xx for two users, and every seat in the seats table equals an exact reference model (free, held by its single winner, or sold to the winner of a CONFIRMED payment). |
| b | Seats sold == union of the seats of CONFIRMED payments, exactly; every CONFIRMED payment's seats are sold to that payment's user; no seat in two CONFIRMED payments; no REFUNDED payment whose seats are sold to its user (the ADR 005 residual risk is looked for explicitly and would be reported). |
| c | Money: charges taken (confirmed + refunded events) minus refunds == sum of CONFIRMED amounts == what clients were told was confirmed == sold seats x price. The fake PSP lives in the payments process (memory only, lost on `kill -9`), so its own ledger cannot be read from outside; the check uses the payments table, the outbox events and the client view. |
| d | Exactly one terminal outbox event per payment, of the right type, matching the row, all published; every outbox row reached the broker; no dead letters. One Idempotency-Key gives one payment row (double submits return the same id and status). |
| e | Notifications delivered == unique (event, channel) pairs of the terminal events, all SENT, none missing, none extra. Without crashes, the consumer's own counter shows exactly that many sends and at least as many suppressions as there were duplicate copies on the broker. |
| g | An admitted user cannot pay as somebody else: every impostor got 403 from the gateway, no payment row exists for its key or user, and the number of payment rows equals the number of clients that paid (so nothing was charged on their behalf). |
| f | The `x-request-id` the client sent at the purchase is in the payment row's trace, in the outbox payload and in the Kafka headers of every copy of the event. In scenario 1 (debug logs on) the hold request ids are in the gateway and inventory logs and the pay request ids in the payments and inventory logs. |

Also checked: the client's final answer equals the stored state, and quiescence is reached by polling with a deadline (all payments terminal, outbox drained, all deliveries SENT).

## Scenarios

1. **Happy flash sale** (`happy.e2e.test.ts`): 300 users, 100 seats, PSP declines 20% with 40 ms latency, no faults. All invariants, no 5xx, every 429 would carry Retry-After. A second test in the file (1b) then attacks the payments boundary with nothing written: direct calls without or with a wrong `x-internal-token` are 401 (also for malformed JSON), a tampered `amountCents` is 400 (direct and through the gateway), the gateway refuses a missing token, another event's token, another user's id in the body, another event id in the body and a missing `Idempotency-Key`, and a user who replays another user's `Idempotency-Key` gets an independent payment of their own (the key is scoped by user, so nothing of the owner's payment is revealed and the owner is not blocked) while the owner still gets the stored result; the refused calls write nothing, the replay writes exactly one row. Last run: 92 payments (58 confirmed, 16 refunded, 18 declined), 67 seats sold, 166 deliveries, 32 duplicate copies on the broker, 0 duplicate sends.
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
| payment for seats held by somebody else | cheater users (own token, own id, someone else's seat) | ownership is checked before the charge (ADR 007): FAILED, card untouched; when the check is unknown (timeout) the payment goes on and confirm refuses it: charged, compensation REFUNDING -> REFUNDED | 1, 2, 3 |
| payment as another user | impostor users (own token, victim's id in the body) | gateway binds the body user to the token: 403, nothing charged (invariant g) | 1, 2, 3 |
| payments reached without the gateway, tampered price, replayed key | direct calls and a second user (scenario 1b) | signed internal requests (`x-internal-auth`), server-side price, idempotency key scoped to the user | 1b |
| limiter overload | tiny limits, concurrent storm | 429 + Retry-After | 3 |
| limiter store down | gateway pointed at a dead Redis port (the shared server is not touched) | fail closed (holds), fail open (reads) | 3 |

Added by the [fault suite](#fault-suite-pnpm-teste2efaults) (private containers, scenarios F1 to F11):

| Fault | How | Mechanism that must recover | Scenario |
|---|---|---|---|
| inventory process killed | SIGKILL, restart on the same port | holds live in Postgres; a connect failure is `StepTimeout` (never a refund); the sweeper finishes CHARGED sagas | F1 |
| Postgres hangs / is stopped for 12 s | `docker pause`, `docker stop`/`start` of a private container | pool error handling (see Findings), `/readyz` 503, saga CAS and sweeper, outbox | F2 |
| broker stopped for 15 s | `docker stop`/`start` | transactional outbox, relay retry, consumer dedup | F3 |
| Redis stopped (empty on return) or paused for 10 s | `docker stop`/`start`, `docker pause` | limiter fail closed/open policy, re-join after queue loss | F4 |
| gateway process killed | SIGKILL, restart | client retry with the same key, limiter buckets in Redis | F5 |
| holds expire | `HOLD_SECONDS=4`, late payers, second wave | the pre-charge check stops them (FAILED); with it off confirm checks expiry (409) and the saga refunds; seat reuse | F6 |
| a silent partition between inventory and Postgres (no RST, no close) | TCP proxy in blackhole mode | bounded waits (2 s pool connection timeout, 8 s gateway upstream timeout), no refund, held queries complete after the heal | F10 |
| a slow, then silent, path between payments and inventory | TCP proxy in latency, then blackhole mode | the 2 s step bound: unknown is not failed, the saga waits, the sweeper finishes it | F11 |
| several instances | 2 gateways, 2 payments with sweepers, 2 inventories, one database | CAS transitions, idempotent confirm, `FOR UPDATE SKIP LOCKED` relay | F7 |
| waiting room killed | SIGKILL, restart | queue and admission keys in Redis; the documented ZPOPMIN-then-SET window | F8 |
| only inventory's database fails | `seats` table locked for 10 s, statement timeout | 5xx is "unknown" for the saga: no refund, sweeper resumes | F9 |

Not injected: see Known limits.

## Fault suite (`pnpm test:e2e:faults`)

The default suite crashes processes; it cannot take Postgres, Redis or Redpanda away, because those are the shared lab servers. The fault suite (`src/faults/*.fault.test.ts`, its own vitest config `vitest.faults.config.ts`, not part of `pnpm test:e2e`) gives every scenario **private containers** of its own, started with the docker CLI from the test code (`src/docker.ts`):

- `boxoffice-e2e-<pid>-<n>-postgres|redis|redpanda`, the image tags read from `docker-compose.yml` (`postgres:18-alpine` with the compose `-c` settings, `redis:7-alpine`, the compose Redpanda with its flags), random free host ports on 127.0.0.1. Redis runs **without persistence** (`--save "" --appendonly no`), so a stop/start loses its data, the harsher case. Readiness is waited for with `pg_isready` plus a real query, `redis-cli ping`, and `rpk cluster health` plus a Kafka metadata call.
- All services of a scenario get `DATABASE_URL`, `REDIS_URL` and `KAFKA_BROKER` of those containers. Notifications reads the real topic `payments` of the private broker, so no bridge and no injected duplicates: a duplicate on the broker can only come from the relay itself (`src/tap.ts` only observes).
- Each scenario starts fresh containers and removes them in `afterAll`/`afterEach`, on `process.exit`/SIGINT/SIGTERM, and in the global teardown, which fails the run if any `boxoffice-e2e-<pid>-` container is left and removes containers of crashed earlier runs (owner pid gone). `Stack.stop()` fails if a child process survives. The last line of a green run is `leak check: no boxoffice-e2e- containers of this run left`.
- Everything is waited for by polling with deadlines (`waitUntil`, `waitQuiescent`); the only fixed durations are the outages themselves (a duration is the thing being tested). The seats are the reference model of `invariants.ts`, extended for this suite: a second grant of a seat is accepted only if it arrived after the first hold could have run out (`HOLD_SECONDS`), and a hold whose answer was lost (crash, timeout) may legitimately exist in the database, so the user who sent it may hold that seat.
- Docker is required (Docker Desktop or Linux Docker; images are pulled on first use). Runtime: about 6 minutes in total (last run 364 s for 11 tests before F6 was run in two modes, and 14 tests with F10 and F11), on the author's laptop (the machine is also the load generator, so a slower runner needs more; every test has a finite timeout).

| # | Scenario | Fault | What is asserted (besides every invariant above) |
|---|---|---|---|
| F1 | `inventory-crash` | `kill -9` of inventory while payments are in flight, restart on the same port | every seat answered 201 before the crash is still held (or sold) by the same user during the outage and after; sagas that hit the dead inventory sit in CHARGED and are finished by the sweeper (`payments_sweeper_resumed_total` > 0); no refund during the outage and no refund of any non-cheater in the whole run (a connect failure is `StepTimeout`, not "seats lost") |
| F2 | `postgres-outage` | `docker pause` (connections hang) and `docker stop`/`start` (connections reset), 12 s mid-sale | no process exits; `/readyz` of inventory, payments and notifications is 503 during the outage (never 200) and 200 again afterwards without a restart; gateway and waiting room (no Postgres) stay 200; clients saw 5xx or timeouts; nobody but cheaters was refunded; every payment ends terminal via the sweeper; the client's answer always equals the stored row |
| F3 | `redpanda-outage` | `docker stop`/`start` of the broker, 15 s mid-sale (slow admission, so sales continue) | during the outage no outbox row is marked published, the backlog grows, new payments keep completing, `payments_outbox_backlog` equals the table, `payments_outbox_oldest_unpublished_age_seconds` > 5, relay errors > 0, payments stays ready (kafka reported `ok:false`, not critical), clients see no 5xx; after recovery the backlog is published in increasing id order (single partition, so global order), the gauge is 0, nothing is dead-lettered, notifications delivered each event once. Every row reached the broker exactly once **except** rows that were in flight when the broker stopped: the relay may send those twice (at-least-once, observed once) and the dedup key absorbs it |
| F4 | `redis-outage` | `docker stop`/`start` (comes back **empty**) and `docker pause` (commands hang), 10 s mid-sale | holds, pay and queue join answer 503 with `Retry-After: 1` within a few ms (stop) or about 200 ms (pause), availability stays 200 (fail open), the refused hold and pay changed nothing (no seat held, no payment row); waiting-room `/readyz` 503, gateway `/readyz` 200 with `redis` `ok:false`; both recover without a restart; after a pause the queue is intact; after a stop the queue and the admission keys are gone (see below); a fresh purchase after recovery completes |
| F5 | `gateway-crash` | `kill -9` of the gateway mid-sale, restart on the same port after 2 s | clients saw connection refused and retried with the same keys; a per-user bucket (burst 3, no refill) on a second gateway stays empty after `kill -9` of that gateway and its restart (429 immediately: the bucket is in Redis, a fresh in-memory bucket would admit three more); the bucket key exists before and after |
| F6 | `hold-expiry` | `HOLD_SECONDS=4`; a third of the buyers wait 9 s before paying; a second wave takes the freed seats | no late payment is CONFIRMED; run twice: with the pre-charge check on (default) late payments are FAILED with the card untouched and nobody is refunded, with `VERIFY_HOLDS=0` the same payments are charged, inventory answers 409 and they are REFUNDED (the compensation path); seats were granted again after expiry (`regrants` > 0); for late payers whose seat another user was granted afterwards the payment is REFUNDED and the seat is not sold to them |
| F7 | `multi-instance` | 2 gateways, 2 payments (both sweeping), 2 inventories behind a round-robin HTTP proxy, one database | PSP slower than the step timeout so every payment answers 202 and stays PENDING; the provider then recovers (admin hook) and both sweepers resume the same sagas; both inventories served requests; all invariants (one terminal event per payment, money conservation) hold |
| F8 | `waiting-room-crash` | `kill -9` of the waiting room mid-sale, restart | queue members and scores and every admission key are identical in Redis before and after (nothing lost by the crash itself); every client completes (those who fell into the ZPOPMIN-then-SET window re-join); then the window itself is **simulated** (see below) |
| F9 | `inventory-db-lock` | only inventory's database access fails: the `seats` table is locked for 10 s by a test connection (every inventory statement waits, then dies at its 5 s statement timeout); payments, notifications and the readiness checks keep a working Postgres | clients saw 5xx; sagas were caught in CHARGED; nothing was refunded during the lock and no non-cheater in the run (a 5xx from inventory is `StepTimeout`, not "seats lost"); inventory's `/readyz` stays 200 (its `SELECT 1` works: readiness does not see a locked table, observed and asserted); every saga ends terminal afterwards |
| F10 | `net-db-partition` | the TCP path between inventory and Postgres (through `src/netproxy.ts`) silently drops everything for 12 s; both ends stay up and no connection is closed | nothing refunded because of it (payments reads inventory's failures as unknown); every availability probe through the gateway got an answer within the pool's 2 s connection timeout (observed 500 after about 2.0 s, never an endless wait); the connections that were mid-query completed when the path healed; invariants hold; at least 11 sales confirmed |
| F11 | `net-inventory-latency` | the path between payments and inventory is slow (1 s each way, right at payments' 2 s step timeout) for 8 s, then silent for 8 s, then healed | no refund at all (no cheaters in this run, so every refund would be the network's); sagas were caught in PENDING/CHARGED; after healing they all reach a final state and the invariants hold |

Last run (all tests green, 11 at the time; counts differ between runs): F1 30 seats promised before the kill, 26 sagas in CHARGED during the outage, 0 refunds, sweeper resumed 26; F2 readiness 503 from 1 to 2 s after the fault until about 0.2 s after the restore (pause and stop), 0 refunds of non-cheaters; F3 backlog 3 rows at the stop, 62 at the end of the 15 s, gauge 62, oldest unpublished 15 s, all 77 events published after, 3 rows in flight at the stop; F4 hold, pay and join refused in 1 ms (stop) or 202 ms (pause), 31 users re-joined after the stop; F6 6 late payers, 6 REFUNDED, 3 of them with a seat somebody else was granted afterwards, 7 seats granted again after expiry; F7 two sweepers resumed 38 and 52 sagas of 45 stuck, both inventories 387 requests each; F9 26 sagas in CHARGED while the table was locked, 448 hold 5xx, 0 refunds.

**In CI.** [e2e-faults.yml](../.github/workflows/e2e-faults.yml) runs the fault suite nightly (03:17 UTC) and on demand (`gh workflow run e2e-faults.yml`); it is not a required check and does not run on every push or pull request, because the scenarios are timing-based, take 6 to 8 minutes and pull a Redpanda image of about 600 MB. Read a red run from the `leak check:` line (a missing or failing line means containers were left behind; the last step lists any `boxoffice-e2e-` containers) and from the name of the failing scenario (F1 to F9), then reproduce it locally with `pnpm test:e2e:faults`.

### What a Redis outage loses and what it does not (F4, F8)

| | Redis **stopped and started** (no persistence) | Redis **paused**, or a waiting-room process killed |
|---|---|---|
| Waiting-room queue (`wr:1:queue`) | **lost**: users who waited get `unknown` from `/queue/status`, the clients re-join and take places at the end of the new queue (order is lost, not money) | kept |
| Admission keys (`wr:1:admitted:*`) | **lost**: a user who is admitted but had not bought yet is `unknown` again and must re-join | kept |
| Admission **tokens** already issued | **still valid**: they are signed (HMAC with expiry) and not stored; holds and payments with them work again as soon as the limiter is back | valid |
| Rate-limit buckets (`rl:*`) | lost (everybody gets a full bucket again) | kept |
| Seats, holds, payments, outbox | untouched (Postgres) | untouched |
| During the outage | holds, pay, queue join: **503 + Retry-After 1**, fail closed, fast; availability: **200**, fail open; nobody is admitted | same |
| After the outage | no restart needed anywhere; clients re-join; fresh purchases work | same |

The ZPOPMIN-then-SET window ([waiting-room ADR 001](../services/waiting-room/adr/001-redis-sorted-set-queue.md)) cannot be hit on purpose with `kill -9` (a gap of microseconds). F8 kills the process under load, which did produce `unknown` answers for a few users in the runs (counted as `queue:unknown-rejoin`; not asserted, because it depends on timing), and then reproduces the window **directly in Redis** (`ZPOPMAX` of a user without writing its key): the status is `unknown`, a re-join puts the user back and the user is admitted again. That last part is a simulation of the crash, not a crash, and is labelled so in the test.

Observed, not changed: the waiting room's own Redis client has no command timeout, so a request that reaches it while Redis is gone hangs until Redis returns (the gateway bounds the client's wait at its upstream timeout, and the gateway's limiter refuses first, so clients behind the gateway see 503 or 504, not a hang).

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

Fault-suite mutations (`faults: true` in the runner: each runs one scenario of `pnpm test:e2e:faults`, 30 to 230 s per break). These are breaks the default suite cannot see because it has no outage, crash of inventory, expiry or second instance:

| id | break | caught by | result |
|---|---|---|---|
| `pay-connect-refund` | payments treats a connect failure to inventory as "seats lost" and refunds | F1: `refund caused by the outage: expected 31 to be 0` (31 valid purchases refunded because inventory was down) | KILLED |
| `pay-no-sweeper-crash` | the sweeper is disabled | F1: sagas that hit the dead inventory stay CHARGED, `not quiescent ... open=29` | KILLED |
| `relay-no-ack` | the relay marks rows published although the broker never acknowledged (send error swallowed) | F3: `rows marked published during the outage: expected 15 to be 14` (or `relay errors during the outage` when that assertion is reached first; both are accepted evidence) | KILLED |
| `gw-fail-open-holds` | the gateway fails open on holds, pay and queue joins when Redis is down | F4 (stop): `hold while Redis is away: expected 201 to be 503`. The default suite's overload test also catches this one, in its own scenario | KILLED |
| `inv-confirm-ignores-expiry` | inventory confirms a hold that has expired | F6: late payers are CONFIRMED (`late payment confirmed after the hold expired`) | KILLED |
| `inv-hold-no-reuse` | inventory never gives an expired hold's seats to someone else | F6: `freed seats were reused: expected 0 to be greater than 0` | KILLED |
| `inv-error-as-conflict` | inventory answers 409 when its database fails during a confirm (the saga reads "hold expired") | F9: `refund caused by the outage: expected 1 to be 0` | KILLED |
| `pay-cas-removed` | payment state changes lose their compare-and-set | F7: two sweepers both "win" a transition, more outbox events than payments (`payments=90/90 ... outbox=101`) | KILLED |

Two of these first SURVIVED and were fixed in the test, which is the point of running them: `inv-confirm-ignores-expiry` survived while wave B retook every freed seat (then the owner check alone refuses the late payer), and `inv-error-as-conflict` survived the Postgres outage scenarios because payments and inventory share the database, so payments cannot record a refund while Postgres is down (it needed a failure that hits inventory alone: F9). `pay-cas-removed` survived while the sweepers never overlapped (the recovery latency was too short).

15 of 15 killed (7 default-suite breaks, 8 fault-suite breaks).

## Findings

- **Product bug found by the fault suite and fixed: `docker stop` of Postgres under load killed inventory.** `pg` removes the pool's error listener from a client while it is checked out. Inventory's hold and confirm run `BEGIN ... COMMIT` on a checked-out client, so a connection that Postgres terminates between two statements emits `error` on a client nobody listens to, Node throws it as an unhandled `'error'` event and the process exits (`Error: Connection terminated unexpectedly`, the log ends with `Node.js v26`). The existing platform test only covered idle clients. The same pattern exists in payments (`transition`, the outbox relay); inventory was the one that died in the run. Fix: each service's `createPool` wrapper (`services/inventory/src/db.ts`, `services/payments/src/db.ts`) registers `pool.on("connect", (c) => c.on("error", () => undefined))`; the failing query still rejects and the dead client is discarded on release. Regression tests that terminate the backend of a checked-out client with `pg_terminate_backend` and verify they fail without the fix: `services/inventory/src/pool-errors.test.ts`, `services/payments/src/pool-errors.test.ts`. The natural home for the fix is `createPool` in `packages/platform` (all services would get it); that package was out of scope for this change, so the platform owner should move it there and delete the two wrappers' lines.
- The `docker pause` variant of the same outage needed no fix: services stay alive, `/readyz` is 503 for the duration, and the sagas finish after the unpause.

- **Product bug found and fixed: every real payment event was dead-lettered.** The outbox relay published `outboxId` as a JSON string (Postgres `bigserial` comes back from `pg` as a string), while the notifications consumer, since the commit that routes malformed events to the DLQ, accepts only a safe integer. All unit tests passed because they build events with numbers by hand. The first run of scenario 1 showed it: 91 payments, 0 deliveries, every message in `<topic>.dlq`. Fix: `outbox-relay.ts` sends `Number(r.id)`; regression test in `services/payments/src/payments.test.ts` ("publishes outboxId as a JSON number"), verified to fail without the fix. Events already on a real `payments` topic with string ids sit in `payments.dlq` and need `replay-dlq` after normalising the id, or a tolerant consumer.
- Observation, not changed: `paymentId` is also a string in the HTTP answer and in the events (same cause); the suite compares it as a number.
- Found by the first run, fixed afterwards (payments ADR 006): the gateway did not route payments at all, so payments was reachable by anybody, took the user, the seats and the price from the body, and let any caller read a payment by replaying its `Idempotency-Key`. Now the gateway route binds the body to the admission token, payments requires `x-internal-token`, computes the price and scopes the idempotency key by user (a replayed key of another user is an independent payment) and answers 409 when the same user replays a key with another event or seats. What stays open on purpose: hold ownership is still verified only at confirm (cheaters are charged and refunded), and the token is a shared secret, not mTLS ([SECURITY.md](../SECURITY.md)).
- The ADR 005 residual risk (REFUNDED payment with seats sold to its user) was looked for in every run and never occurred.

## Known limits

- The PSP is the in-process fake: `kill -9` of payments forgets its charges (a real provider would not), so money conservation is asserted on the durable records, not on the provider. Decline injection uses `Math.random`, so counts differ between runs; the invariants do not depend on them.
- The notifications provider is a no-op with latency; "delivered" means the `deliveries` row is SENT and, without crashes, the process counter agrees. A crash between sending and recording can legitimately send twice (documented in the handler), so exact send counts are asserted only in scenarios without a consumer kill.
- Notifications continue the trace from the Kafka headers, but nothing logs a successful delivery, so correlation (f) is proven up to the broker headers, not inside the consumer's logs.
- The topic `payments` is shared and its name is fixed, hence the bridge: the path outbox relay -> Redpanda is real, the last hop reads from a private copy.
- The kill of the consumer waits for Kafka's session timeout to hand the partition to the restarted member, which is most of the scenario's runtime.
- Still not covered: network faults other than the two TCP-proxy scenarios (F10, F11): the proxy delays or holds whole chunks and can reset connections, but it does not lose or reorder packets, does not make one direction silent while the other works, does not emulate TCP retransmission timing or a half-open connection that the kernel only discovers after minutes, and it sits on the inventory-to-Postgres and payments-to-inventory paths only (not gateway-to-Redis, payments-to-Postgres or payments-to-Redpanda); a paused or stopped container is a clean fault where one side is simply absent; disk full, clock skew between processes and the database (the hold-expiry scenario depends on durations measured on one host), Postgres or Redis failover and replicas (single private nodes only), a broker with several partitions or brokers (order is asserted on one partition), slow dependencies other than the two paths above and a degraded disk, the catalog, multiple events (the admission tick serves event 1), and the notifications service with several instances. The multi-instance scenario (F7) uses the fake PSP, which lives in each payments process: idempotency of the provider across instances is therefore not exercised (only the saga's own compare-and-set is), and a double charge at the provider cannot be observed from outside. A Redis `docker stop` is a graceful shutdown of a server without persistence, not a crash of one that has some.
- Fault timings are durations, not conditions (the outage lasts N seconds): a very slow machine can make a scenario finish its sale before the outage ends, in which case the "work continued during the outage" assertions fail loudly rather than pass vacuously.
- Interleavings are not reproducible by seed; only the load plan is. A failing run prints the whole violation list and a summary.
- `Stack.stop` throws before it cleans the bridge group and the Redis keys when a child process survives the SIGKILL, so in that (not seen so far) case the private consumer group and the keys of the run stay behind; they live in per-run names and never touch anything else.
- A scenario whose assertions fail before `await load` leaves the load generator running in the background until its own deadline (150 s in the fault suite). The suite reports the first failure, but the process and its requests against a stack that is being torn down can add noise to the log.
- Containers are removed by the name prefix of the current run (`boxoffice-e2e-<pid>-`), including after a half-started world. Nothing sweeps the containers of an earlier run that was killed (`kill -9` of the test process, a power loss): the leak check in the global setup reports only this run's containers, so a stale `boxoffice-e2e-<other pid>-*` container stays until it is removed by hand (`docker rm -f $(docker ps -aq --filter name=boxoffice-e2e-)`).
- `freePort` binds port 0, reads the number and closes the socket, so another process can take that port before the service binds it. On a quiet developer machine or CI runner this was never observed; a collision shows up as a service that fails to start, not as a wrong result.
- Network proxy (`src/netproxy.ts`, tested in `netproxy.test.ts`): a dependency-free TCP proxy with modes pass, latency, blackhole (hold data, close nothing, deliver in order on heal) and reset. Not Toxiproxy or tc/netem: no extra image or privileges, but only the behaviours listed above.
- What F10 shows about the pool: the services' Postgres pool has no client-side query timeout (`statement_timeout` is enforced by the server, which in a silent partition never answers). A query already running on a silent connection therefore waits until the path heals or the caller gives up (the gateway answers 504 after its 8 s upstream timeout); new requests are bounded by the pool's 2 s connection timeout once every connection is stuck. In the 12 s partition of the scenario this was enough; a partition that outlasts the gateway timeout would leave stuck connections in the pool until it heals, and the suite does not run one.
