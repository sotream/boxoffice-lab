# gateway

Interview questions: **"Design a rate limiter"** and **"How does the edge enforce the waiting room?"**

## Requirements
- FR: single entry point; routes `queue/*` to waiting-room and `holds|confirm|availability` to inventory.
- FR: `holds` and `confirm` need a valid admission token; otherwise 403 without touching inventory.
- FR: per-IP limit on public endpoints, per-user limit on holds; 429 with `Retry-After`.
- NFR: limiter must be correct across many gateway instances and add < 10 ms.

## Design
- Rate limiter: **token bucket in Redis**, one Lua script (read, refill, take, write) = atomic, one round trip. Time comes from Redis `TIME`, so all instances share one clock. Idle keys expire.
- Admission token: `user.event.expiry.HMAC-SHA256`, issued by waiting-room, verified by the gateway **without any Redis call** (`packages/admission`).
- The gateway is plain Fastify, not a Nest app: it is the hot path and has no business logic. In production this role is Envoy/Kong/an API gateway; the lab keeps it in code so the policy is readable.
- Client IP for the per-IP limit is the socket address; `x-forwarded-for` is ignored unless the peer is listed in `TRUST_PROXY` (comma-separated addresses or CIDRs). Behind a load balancer set it, or every client shares the balancer's bucket. Covered by `app.test.ts`.

## Endpoints
Port 3100 (public). Anything else is 404, including `/healthz`, `/readyz` and `/metrics`, which are served only on the ops port (see Operations). The admission token goes in the `x-admission` header (as returned by waiting-room `status`).

| Route | Forwarded to | Policy |
|---|---|---|
| `POST /events/:id/queue/join`, `GET /events/:id/queue/status` | waiting-room | per-IP bucket; fails closed (503) if Redis is down |
| `GET /events/:id/availability` | inventory | per-IP bucket; fails open if Redis is down |
| `POST /events/:id/holds`, `POST /events/:id/confirm` | inventory | valid admission token for that event (else 403, inventory untouched), per-user bucket (429), then the body `userId` must equal the token's user (else 403; not JSON: 400); any other method is 405; fails closed (503) |
| `GET /healthz`, `/readyz`, `/metrics` | not served here: 404 on this port | ops port `OPS_PORT`, see Operations |

Other statuses: 429 with `Retry-After: 1` when limited, 504 when the upstream times out or is unreachable.

See [CAPACITY.md](CAPACITY.md), [adr/](adr/), [RESULTS.md](RESULTS.md).

## Environment
Read and validated at start (`src/main.ts`); bad values exit with code 78. Start with `pnpm --filter @boxoffice/gateway start` after `pnpm build`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3100 | Public HTTP port |
| `OPS_PORT` | 3106 | Internal port for `/healthz`, `/readyz`, `/metrics`; the process exits if it cannot bind it |
| `OPS_HOST` | 127.0.0.1 | Address the ops port binds to. Loopback by default so the ops endpoints are not reachable from wherever `PORT` is; in a container set `0.0.0.0` and keep the port off the public network. The `observability` compose profile scrapes the host through `host.docker.internal`, so it needs `OPS_HOST=0.0.0.0` |
| `REDIS_URL` | `redis://localhost:56379` | Limiter store |
| `INVENTORY_URL` | `http://localhost:3101` | Upstream |
| `QUEUE_URL` | `http://localhost:3102` | Upstream (waiting-room) |
| `ADMISSION_SECRET` | `dev-secret` | Must equal the waiting-room's. With `NODE_ENV=production` it must be set and not `dev-secret`, otherwise exit 78 |
| `IP_RATE`, `IP_BURST` | 50, 100 | Per-IP bucket, tokens per second and burst |
| `USER_RATE`, `USER_BURST` | 5, 10 | Per-user bucket |
| `UPSTREAM_TIMEOUT_MS` | 2000 | Upstream timeout, answered as 504 |
| `TRUST_PROXY` | empty | Comma-separated addresses or CIDRs of proxies in front; empty means `x-forwarded-for` from clients is ignored. For a trusted peer the chain is kept and the peer address is appended |
| `SHUTDOWN_DEADLINE_MS` | 10000 | Total time for graceful shutdown, minimum 100 |
| `SHUTDOWN_DRAIN_DELAY_MS` | 0 | Wait after going not-ready, so a load balancer notices |
| `LOG_LEVEL` | `info` (`silent` under tests) | trace, debug, info, warn, error, fatal, silent |

## Operations
- Every process serves `GET /healthz` (liveness, never calls a dependency), `GET /readyz` (readiness) and `GET /metrics` (Prometheus) on `OPS_PORT` (3106), never on the public `PORT`: the metrics and the raw dependency errors in `/readyz` are internal. Readiness: Redis is reported but not critical, because availability fails open and a Redis outage must not pull every instance out of rotation.
- Metrics of this service: `gateway_limiter_decisions_total{limiter,decision}`, `gateway_admission_rejected_total`, `gateway_upstream_duration_seconds{upstream}`, `gateway_upstream_errors_total{upstream,reason}`, `http_*` (route label is bounded to the five routes or `unmatched`). Series definitions: the generated table in [operations.md](../../docs/operations.md#metric-catalogue).
- Logs are JSON lines on stdout with `requestId`, `traceId` and `spanId`; `x-request-id` and `traceparent` are accepted and propagated ([Correlation](../../docs/operations.md#correlation-one-id-per-purchase)).
- Shutdown (SIGTERM or SIGINT): goes not-ready, drains in-flight requests, closes Redis. All steps share `SHUTDOWN_DEADLINE_MS`; a second signal exits 1 at once ([Graceful shutdown](../../docs/operations.md#graceful-shutdown)).
- Invalid configuration exits with code 78 and one message listing every problem ([Configuration and boot](../../docs/operations.md#configuration-and-boot)).
- Runbooks for the drills that hit this service: [operations.md](../../docs/operations.md#runbooks).

## Tests
`docker compose up -d redis && pnpm --filter @boxoffice/gateway test`. The tests import `@boxoffice/admission` through its built `dist/`: run `pnpm build` first.
- `src/policy.test.ts`: every route x token state x limiter state gives the documented status (fakes, no infrastructure).
- `src/rate-limiter.properties.test.ts`: the Lua bucket against an exact model on a controllable clock, window bound with real time, exact count under concurrency (Redis keys `rl:prop:*`).
- `src/app.test.ts` (client IP, `TRUST_PROXY`, spoofed `x-forwarded-for`), `src/gateway.test.ts`, `src/ops.test.ts`, `src/shutdown.e2e.test.ts` (SIGTERM during an in-flight request).
- Coverage: `pnpm --filter @boxoffice/gateway exec vitest run --coverage`. Mutations: ids `gw-*` ([testing](../../docs/testing.md)).
