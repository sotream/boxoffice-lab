# inventory

Interview question: **"How do you prevent double booking when thousands of users fight for the same seats?"**

## Requirements
- FR: hold 1-8 seats for 10 minutes, confirm a hold into a sale, show availability.
- FR: holds expire without a background job (expiry is evaluated at read/write time).
- NFR: a seat is never sold or held twice (correctness beats availability).
- NFR: flash sale of a 20k-seat event: ~50k users in 60 s, p99 < 100 ms for a hold.

## Endpoints
Port 3101. Seat ids: 1 to 8 per request, otherwise 400.

| Method and path | Body or query | Answer |
|---|---|---|
| `POST /events/:id/holds?strategy=atomic-update\|for-update` | `{seatIds, userId}` | 201 `{seatIds, holdUntil}`, 409 when any seat is taken (all-or-nothing) |
| `POST /events/:id/confirm` | `{seatIds, userId}` | 201 `{sold}` (Nest's default for POST), 409 when the hold is missing, expired or not the caller's. All-or-nothing in a transaction; idempotent for the owner |
| `GET /events/:id/availability` | | `{free, held, sold}` |
| `GET /healthz`, `/readyz`, `/metrics` | | see Operations |

## Data model
`seats(event_id, seat_id, status, held_by, hold_until)`, PK `(event_id, seat_id)`. One row per seat. Status is `free|held|sold`; a held row with `hold_until < now()` counts as free.

See [CAPACITY.md](CAPACITY.md), [adr/](adr/), [RESULTS.md](RESULTS.md).

## Environment
Read and validated at start (`src/main.ts`); bad values exit with code 78. Start with `pnpm --filter @boxoffice/inventory start` after `pnpm build`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3101 | HTTP port |
| `DATABASE_URL` | `postgres://lab:lab@localhost:55432/lab` | Postgres (read by `@boxoffice/platform`) |
| `PG_POOL` | 20 | Work pool size |
| `SEED_SEATS` | 0 | When above 0, deletes and re-creates the seats of event 1 at start |
| `SHUTDOWN_DEADLINE_MS` | 10000 | Total time for graceful shutdown, minimum 100 |
| `SHUTDOWN_DRAIN_DELAY_MS` | 0 | Wait after going not-ready, so a load balancer notices |
| `LOG_LEVEL` | `info` (`silent` under tests) | trace, debug, info, warn, error, fatal, silent |

## Operations
- Every process serves `GET /healthz` (liveness, never calls a dependency), `GET /readyz` (readiness) and `GET /metrics` (Prometheus) on `PORT`. Readiness: Postgres is critical (own 1-connection pool).
- Metrics of this service: `inventory_holds_total{strategy,result}`, `inventory_confirms_total{result}`, `pg_pool_*`, `http_*`. Series definitions: the generated table in [operations.md](../../docs/operations.md#metric-catalogue).
- Logs are JSON lines on stdout with `requestId`, `traceId` and `spanId`; `x-request-id` and `traceparent` are accepted and propagated ([Correlation](../../docs/operations.md#correlation-one-id-per-purchase)).
- Shutdown (SIGTERM or SIGINT): goes not-ready, drains in-flight requests, closes the work and readiness pools. All steps share `SHUTDOWN_DEADLINE_MS`; a second signal exits 1 at once ([Graceful shutdown](../../docs/operations.md#graceful-shutdown)).
- Invalid configuration exits with code 78 and one message listing every problem ([Configuration and boot](../../docs/operations.md#configuration-and-boot)).
- Runbooks for the drills that hit this service: [operations.md](../../docs/operations.md#runbooks).

## Tests
`docker compose up -d postgres && pnpm --filter @boxoffice/inventory test` (needs Postgres; test files run one after another because they share it).
- `src/inventory.test.ts`: example tests for both strategies (100 concurrent holders, all-or-nothing, expiry, owner-only confirm, ordered locking statement).
- `src/model.test.ts`: fast-check model-based and concurrent tests against the real database (event ids 9000 to 9099). Replay a failure with `FC_SEED=<seed>`.
- `src/controller.test.ts`: body validation; `src/ops.e2e.test.ts`: the built service as a child process (health, metrics, SIGTERM during an in-flight request).
- Coverage: `pnpm --filter @boxoffice/inventory exec vitest run --coverage` (thresholds in `vitest.config.ts`). Mutations of this package: `node scripts/mutation-check.mjs --only inv-confirm-expiry` (see [testing](../../docs/testing.md)).
