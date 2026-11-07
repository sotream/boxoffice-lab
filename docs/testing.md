# Testing and invariant proofs

The headline claims of this repository are correctness claims: no oversell, atomic rate limiting, FIFO admission, at-least-once delivery with dedup (no duplicate effects), caches that never serve the wrong data. Each is backed by property-based tests (fast-check) that run against the real Postgres and Redis, and the tests themselves are tested with a mutation check.

## Test pyramid

| Layer | What it proves | Where | Cost |
|---|---|---|---|
| Pure properties | formulas, token format, parsing: totality, monotonicity, round trips, tamper rejection | `packages/capacity`, `packages/admission` | milliseconds, no infrastructure |
| Model-based tests | a real store (Postgres or Redis) agrees with a tiny in-memory reference model after every command of a random sequence | `services/inventory/src/model.test.ts`, `services/waiting-room/src/properties.test.ts`, `services/gateway/src/rate-limiter.properties.test.ts` | seconds, needs `docker compose up` |
| Concurrent invariants | random batches of simultaneous commands, then global invariants (no seat twice, totals add up, nobody lost, nothing delivered twice) | same files, "concurrency" blocks | seconds |
| Policy tables | every combination of route x token state x dependency state gives the documented status | `services/gateway/src/policy.test.ts` | milliseconds (fakes) |
| Contract and fuzz at the HTTP edge | hostile input never gives a 5xx; cache keys are unambiguous | `services/catalog/src/properties.test.ts`, `services/waiting-room/src/http.test.ts` | seconds |
| Failure-injection with a fake broker | dead-letter routing and partition progress of the real `consumer.ts` | `services/notifications/src/properties.test.ts` | seconds, no Kafka |
| End-to-end with crashes | the invariants across gateway, inventory, payments, outbox, Kafka and notifications, including `kill -9` of payments and of the consumer | `packages/e2e` ([docs/e2e.md](e2e.md)) | about 2.5 minutes, needs the compose Redpanda |
| End-to-end fault suite | the same invariants through `kill -9` of inventory, gateway and waiting-room, Postgres paused and stopped, Redpanda stopped, Redis stopped and paused, hold expiry, and two instances of gateway, payments and inventory, on private docker containers | `packages/e2e/src/faults`, `pnpm test:e2e:faults` ([docs/e2e.md](e2e.md#fault-suite-pnpm-teste2efaults)) | about 6 minutes, needs docker |
| Mutation check | the tests above fail when the production code is deliberately broken | `scripts/mutation-check.mjs` | about 8 minutes |
| Load tests and failure drills | numbers and behaviour under load (k6, `drills/`) | `services/*/load`, `docs/failure-drills.md` | minutes, manual |

Payments is covered in its own section below: its saga is proven with a PSP contract suite, deterministic race tests, a crash at each of 8 fault points, and a fast-check model test over random interleavings (`services/payments/src/psp.contract.ts`, `saga.races.ts`, `saga.property.ts`; ADR 005). Invariants asserted: one terminal state per payment; exactly one outbox event and never both confirmed and refunded; charged minus refunded cents equals the sum of CONFIRMED amounts; at most one effective refund per charge. `SAGA_RUNS=300` raises the number of generated scenarios. The mutation runner covers the payments saga, outbox relay and trace storage (`pay-*` ids below).

## What each invariant proves

**Inventory (no oversell).** A reference model keeps one cell per seat (free, held by U, expired, sold to U). Random sequences of `hold`, `confirm`, `expire` (moves `hold_until` into the past) and `availability` run against Postgres for both strategies; after every command the answer, the availability counts and the per-seat rows must equal the model. The concurrent variant fires random batches of simultaneous holds, confirms and availability reads and checks: no seat is won by two holds, `free + held + sold = total` even while racing, a sold seat is never re-held or reassigned, a successful confirm means all its seats are sold to that user, `held_after = held_before + sum(sizes of won holds) - newly sold`, confirm is idempotent for its owner and never succeeds for anyone else. A 150-user contention test also checks maximality: a rejected request really conflicts with a won seat (no spurious rejections). A statement-level test pins the documented ordered locking (`ORDER BY seat_id FOR UPDATE`, ids sorted and de-duplicated), because on a small table the planner locks in key order anyway and a deadlock cannot be provoked reliably.

**Waiting room (FIFO, no double admission).** A list-plus-set model is compared after every `join`, `status`, `admit` and simulated TTL expiry: `admit(n)` returns exactly the head of the queue in order and never more than `n`; join is idempotent and keeps the place; a user is never both waiting and admitted; a waiting user's position never gets worse and positions are exactly 1..k; status of any unknown id (any unicode, key-like strings) is `unknown`. Under concurrency: if one join finished before another started, it is admitted first (happens-before FIFO, across random phases and budgets); simultaneous joins, admits and status calls never admit anyone twice, respect each budget, and never lose a user (every joined user is waiting or admitted, never both). Concurrent joins that overlap in time have no defined order: the sequence number is taken before the `ZADD`, so two joins in flight can land either way, which is acceptable and is why the property is stated with happens-before.

**Gateway (rate limiting, admission).** The Lua token bucket is compared with an exact model on a controllable clock (the stored timestamp is moved back by the virtual delay; all quantities are whole tokens, and the test asserts that real elapsed time stays below one token). Allowed/denied and the reported `remaining` must match on every step, with three independent keys interleaved. With real time, for every window of consecutive calls the spent tokens never exceed `burst + rate x window` (tolerance 3 ms of refill for Redis' millisecond clock). Concurrent takes allow exactly `min(burst, callers)`. The `GatewayService` table covers 5 routes x 6 token states x 3 limiter states (ok, limited, down) = 90 cells, plus upstream failures (504), per-user and per-IP keys, 404 for everything else, and fuzzed paths and tokens.

**Admission tokens.** Round trip for any user id (including dots and unicode), event and secret; the expiry boundary is inclusive; any single-character change anywhere in the token is rejected (random and exhaustive over every position); truncation and extension are rejected; equal-length wrong signatures are rejected; the comparison is `timingSafeEqual` (asserted by reading the source, and by the equal-length test, which reaches that code path); arbitrary strings and bytes never throw.

**Catalog (cache-aside never serves wrong data).** TTL jitter stays within +-20% for any base TTL and the TTL actually written to Redis is in that range, so staleness is at most 1.2 x TTL (and a changed row is visible after one TTL, tested with a 1 s TTL); a cached response equals the database response at fill time; errors are not cached; nulls are cached once; single-flight runs the loader once per key for any number of callers and keys; the search cache key is unambiguous (different parameter tuples never share a key). Search input fuzz (SQL injection strings, unicode, NUL bytes, 100-character limit, invalid percent-encoding) never gives a 5xx, and the SQL text is checked to contain no interpolation, so every value is a bound parameter.

**Notifications (dedup, DLQ).** Random messages with duplicates, redeliveries and flaky providers: the set of successful sends equals the set of unique `outboxId:channel` keys (minus true poison), no key is sent twice, poison keys stay `FAILED` and are retried exactly `maxAttempts` (default 4) per delivery, `attempts` equals the number of failed sends, and a healthy channel is not re-sent when its sibling fails. Concurrent duplicates never double-send (a fresh lease blocks other workers, an expired lease is taken over exactly once). With a fake `kafkajs`, the real `consumer.ts` is driven with random batches: poison and malformed messages go to `<topic>.dlq`, every offset is still resolved in order (the partition is not blocked), infrastructure errors fail the batch for redelivery.

**Capacity.** `ceil` semantics (`n x per x 0.6 >= peak` and one fewer would not suffice), monotonicity in every input, exact multiples do not round up, formulas are bilinear or products of their factors, `humanBytes` round-trips within rounding, the CLI never throws and exits 0 or 2 for arbitrary argv, valid arguments always succeed and match the formula.

## Running

```bash
docker compose up -d                       # Postgres :55432, Redis :56379
pnpm --filter @boxoffice/inventory test    # any package
pnpm --filter @boxoffice/gateway exec vitest run --coverage

# Reproduce a failure: fast-check prints the seed and the shrunk counterexample.
FC_SEED=1122667569 pnpm --filter @boxoffice/inventory test
# Verbose replay of one property:
FC_SEED=1122667569 pnpm --filter @boxoffice/inventory exec vitest run src/model.test.ts -t "model-based"
```

`FC_SEED` is honoured by the model and property tests of inventory, waiting-room, gateway, catalog and notifications; the pure packages use fast-check's random seed (printed on failure, replay with `fc.assert(..., { seed })`). Run counts are set deliberately per test (`numRuns`), 25 to 100 for the database-backed ones, 300 to 3 000 for pure functions, so each package stays under about 20 seconds. Tests use their own key ranges (inventory events 9000 to 9099, waiting-room events 9100 to 9199, notifications outbox ids from 9 000 000, Redis keys `rl:prop:*` and `t:prop:*`) and never flush a database. Packages with database tests set `fileParallelism: false` so files that truncate shared tables do not overlap.

Coverage (`@vitest/coverage-v8`) is configured per package in `vitest.config.ts`; the thresholds sit just below what is achieved:

```bash
pnpm --filter @boxoffice/catalog exec vitest run --coverage
```

## Mutation check

`scripts/mutation-check.mjs` applies one mutation at a time (`scripts/mutations.json`: `id`, `file`, `find`, `replace`, `package`, `expectFailingTests`), runs `pnpm --filter <package> test`, requires the run to fail, always restores the file (finally block, SIGINT, SIGTERM, process exit) and checks the restore byte for byte. A backup is kept under `$TMPDIR/boxoffice-mutation/`. If another process edits the file while a mutation is applied, only the mutation is reverted. A mutation counts as killed only if the run fails and at least one of the listed test names is in the output, so a build error elsewhere cannot fake a kill. Before the first mutation of a package the unmutated suite must pass.

```bash
node scripts/mutation-check.mjs                    # all
node scripts/mutation-check.mjs --only inv-confirm-expiry,adm-expiry
node scripts/mutation-check.mjs --list
```

It refuses to mutate `packages/platform`, `main.ts`, `db.ts`, `app.module.ts`, gateway `app.ts`, tests and package.json files. The system-level breaks of the end-to-end suite have their own runner, `packages/e2e/mutation-check.mjs` (15 breaks, 8 of them against the docker-based fault suite, see docs/e2e.md).

### Result

| id | package | what it breaks | result |
|---|---|---|---|
| `inv-hold-expiry-atomic` | inventory | atomic hold no longer takes over expired holds | KILLED |
| `inv-hold-expiry-forupdate` | inventory | for-update hold no longer takes over expired holds | KILLED |
| `inv-hold-allornothing` | inventory | atomic hold accepts a partial match (drops the all-or-nothing rowCount check) | KILLED |
| `inv-forupdate-allornothing` | inventory | for-update hold accepts a partial match | KILLED |
| `inv-forupdate-orderby` | inventory | for-update select without ORDER BY (lock order left to the planner) | KILLED |
| `inv-confirm-allornothing` | inventory | confirm sells a partial match | KILLED |
| `inv-confirm-expiry` | inventory | confirm ignores hold expiry | KILLED |
| `inv-confirm-owner` | inventory | anybody can confirm anybody's hold | KILLED |
| `wr-zadd-nx` | waiting-room | re-join moves a user to the back of the queue | KILLED |
| `wr-pop-order` | waiting-room | admits the newest instead of the oldest | KILLED |
| `wr-admit-budget` | waiting-room | admits one more than the budget | KILLED |
| `wr-admit-ttl` | waiting-room | admitted keys never expire (and status misreads them) | KILLED |
| `wr-join-admitted` | waiting-room | an admitted user who re-joins is queued again | KILLED |
| `wr-seq-clock` | waiting-room | ordering by wall clock instead of a sequence: ties reorder users | KILLED |
| `gw-bucket-cap` | gateway | bucket refills without a burst cap | KILLED |
| `gw-bucket-state` | gateway | consumed tokens are never persisted: no limiting at all | KILLED |
| `gw-bucket-cost` | gateway | off-by-one: the last token is never usable | KILLED |
| `gw-verify-skip` | gateway | admission token not enforced on holds/confirm | KILLED |
| `gw-fail-flip` | gateway | fail-open and fail-closed swapped | KILLED |
| `gw-user-key` | gateway | per-user limit keyed by IP instead of user | KILLED |
| `adm-expiry` | admission | expired admission tokens are accepted | KILLED |
| `adm-event` | admission | a token for event X works on event Y | KILLED |
| `adm-sig-skip` | admission | signature never compared | KILLED |
| `adm-hex-canonical` | admission | non-canonical signature encodings accepted | KILLED |
| `cap-instances-ceil` | capacity | instances not rounded up | KILLED |
| `cap-shards-ceil` | capacity | shards rounded down (under-provisioning) | KILLED |
| `cap-parse-zero` | capacity | zero accepted as a positive number | KILLED |
| `cat-jitter` | catalog | TTL jitter widens to +-50% | KILLED |
| `cat-singleflight` | catalog | concurrent misses each hit the database | KILLED |
| `cat-ttl-written` | catalog | entries live ~28 hours (unbounded staleness) | KILLED |
| `cat-key-collision` | catalog | ambiguous cache key: different queries share an entry | KILLED |
| `cat-nul-guard` | catalog | NUL byte reaches Postgres (500) | KILLED |
| `not-dedup` | notifications | already SENT deliveries are claimed and sent again | KILLED |
| `not-retry-budget` | notifications | one extra provider attempt per delivery | KILLED |
| `not-lease` | notifications | a live worker's lease is stolen | KILLED |
| `not-dlq-route` | notifications | dead letters fail the batch instead of going to the DLQ | KILLED |
| `not-event-shape` | notifications | JSON null reaches the handler (endless batch failure) | KILLED |
| `inv-atomic-lock-order` | inventory | atomic hold no longer locks rows in seat_id order first | KILLED |
| `pay-stale-after-charge` | payments | a runner that lost PENDING to CHARGED keeps going on a stale view | KILLED |
| `pay-sweeper-skips-refunding` | payments | sweeper no longer resumes sagas stuck in REFUNDING | KILLED |
| `pay-refund-key-unique` | payments | refund idempotency key differs per attempt (retry refunds twice) | KILLED |
| `pay-lost-cas-writes-event` | payments | a runner that lost the compare-and-set still writes the outbox event | KILLED |
| `pay-refunding-is-final` | payments | pay() reports an in-flight refund as final | KILLED |
| `pay-trace-not-stored` | payments | request trace not stored on the payment row | KILLED |
| `pay-relay-id-string` | payments | outbox id published as a string and dead-lettered | KILLED |
| `gw-user-mismatch` | gateway | gateway forwards a body whose userId differs from the admission token | KILLED |
| `gw-method-405` | gateway | holds, confirms and payments accept any method and skip the identity check | KILLED |
| `pay-int4-bound` | payments | ids beyond int4 pass validation and the card is charged first | KILLED |
| `pay-confirm-4xx-refund` | payments | any 4xx from inventory is read as lost seats and refunds a valid payment | KILLED |
| `pay-sweep-swallows` | payments | the sweeper discards the failures of sagas it could not advance | KILLED |
| `pay-seats-validation` | payments | the controller accepts empty or oversized seat lists and charges the card | KILLED |
| `not-dlq-count-before-send` | notifications | the DLQ counter is never incremented | KILLED |
| `pay-token-skip` | payments | `x-internal-token` is no longer checked | KILLED |
| `pay-token-compare-open` | payments | the token comparison accepts any token | KILLED |
| `pay-price-trust` | payments | a client amount that differs from seats x `SEAT_PRICE_CENTS` is accepted | KILLED |
| `pay-price-from-client` | payments | the client's amount is charged instead of the computed price | KILLED |
| `pay-key-scope` | payments | a replayed idempotency key of another user reads that user's payment | KILLED |
| `gw-pay-event-binding` | gateway | `/pay` forwards a body that names another event than the path | KILLED |
| `gw-pay-token-header` | gateway | the gateway does not send the internal token to payments | KILLED |

All 59 killed in a single full run on 2026-11-07 (`node scripts/mutation-check.mjs`, commit `c3c1c5e`, no survivors, working tree restored afterwards). Two existing payments controller tests were vacuous once the price check existed (their body had a wrong amount, so the 400 came from the price, not from the rule under test); they now send no amount, and `pay-seats-validation` / `pay-int4-bound` are killed by the intended tests. After the lock-order fix two inventory mutations had stale `find` strings (the SQL changed) and one was caught by a different test than expected (a deadlock surfaces in whichever concurrent test hits it first); the definitions were updated, no mutation survived. `inv-forupdate-orderby` first survived: ids are sorted before the query and a small table is locked in key order by the planner anyway, so no concurrency test can tell; it is now killed by the statement-level lock-ordering test, which is a contract check rather than a behavioural one.

## Bugs found by these tests

Each was found by a property, fixed minimally, and has a regression test.

| Where | Counterexample | Fix |
|---|---|---|
| inventory `confirm` was not all-or-nothing | `hold(u1,[3])`, `confirm(u1,[3,1])` answered false but had sold seat 3 | confirm runs in a transaction and rolls back unless every seat matched; duplicate ids are collapsed; the controller validates the confirm body like hold |
| catalog search cache key ambiguous | city `a:b` + q `c` and city `a` + q `b:c` both produced `search:fts:a:b:c` | key is the JSON of the tuple |
| catalog 500 on NUL byte and on huge event ids | `q=%00`; `/events/99999999999999999999` | 400 for NUL, 404 beyond int4 |
| notifications consumer: valid JSON that is not an event blocks the partition | message `null` (or an object without `outboxId`) threw a TypeError, not a `DeadLetter`, so the batch failed and was redelivered forever | `parseEvent` shape check; invalid shapes go to the DLQ |
| payments confirm mapped every 4xx to "seats lost" and refunded; the sweeper swallowed saga failures; payment ids were strings (second review) | a 400 from inventory refunded a valid payment; a saga failing on every sweep left no log and no metric; `bigserial` came back as `"1"` | only 409 means lost seats, other 4xx throw; `onSweepError` reports each failed saga; ids are numbers; the controller validates 1 to 8 seat ids before charging |
| gateway exposed `/metrics` and `/readyz` on the public port (second review) | anyone could read limiter counters and Redis error text | ops endpoints moved to `OPS_PORT` (3106); the public port answers 404; the userId check now runs after the per-user limiter and only for POST |
| platform `migrate` replayed every file on every boot; `tcpCheck` had no connect timeout (second review) | a non-idempotent migration would re-run; a blackholed broker left a socket per readiness probe | applied files recorded in `public.schema_migrations` under an advisory lock; `tcpCheck` times out and destroys the socket |
| admission token malleability | an upper-case or `00`-suffixed signature verified for the same body (Node's hex decoder is lenient), so one token had many valid spellings | signature must be exactly 64 lowercase hex characters; event and expiry fields must be plain digits |
| inventory `hold` and `confirm` deadlocked under different plans (found as a rare failure of the model-based test after a heavy run, then reproduced) | a bare multi-row `UPDATE` locks rows in plan order; with the confirming connections forced off indexes, 7 of ~4 800 statements failed with `40P01` | both statements lock their rows first in `seat_id` order inside the same statement; `lockorder.test.ts` forces different plans and fails on the old statements |
| payments outbox relay, found by the end-to-end suite | every real event reached notifications as `outboxId` `"12"` (pg returns bigserial as text) and was dead-lettered; unit tests built events with numbers by hand | relay sends `Number(id)`; regression test in `payments.test.ts` |
| gateway forwarded a body whose `userId` differed from the admission token (noted by the end-to-end suite, not asserted by it) | an admitted user could hold or confirm seats as another user | the gateway answers 403 unless the body `userId` equals the token's user, 400 for a body that is not JSON; test in `gateway.test.ts` |
| inventory and payments killed by a Postgres restart, found by the fault suite | `docker stop` of Postgres under load: a connection terminated between two statements of a transaction emitted `error` on a checked-out client with no listener (`pg` removes the pool's idle listener on checkout), Node threw it unhandled and inventory exited; the platform test covered idle clients only | `createPool` of inventory and payments adds a no-op `error` listener per connection; `pool-errors.test.ts` in both services kills the backend of a checked-out client and fails without the fix |

## Known limits

- Join in the waiting room is not atomic with admission (sequence number, then `ZADD`): order is guaranteed only between joins that do not overlap in time. Admission is `ZPOPMIN` followed by key writes, so a crash between them loses those users (documented in the waiting-room ADR).
- The real-time token bucket window test depends on the Redis server clock being monotonic; a wall-clock step during the run can fail it.
- The gateway tests import `@boxoffice/admission` through its built `dist/`; run `pnpm --filter @boxoffice/admission build` after changing the token code.
- Catalog and inventory tests share one Postgres with other suites and load runs; they use their own ids, but `seed()` of the catalog truncates `catalog.events`.
