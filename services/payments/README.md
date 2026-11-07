# payments

Interview questions: **"How do you make payments safe to retry?"**, **"Saga vs 2PC"**, **"How do you publish an event and update the DB atomically?"**

## Requirements
- FR: pay for held seats with an `Idempotency-Key`; on success confirm the seats in inventory.
- FR: if the hold expired by the time the money is taken, refund automatically (compensation).
- FR: emit `payment.confirmed|refunded|failed` events for notifications.
- FR: internal service: only the gateway calls it (route `POST /events/:id/pay`), with a shared secret; the price is computed here, never taken from the request ([ADR 006](adr/006-internal-authentication-and-server-side-price.md)).
- NFR: never charge twice, never lose an event, survive a crash at any step.

## Saga (orchestrated by this service)
`PENDING --charge--> CHARGED --confirm seats--> CONFIRMED`
`CHARGED --seats lost--> REFUNDING --refund--> REFUNDED` (compensation; `REFUNDING` is claimed by compare-and-set BEFORE the refund is issued, ADR 005) and `PENDING --charge declined--> FAILED`. Before the first charge of a new payment, payments asks inventory (`POST /events/:id/holds/verify`, read only) whether the payer holds the seats: no means `PENDING --seats not held--> FAILED` with the PSP never called, unknown (timeout, 5xx) means the payment goes on and the confirm decides ([ADR 007](adr/007-verify-holds-before-charging.md)); the check runs only for the call that created the payment, never when a possibly charged saga is resumed. `REFUNDING` is in progress, not final: `pay()` answers 202 and the sweeper resumes it.
Every transition is a compare-and-set `UPDATE ... WHERE status = <from>` plus an outbox row in the **same transaction**. `resume(id)` continues from the stored state after a crash.

## Outbox relay
A loop reads unpublished outbox rows (`FOR UPDATE SKIP LOCKED`), sends them to Kafka (Redpanda) with `acks=-1`, then marks them published. Delivery is **at-least-once**; consumers deduplicate by `outboxId`.

## Timeouts and the 202 answer
Each outside step (PSP, inventory confirm) is bounded at 2 s. On timeout the API answers **202** `{status, inProgress: true}`; repeat the call with the same `Idempotency-Key` to read the final state. A timeout is an unknown outcome, never a reason to refund; a sweeper resumes sagas stuck in `PENDING`, `CHARGED` or `REFUNDING` (ADR 004, drill 4). `POST /admin/psp` (only with `PSP_ADMIN=1`) changes the fake PSP latency for drills.

The correlation of the request that created the payment (`{requestId, traceparent}`) is stored on the payment row (`migrations/002_trace.sql`), so a saga finished by the sweeper after a 202 still writes its outbox events and Kafka headers under the original trace.

See [CAPACITY.md](CAPACITY.md), [adr/](adr/), [RESULTS.md](RESULTS.md).

## Endpoints
Port 3103. Internal: clients reach it through the gateway's `POST /events/:eventId/pay` ([gateway README](../gateway/README.md#endpoints)), which checks the admission token, rate-limits per user, binds the body user to the token and adds the credential below.

**Authentication.** Every request except `/healthz`, `/readyz` and `/metrics` (including `POST /admin/psp`) must carry header `x-internal-auth: <unix ms>.<hex HMAC-SHA256>`, computed with `PAYMENTS_INTERNAL_TOKEN` (the key is never sent) over `timestamp, METHOD, path without query, SHA-256 of the body`; otherwise 401 `{statusCode:401, error:"Unauthorized", message:"signed internal request required"}`. Two hooks (`src/internal-auth.ts`, the signing code is `packages/platform/src/internal-auth.ts`), both before the body is parsed or validated and before any database access, so a malformed body without a signature is 401, not 400: `onRequest` rejects a missing, malformed or stale header (more than 30 s from the server clock, either direction) without reading anything; `preParsing` reads the raw body (at most 64 KiB, else 413), verifies the HMAC with `timingSafeEqual` against the current key and, if set, `PAYMENTS_INTERNAL_TOKEN_PREVIOUS`, and passes the same bytes on. A captured header therefore does not work for another body, path or method and expires; within 30 s the identical request can be replayed, which the idempotency key makes harmless for `/payments`. Whoever holds the key can sign anything.

**Price.** `amountCents = seatIds.length x SEAT_PRICE_CENTS`. The body may still carry `amountCents`; it must then equal the computed value (400 otherwise), so a tampered price is rejected before the card is touched and clients that send the right price keep working.

**Idempotency scope.** The key is scoped by user inside payments: the stored, looked-up and PSP key is `<length of userId>:<userId>:<client key>` (length-prefixed, so no (user, key) pair can collide with another, e.g. user `a:b` + key `c` versus user `a` + key `b:c`). Another user sending the same client key creates their own independent payment and never sees the first user's id or status; nobody can block another user's key by using it first. For the same user, a repeat is "the same request" only if event and seat set (order ignored) match the stored payment: same key and same request returns the stored result, same key and a different event or seat set is 409 `idempotency key reused with a different request`, with no data about the stored payment.

| Method and path | Body or header | Answer |
|---|---|---|
| `POST /payments` | headers `x-internal-auth` and `Idempotency-Key` (both required), body `{eventId, userId, seatIds, amountCents?}` (`amountCents` optional, must equal `seatIds.length x SEAT_PRICE_CENTS`) | 200 `{status, paymentId, inProgress:false}` for a final state (`CONFIRMED`, `REFUNDED`, `FAILED`); 202 with `inProgress:true` while the saga is not final (`PENDING`, `CHARGED`, `REFUNDING`); 401 without a valid `x-internal-token`; 400 on a missing key, an invalid body (1 to 8 distinct seat ids, int4 ids; duplicates such as `[5,5,5]` are refused so one seat is never priced several times) or an `amountCents` that is not the computed price; 409 when the same user reuses the key with a different event or seat set |
| `POST /admin/psp` | header `x-internal-auth`, body `{latencyMs}` | only with `PSP_ADMIN=1`: sets the fake PSP latency (drills); 401 without a valid signature |
| `GET /healthz`, `/readyz`, `/metrics` | | see Operations |

## Environment
Read and validated at start (`src/main.ts`); bad values exit with code 78. Start with `pnpm --filter @boxoffice/payments start` after `pnpm build`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3103 | HTTP port |
| `DATABASE_URL` | `postgres://lab:lab@localhost:55432/lab` | Postgres |
| `PG_POOL` | 20 | Work pool size (the relay has its own pool of 3) |
| `KAFKA_BROKER` | `localhost:59092` | Broker `host:port` |
| `INVENTORY_URL` | `http://localhost:3101` | Inventory, for confirm |
| `PSP_LATENCY_MS` | 100 | Fake PSP latency |
| `PSP_FAIL_RATE` | 0 | Share of declined charges, 0 to 1 |
| `PSP_TIMEOUT_MS`, `CONFIRM_TIMEOUT_MS` | 2000, 2000 | Step timeouts; a timeout is an unknown outcome and answers 202 |
| `SWEEP_MIN_AGE_MS` | 3000 | How old (since the last state change) a `PENDING`, `CHARGED` or `REFUNDING` saga must be before the sweeper resumes it. With `VERIFY_HOLDS` on it must be at least `min(CONFIRM_TIMEOUT_MS, PSP_TIMEOUT_MS) + 500`, otherwise exit 78 (ADR 007) |
| `PSP_ADMIN` | 0 | `1` enables `POST /admin/psp` |
| `PAYMENTS_INTERNAL_TOKEN` | `dev-internal-token` | HMAC key with which the gateway signs its requests (`x-internal-auth`); the key itself is never sent. With `NODE_ENV=production` it must be set and not the default, otherwise exit 78 |
| `INVENTORY_INTERNAL_TOKEN` | `dev-inventory-internal-token` | Inventory's key (not the payments one): payments signs its `confirm` and `holds/verify` calls to inventory with it (`x-internal-auth`, never sent); must equal inventory's value. With `NODE_ENV=production` it must be set and not the default, otherwise exit 78 ([inventory ADR 002](../inventory/adr/002-signed-internal-requests.md)) |
| `PAYMENTS_INTERNAL_TOKEN_PREVIOUS` | unset | Optional previous key, accepted in addition to the current one during a rotation (deploy payments with both, then the gateway with the new one, then drop the previous). Refused in production when it is the development default |
| `VERIFY_HOLDS` | 1 | The pre-charge ownership check (ADR 007). `0` switches it off, for the benchmark of the compensation path and one e2e scenario only; refused with `NODE_ENV=production` (exit 78) |
| `SEAT_PRICE_CENTS` | 5000 | Price of one seat in cents, an integer from 1 to 100 000 000 (8 seats must fit int4) |
| `SAGA_RUNS` | 40 | Tests only: number of generated saga scenarios |
| `SHUTDOWN_DEADLINE_MS` | 10000 | Total time for graceful shutdown, minimum 100 |
| `SHUTDOWN_DRAIN_DELAY_MS` | 0 | Wait after going not-ready, so a load balancer notices |
| `LOG_LEVEL` | `info` (`silent` under tests) | trace, debug, info, warn, error, fatal, silent |

## Operations
- Every process serves `GET /healthz` (liveness, never calls a dependency), `GET /readyz` (readiness) and `GET /metrics` (Prometheus) on `PORT`. Readiness: Postgres is critical; Kafka is reported but not critical, because the outbox exists so that payments keep working while the broker is down.
- Metrics of this service: `payments_final_total{status}`, `payments_in_progress_total`, `payments_sagas{state}`, `payments_outbox_backlog`, `payments_outbox_oldest_unpublished_age_seconds`, `payments_outbox_published_total`, `payments_outbox_relay_errors_total`, `payments_sweeper_*`, `pg_pool_*`, `http_*`. Series definitions: the generated table in [operations.md](../../docs/operations.md#metric-catalogue).
- Logs are JSON lines on stdout with `requestId`, `traceId` and `spanId`; `x-request-id` and `traceparent` are accepted and propagated ([Correlation](../../docs/operations.md#correlation-one-id-per-purchase)).
- Shutdown (SIGTERM or SIGINT): goes not-ready, drains requests, stops the sweeper and the outbox relay (each finishes its iteration), disconnects the Kafka producer, closes the three pools. All steps share `SHUTDOWN_DEADLINE_MS`; a second signal exits 1 at once ([Graceful shutdown](../../docs/operations.md#graceful-shutdown)).
- Invalid configuration exits with code 78 and one message listing every problem ([Configuration and boot](../../docs/operations.md#configuration-and-boot)).
- Runbooks for the drills that hit this service: [operations.md](../../docs/operations.md#runbooks).

## Tests
`docker compose up -d && pnpm --filter @boxoffice/payments test` (Postgres; Redpanda for `src/ops.e2e.test.ts`, which runs the built service against a private scratch database it creates and drops, because the sweeper and relay would otherwise act on rows of other tests) runs unit tests, deterministic race tests, a crash at every named boundary (`FaultHook`: before/after charge, confirm, refund, transition), a reusable PSP contract suite (`src/psp.contract.ts`, any adapter must pass it) and a fast-check model-based test (random crashes, confirm answers, PSP latency and failures, 1 to 4 concurrent runners; invariants: one terminal state and one event per payment, money conservation, at most one refund per charge). `SAGA_RUNS=300` raises the number of generated scenarios. The PSP contract is exercised against the fake PSP in `src/psp.contract.test.ts`; `src/trace.test.ts` checks the trace stored on the payment row; `src/internal-auth.test.ts` (token check, constant-time helper, 401 before body parsing, deny by default), `src/payments.controller.test.ts` (server-side price, key conflict as 409) and the key-scoping tests in `src/payments.test.ts`; `src/ops.e2e.test.ts` also runs the real process for 401/400/409 and the production refusals. There are no coverage thresholds for this package yet; The mutation runner covers the saga and the authentication, price and key-scoping rules (ids `pay-*`); it refuses `main.ts`, `db.ts` and `app.module.ts`, so the rules live in `internal-auth.ts`, the controller and the service. The general testing guide, [testing](../../docs/testing.md), does not describe this package's suite.
