# Development guide

How to set up, run, test and extend the repository. The proof side is in [testing.md](testing.md), the operating side in [operations.md](operations.md).

## Setup

Requirements: Node 26, pnpm (the root `package.json` pins `packageManager`), Docker, [k6](https://k6.io) for the load scripts only.

```bash
docker compose up -d      # Postgres 18 :55432, Redis 7 :56379, Redpanda :59092 (user, password and database: lab)
pnpm install
pnpm build                # pnpm -r build: tsc in every package; services and the load scripts run dist/
pnpm ops:check            # no infrastructure needed
```

All three compose services have a healthcheck, so `docker compose ps` shows Postgres, Redis and Redpanda as healthy once they are ready, and scripts can wait for that with `docker compose up -d --wait`.

Root scripts:

| Script | What it does |
|---|---|
| `pnpm build` | compiles every package |
| `pnpm test` | `pnpm -r --workspace-concurrency=1 test`: packages one after another, because they share one Postgres and one Redis |
| `pnpm test:coverage` | same, with `vitest run --coverage`; thresholds are in each package's `vitest.config.ts` |
| `pnpm test:mutation` | `scripts/mutation-check.mjs`: breaks the production code one way at a time and requires the tests to fail (about 6 minutes, edits and restores source files; do not edit sources while it runs) |
| `pnpm ops:check` | alert rules, runbooks and the metric table in `docs/operations.md` against the code |

Connection defaults come from `@boxoffice/platform`: `DATABASE_URL` defaults to `postgres://lab:lab@localhost:55432/lab`. Services default to Redis `redis://localhost:56379` and broker `localhost:59092`.

## Running one service

```bash
pnpm build
SEED_SEATS=20000 PORT=3101 pnpm --filter @boxoffice/inventory start
curl -s localhost:3101/readyz
# inventory refuses unsigned requests (401): sign one with the helper of the drills, or go through the gateway (localhost:3100)
node -e 'import("./drills/internal-sign.mjs").then(async ({ signInternal }) => console.log(await (await fetch("http://localhost:3101/events/1/availability", { headers: signInternal("GET", "/events/1/availability", "", "inventory") })).text()))'
```

`start` is `node dist/main.js` in the package directory, so rebuild after a change (`pnpm --filter @boxoffice/inventory build`). Ports, endpoints and every variable of a service are in its README (Endpoints, Environment). A bad variable exits with code 78 and prints every problem. Seeding variables are destructive: `SEED_SEATS` deletes and re-creates event 1's seats, `SEED_EVENTS` truncates `catalog.events`.

Dependencies per service: inventory and catalog need Postgres (catalog also Redis), waiting-room and gateway need Redis, payments needs Postgres and Redpanda (it connects its producer at start), notifications needs Postgres and Redpanda. For the system-level picture start inventory, waiting-room, gateway and payments as in the [README quick start](../README.md#quick-start).

Logs are JSON lines. Use `LOG_LEVEL=debug` to see one line per request.

## Running the failure drills

The drills are plain Node scripts in `drills/` (results and context: [failure-drills.md](failure-drills.md)). They are destructive for the shared infrastructure:

- they stop and start the compose containers (`boxoffice-lab-redis-1`, `boxoffice-lab-redpanda-1`; the scripts use these container names, which assume the compose project name `boxoffice-lab`, i.e. the checkout directory name);
- `consumer-kill.mjs` and `dlq-replay.mjs` run `TRUNCATE notifications.deliveries`;
- they use the live databases, so run them alone: not during `pnpm test`, a load run or another drill.

```bash
docker compose up -d
pnpm build
node drills/redis-down.mjs      # needs inventory 3101, waiting-room 3102, gateway 3100 running
node drills/kafka-down.mjs      # needs inventory 3101, payments 3103 running (the drills sign with PAYMENTS_INTERNAL_TOKEN and INVENTORY_INTERNAL_TOKEN, defaults dev-internal-token and dev-inventory-internal-token)
node drills/consumer-kill.mjs   # starts and kills its own consumers (notifications built)
node drills/slow-psp.mjs 20000  # needs inventory 3101 and payments 3103 started with PSP_ADMIN=1
node drills/dlq-replay.mjs      # needs the notifications package built; runs its own consumer
```

Timings vary between runs on a laptop; the drills assert invariants (no lost events, no duplicates, no errors on the fail-open route). The saved outputs are in `docs/drill-output/`.

## Running the fault suite (outages, crashes, hold expiry, several instances)

`pnpm test:e2e:faults` runs the scenarios of [e2e.md](e2e.md#fault-suite-pnpm-teste2efaults) in `packages/e2e/src/faults/`. It needs the docker CLI and `pnpm -r build`, and takes about 6 minutes. Unlike the failure drills above it does **not** touch the compose containers or the shared databases: every scenario starts private Postgres, Redis and Redpanda containers (`boxoffice-e2e-<pid>-<n>-<kind>`, random ports, the images of `docker-compose.yml`), stops, pauses or kills those, and removes them again; a leftover container fails the run. If a run is killed hard and containers remain, the next run removes those whose owner pid is gone, or remove them by hand:

```bash
docker ps -a --filter name=boxoffice-e2e- --format '{{.Names}}'
docker rm -f -v $(docker ps -aq --filter name=boxoffice-e2e-)
pnpm --filter @boxoffice/e2e exec vitest run -c vitest.faults.config.ts redis-outage   # one scenario
```

## Running the load scripts

Commands and variables per service are in the [README quick start](../README.md#quick-start) (a table). Notes:

- `load/run.sh` of inventory and catalog start the service themselves and seed data (100 000 seats for event 1; 200 000 catalog events): they overwrite those tables.
- The catalog script uses the container name `boxoffice-lab-redis-1`.
- k6 and the server share the machine in the saved runs, so latency under a high VU count is dominated by the load generator; compare like with like and read the caveats in each `RESULTS.md`.
- `scripts/bench.sh <scenario> [runs]` (scenarios `inventory`, `waiting-room`, `payments`, `catalog`, `gateway`, `notifications`, `all`) runs the same k6 scripts (for `notifications`: `load/bench.js`) several times and reports median, min and max; method and results: [benchmarks.md](benchmarks.md).
- Saved raw output is in `docs/load-output/`. The first-run figures in the `RESULTS.md` files predate the platform instrumentation and were measured on PostgreSQL 17; most services have a later section measured on the final code, and a new run on the current stack is a new measurement, not a confirmation.

## Writing a property test

Property tests use [fast-check](https://fast-check.dev) inside vitest. The existing ones to copy from: `services/inventory/src/model.test.ts` (model-based, Postgres), `services/waiting-room/src/properties.test.ts` (Redis), `services/gateway/src/rate-limiter.properties.test.ts`, `packages/admission/src` (pure).

1. Write a tiny in-memory reference model of the behaviour (a map of seat state, a list for a queue). Keep it obviously correct.
2. Generate command sequences (`fc.array(fc.oneof(...))`) and run each command against the real store and the model; compare answers and state after every command.
3. For concurrency, generate a batch of commands, run them with `Promise.all`, and assert global invariants that hold for any interleaving (no seat won twice, totals add up, nobody lost). Do not assert an order that the system does not define.
4. Pick `numRuns` deliberately: 25 to 100 for database-backed properties, hundreds to thousands for pure functions, so the package stays under about 20 seconds.
5. Read the seed from `FC_SEED` and pass it to `fc.assert(..., { seed })`, so a failure can be replayed: `FC_SEED=<seed> pnpm --filter @boxoffice/inventory test`.
6. Use your own key range (inventory events 9000 to 9099, waiting-room events 9100 to 9199, notifications outbox ids from 9 000 000, Redis keys `rl:prop:*` and `t:prop:*`) and clean only that range in `afterAll`. Never flush a database.
7. When a property finds a bug, fix it minimally and keep the shrunk counterexample as a regression test; add a row to "Bugs found" in [testing.md](testing.md).

## Adding a mutation

A mutation is an entry in `scripts/mutations.json`:

```json
{
  "id": "inv-confirm-owner",
  "package": "@boxoffice/inventory",
  "file": "services/inventory/src/inventory.service.ts",
  "find": "exact text in the file, appearing once",
  "replace": "the broken text",
  "expectFailingTests": ["names of tests that must appear in the failing output"],
  "description": "what it breaks, in one line"
}
```

1. Make the smallest change that a real bug could look like (drop a check, flip a comparison, remove an `ORDER BY`).
2. `node scripts/mutation-check.mjs --list` to see the ids, `node scripts/mutation-check.mjs --only <id>` to run one.
3. It must be killed: the run fails and one of `expectFailingTests` is in the output. If it survives, the tests have a hole: add or sharpen a test (that is the point), do not weaken the mutation.
4. The runner refuses `packages/platform/`, `src/main.ts`, `src/db.ts`, `src/app.module.ts`, `app.ts`, test files and `package.json` files, and restores the file byte for byte even on SIGINT. Details and the current result table: [testing.md](testing.md#mutation-check).

## Adding a metric (and the consistency rule)

Define it with the platform helpers in the service's `src/metrics.ts`, with a string-literal name, a literal help text and an array literal of label names, because `ops/catalogue.mjs` finds metrics by scanning the source for `counter(`, `gauge(` and `histogram(`:

```ts
import { counter } from "@boxoffice/platform";
export const refunds = counter("payments_refunds_total", "Refunds issued by result.", ["result"]);
```

Rules:

- A metric name is defined once in the whole repository (the scanner fails on duplicates) and carries a service prefix (`payments_`, `waitingroom_`); the HTTP and pool metrics come from the platform.
- Labels must be bounded: a route pattern, a fixed set of states or results. Never a user id, seat id, event id or request id.
- Regenerate the table in `docs/operations.md`: `node ops/check.mjs --write`. `pnpm ops:check` (and the platform test `ops-consistency.test.ts`, and CI) fails when the table is stale, or when `ops/alerts.yml` names a metric or label no service defines, or an alert lacks `severity`, `route`, `slo`, `summary` or `runbook`.
- If the metric deserves an alert, add the rule to `ops/alerts.yml` with a runbook anchor, and describe the action in the matching runbook of [operations.md](operations.md#runbooks). Mark guessed thresholds "starting value".
- Validate rule syntax with promtool as shown in operations.md.

## Adding a service: wiring checklist

Use `services/inventory` (Nest) or `services/gateway` (plain Fastify) as the template. Everything below comes from `@boxoffice/platform`.

1. `package.json` with `build`, `start` and `test` scripts and a dependency on `@boxoffice/platform`; the workspace already includes `services/*`.
2. In `main.ts`, first line: `const log = initService("<name>")`; it sets the process name for logs and metrics.
3. Configuration: `loadConfigOrExit((e) => ({ port: e.port("PORT", 31xx), ..., shutdown: shutdownEnv(e) }))`. Use `e.secret(...)` for anything with a development default so production refuses it; keep every variable name and default documented in the service README.
4. Postgres: `createPool({ max, applicationName })` from the platform (statement timeout, connection timeout and the `error` handler included); `migrate(pool, dir)` for `migrations/*.sql` (each file is applied once and recorded in `public.schema_migrations`, with the statement timeout off; a new migration file is picked up on the next boot); `registerPoolMetrics(pool, "main")`. Use a separate 1-connection pool for readiness.
5. HTTP: Nest apps call `wireNest(app, readiness)`; Fastify apps call `instrumentFastify(app, ...)` and `registerOpsRoutes(app, { readiness })`. Do not put the probe endpoints behind authentication or rate limiting. A process without an HTTP API starts `startOpsServer(opsPort, readiness)` (see notifications).
6. Readiness: `new Readiness([pgCheck(healthPool), redisCheck(redis, "redis", false), tcpCheck(broker, "kafka")], { cacheMs: 1000 })`. Decide per dependency whether its failure should take the instance out of rotation (critical) or only be reported, and write the reason down in operations.md.
7. Background work: `startLoop({ name, intervalMs, fn, onError })`; it is stopped by the shutdown sequence.
8. Shutdown: `createShutdown({ ...cfg.shutdown, readiness })`, then `add(name, fn)` in order (http drain with `drainHttp`, loops, producers, pools, Redis), then `install()`.
9. Outgoing HTTP calls: send `outgoingHeaders()` so `x-request-id` and `traceparent` continue; log with the logger of `getLogger()` so lines carry the ids.
10. Metrics in `src/metrics.ts` as above; add the service to `SERVICES` (and the HTTP and pool lists if applicable) in `ops/catalogue.mjs` and a scrape job to `ops/prometheus.yml`.
11. Tests: an `ops.e2e.test.ts` that builds the package (`ensureBuilt`), starts it with `spawnService`, waits with `waitHealthy`, checks `/healthz`, `/readyz`, `/metrics`, and sends SIGTERM during an in-flight request. If the service has background workers (sweeper, relay) run it against `createScratchDatabase(...)`, so the workers do not touch rows other tests assert on. Give the package its own `vitest.config.ts` with `fileParallelism: false` and coverage thresholds if it has database tests.
12. Docs: the service README (Endpoints, Environment, Operations, Tests), `CAPACITY.md`, `RESULTS.md` (state where the numbers come from), ADRs with a status line, a row in [adr-index.md](adr-index.md) and in the README tables, and `node ops/check.mjs --write`.

## Troubleshooting: shared database races

All packages use one Postgres database and one Redis. The suites are written for that (own key ranges, no flushing, `fileParallelism: false`, packages run in sequence), so most flakiness has one cause: something else is using the same databases at the same time.

| Symptom | Likely cause | Fix |
|---|---|---|
| Two `pnpm test` runs, or a test run plus a load run or a drill, give sporadic assertion failures or deadlocks | they truncate or write the same tables (`catalog.events`, `notifications.deliveries`, seats of event 1) | run one thing at a time; `pnpm test` already serialises packages, do not use `pnpm -r test` without `--workspace-concurrency=1` |
| A payments or notifications test sees extra rows or an unexpected state transition | a service you started by hand (payments sweeper and relay, a notifications consumer) is acting on the shared tables | stop the hand-started services before running tests; e2e tests that start workers use a private scratch database for this reason |
| A drill left Redis or Redpanda stopped | the drill was interrupted | `docker compose up -d` |
| Gateway tests fail on token verification after a change in `packages/admission` | the gateway tests import the built `dist/` of admission | `pnpm --filter @boxoffice/admission build` |
| `ops.e2e` tests fail to import or start a service | they run the built `dist/main.js` | `pnpm build` (the tests also call `ensureBuilt`, which fails with the tsc output) |
| A property test fails once and not again | a real interleaving was found, not noise | rerun with the printed `FC_SEED`, shrink, and fix |
| The real-time token bucket window test fails once | the Redis server clock stepped during the run | rerun; it assumes a monotonic clock |
| A mutation run reports a build error instead of a kill | the mutation does not compile, or a different test run broke | the runner only counts a kill when a listed test name is in the output; check with `--only <id>` |
| Port already in use when starting a service | a previous service or e2e child is still running | stop it; the notifications consumer survives a taken `OPS_PORT` but loses its probe endpoints |

After a Redpanda image bump, a container recreated by Compose can fail with `incompatible logical version` because the old anonymous data volume is kept; `docker compose rm -sfv redpanda` removes the container and its volume (local lab data only), then `docker compose up -d --wait`.
