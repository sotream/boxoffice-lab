# waiting-room

Interview question: **"50 000 people open the sale page at the same second. How do you keep the backend alive?"**

## Requirements
- FR: join a virtual queue, poll position and ETA, get admitted for 5 minutes, re-join is idempotent.
- FR: admitted users, and only they, may call `inventory`.
- NFR: queue and polling must survive 10x more traffic than the protected service could ever take.
- NFR: FIFO fairness; no user overtakes another because of clock skew.

## Endpoints
Port 3102.

| Method and path | Body or query | Answer |
|---|---|---|
| `POST /events/:id/queue/join` | `{userId}` | 201 `{position}`; idempotent, keeps the place. 400 without a `userId` |
| `GET /events/:id/queue/status?userId=` | | `{state:"waiting", position, etaSeconds}`, `{state:"admitted", ttl, token}` (the signed admission token, `user.event.expiry.HMAC`) or `{state:"unknown"}` |
| `GET /healthz`, `/readyz`, `/metrics` | | see Operations |

## Design
Redis sorted set `wr:{event}:queue`; score = `INCR` sequence (not a timestamp), `ZADD NX` makes join idempotent. A tick every 100 ms does `ZPOPMIN n` and writes `admitted:{user}` keys with a 300 s TTL. The admission rate is a configured budget (`ADMIT_PER_SECOND`), derived from the protected service's capacity. Lab limit: `main.ts` runs the tick for event 1 only.

See [CAPACITY.md](CAPACITY.md), [adr/](adr/), [RESULTS.md](RESULTS.md).

## Environment
Read and validated at start (`src/main.ts`); bad values exit with code 78. Start with `pnpm --filter @boxoffice/waiting-room start` after `pnpm build`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3102 | HTTP port |
| `REDIS_URL` | `redis://localhost:56379` | Redis |
| `REDIS_COMMAND_TIMEOUT_MS` | 1000 | Deadline of each Redis command on the request path, readiness and metrics (50 to 7000). A command that does not answer in time (a silent network partition, a hung Redis) makes `join` and `status` answer `503` with `Retry-After: 1` instead of waiting for the gateway's 8 s timeout. Not applied to the admission tick, see Operations |
| `ADMISSION_SECRET` | `dev-secret` | HMAC key shared with the gateway. With `NODE_ENV=production` it must be set and not `dev-secret`, otherwise the process exits 78 |
| `ADMIT_PER_SECOND` | 500 | Admission budget; the tick admits a tenth of it every 100 ms for event 1 |
| `SHUTDOWN_DEADLINE_MS` | 10000 | Total time for graceful shutdown, minimum 100 |
| `SHUTDOWN_DRAIN_DELAY_MS` | 0 | Wait after going not-ready, so a load balancer notices |
| `LOG_LEVEL` | `info` (`silent` under tests) | trace, debug, info, warn, error, fatal, silent |

## Operations
- Every process serves `GET /healthz` (liveness, never calls a dependency), `GET /readyz` (readiness) and `GET /metrics` (Prometheus) on `PORT`. Readiness: Redis is critical (the queue lives there).
- Redis unavailable: `POST /queue/join` and `GET /queue/status` answer `503` with `Retry-After: 1` (the answer clients already retry; the gateway passes the header on) when a Redis command times out or the connection is refused or closed; other errors stay `500`. The admission tick uses its own Redis client without a command timeout: a `ZPOPMIN` that timed out could still run at the heal and pop users without writing their admission keys, so during a silent partition the tick waits on one command and resumes when the path heals (it counts no error meanwhile; watch `/readyz` and `waitingroom_admitted_total`). Measured in [F14](../../docs/e2e.md#redis-clients-in-a-silent-partition-f13-f14).
- Metrics of this service: `waitingroom_joins_total{result}`, `waitingroom_admitted_total`, `waitingroom_admission_errors_total`, `waitingroom_queue_length` (event 1), `http_*`. Series definitions: the generated table in [operations.md](../../docs/operations.md#metric-catalogue).
- Logs are JSON lines on stdout with `requestId`, `traceId` and `spanId`; `x-request-id` and `traceparent` are accepted and propagated ([Correlation](../../docs/operations.md#correlation-one-id-per-purchase)).
- Shutdown (SIGTERM or SIGINT): goes not-ready, drains requests, stops the admission tick, closes Redis. All steps share `SHUTDOWN_DEADLINE_MS`; a second signal exits 1 at once ([Graceful shutdown](../../docs/operations.md#graceful-shutdown)).
- Invalid configuration exits with code 78 and one message listing every problem ([Configuration and boot](../../docs/operations.md#configuration-and-boot)).
- Runbooks for the drills that hit this service: [operations.md](../../docs/operations.md#runbooks).

## Tests
`docker compose up -d redis && pnpm --filter @boxoffice/waiting-room test`.
- `src/queue.test.ts`: example tests. `src/properties.test.ts`: list-and-set model compared after every command, happens-before FIFO, concurrent joins and admits (event ids 9100 to 9199). Replay with `FC_SEED=<seed>`.
- `src/http.test.ts`: input validation at the HTTP edge; `src/ops.e2e.test.ts`: the built service as a child process.
- Coverage: `pnpm --filter @boxoffice/waiting-room exec vitest run --coverage`. Mutations: ids `wr-*` in `scripts/mutations.json` ([testing](../../docs/testing.md)).
