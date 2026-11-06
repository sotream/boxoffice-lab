# payments

Interview questions: **"How do you make payments safe to retry?"**, **"Saga vs 2PC"**, **"How do you publish an event and update the DB atomically?"**

## Requirements
- FR: pay for held seats with an `Idempotency-Key`; on success confirm the seats in inventory.
- FR: if the hold expired by the time the money is taken, refund automatically (compensation).
- FR: emit `payment.confirmed|refunded|failed` events for notifications.
- NFR: never charge twice, never lose an event, survive a crash at any step.

## Saga (orchestrated by this service)
`PENDING --charge--> CHARGED --confirm seats--> CONFIRMED`
`CHARGED --seats lost--> REFUNDING --refund--> REFUNDED` (compensation; `REFUNDING` is claimed by compare-and-set BEFORE the refund is issued, ADR 005) and `PENDING --charge declined--> FAILED`. `REFUNDING` is in progress, not final: `pay()` answers 202 and the sweeper resumes it.
Every transition is a compare-and-set `UPDATE ... WHERE status = <from>` plus an outbox row in the **same transaction**. `resume(id)` continues from the stored state after a crash.

## Outbox relay
A loop reads unpublished outbox rows (`FOR UPDATE SKIP LOCKED`), sends them to Kafka (Redpanda) with `acks=-1`, then marks them published. Delivery is **at-least-once**; consumers deduplicate by `outboxId`.

## Timeouts and the 202 answer
Each outside step (PSP, inventory confirm) is bounded at 2 s. On timeout the API answers **202** `{status, inProgress: true}`; repeat the call with the same `Idempotency-Key` to read the final state. A timeout is an unknown outcome, never a reason to refund; a sweeper resumes sagas stuck in `PENDING`, `CHARGED` or `REFUNDING` (ADR 004, drill 4). `POST /admin/psp` (only with `PSP_ADMIN=1`) changes the fake PSP latency for drills.

The correlation of the request that created the payment (`{requestId, traceparent}`) is stored on the payment row (`migrations/002_trace.sql`), so a saga finished by the sweeper after a 202 still writes its outbox events and Kafka headers under the original trace.

See [CAPACITY.md](CAPACITY.md), [adr/](adr/), [RESULTS.md](RESULTS.md).

## Endpoints
Port 3103.

| Method and path | Body or header | Answer |
|---|---|---|
| `POST /payments` | header `Idempotency-Key` (required), body `{eventId, userId, seatIds, amountCents}` | 200 `{status, paymentId, inProgress:false}` for a final state (`CONFIRMED`, `REFUNDED`, `FAILED`); 202 with `inProgress:true` while the saga is not final (`PENDING`, `CHARGED`, `REFUNDING`); 400 on a missing key or invalid body |
| `POST /admin/psp` | `{latencyMs}` | only with `PSP_ADMIN=1`: sets the fake PSP latency (drills) |
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
| `PSP_ADMIN` | 0 | `1` enables `POST /admin/psp` |
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
`docker compose up -d && pnpm --filter @boxoffice/payments test` (Postgres; Redpanda for `src/ops.e2e.test.ts`, which runs the built service against a private scratch database it creates and drops, because the sweeper and relay would otherwise act on rows of other tests) runs unit tests, deterministic race tests, a crash at every named boundary (`FaultHook`: before/after charge, confirm, refund, transition), a reusable PSP contract suite (`src/psp.contract.ts`, any adapter must pass it) and a fast-check model-based test (random crashes, confirm answers, PSP latency and failures, 1 to 4 concurrent runners; invariants: one terminal state and one event per payment, money conservation, at most one refund per charge). `SAGA_RUNS=300` raises the number of generated scenarios. The PSP contract is exercised against the fake PSP in `src/psp.contract.test.ts`; `src/trace.test.ts` checks the trace stored on the payment row. There are no coverage thresholds for this package yet; `scripts/mutation-check.mjs` refuses to mutate payments. The general testing guide, [testing](../../docs/testing.md), does not describe this package's suite.
