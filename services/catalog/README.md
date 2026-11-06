# catalog

Interview questions: **"Design search for an events site"**, **"Postgres full-text vs Elasticsearch"**, **"Where does the cache go and what breaks it?"**

## Requirements
- FR: search events by words, optional city filter; fetch one event by id.
- NFR: read-heavy (100:1 vs writes), p99 < 50 ms, tolerate seconds of staleness (a renamed event may show the old title for <= 36 s: 30 s TTL, +-20% jitter).

## Endpoints
Port 3104.

| Method and path | Query | Answer |
|---|---|---|
| `GET /search` | `q`, `city`, `strategy=ilike\|fts\|fts-date`, `cache=0\|1` | matching events; 400 for NUL bytes or invalid input, never a 5xx for hostile input |
| `GET /events/:id` | | one event; 404 for an unknown id or one beyond int4 |
| `GET /healthz`, `/readyz`, `/metrics` | | see Operations |

## Design
Postgres table with a generated `tsvector` column and a GIN index; Redis cache-aside in front with single-flight and TTL jitter. Three search strategies are kept side by side on purpose, so the numbers can be compared.

See [CAPACITY.md](CAPACITY.md), [adr/](adr/), [RESULTS.md](RESULTS.md).

## Environment
Read and validated at start (`src/main.ts`); bad values exit with code 78. Start with `pnpm --filter @boxoffice/catalog start` after `pnpm build`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3104 | HTTP port |
| `DATABASE_URL` | `postgres://lab:lab@localhost:55432/lab` | Postgres |
| `PG_POOL` | 20 | Work pool size |
| `REDIS_URL` | `redis://localhost:56379` | Cache |
| `CACHE_TTL` | 30 | Cache TTL in seconds (jitter +-20%) |
| `SEED_EVENTS` | 0 | When above 0, truncates `catalog.events` and seeds that many synthetic events |
| `SHUTDOWN_DEADLINE_MS` | 10000 | Total time for graceful shutdown, minimum 100 |
| `SHUTDOWN_DRAIN_DELAY_MS` | 0 | Wait after going not-ready, so a load balancer notices |
| `LOG_LEVEL` | `info` (`silent` under tests) | trace, debug, info, warn, error, fatal, silent |

## Operations
- Every process serves `GET /healthz` (liveness, never calls a dependency), `GET /readyz` (readiness) and `GET /metrics` (Prometheus) on `PORT`. Readiness: Postgres is critical; Redis is reported but not critical (a failure acts as a cache miss).
- Metrics of this service: `catalog_cache_requests_total{result}`, `catalog_db_query_duration_seconds{op}`, `pg_pool_*`, `http_*`. Series definitions: the generated table in [operations.md](../../docs/operations.md#metric-catalogue).
- Logs are JSON lines on stdout with `requestId`, `traceId` and `spanId`; `x-request-id` and `traceparent` are accepted and propagated ([Correlation](../../docs/operations.md#correlation-one-id-per-purchase)).
- Shutdown (SIGTERM or SIGINT): goes not-ready, drains requests, closes the Postgres pools and Redis. All steps share `SHUTDOWN_DEADLINE_MS`; a second signal exits 1 at once ([Graceful shutdown](../../docs/operations.md#graceful-shutdown)).
- Invalid configuration exits with code 78 and one message listing every problem ([Configuration and boot](../../docs/operations.md#configuration-and-boot)).
- Runbooks for the drills that hit this service: [operations.md](../../docs/operations.md#runbooks).

## Tests
`docker compose up -d postgres redis && pnpm --filter @boxoffice/catalog test`.
- `src/catalog.test.ts`: example tests (single-flight, staleness, strategies). `src/properties.test.ts`: TTL jitter bounds, cache equals database at fill time, unambiguous cache key, input fuzz with no 5xx and no SQL interpolation.
- `src/ops.e2e.test.ts`: the built service as a child process. `seed()` truncates `catalog.events`, so do not run this package in parallel with a catalog load run.
- Coverage: `pnpm --filter @boxoffice/catalog exec vitest run --coverage`. Mutations: ids `cat-*` ([testing](../../docs/testing.md)).
