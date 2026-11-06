# Operations

What you need to run the system and to be paged for it sensibly: how to see it (health, metrics, logs, traces), what "good" means for the flash-sale journey (SLIs and SLOs), when to wake someone (burn-rate alerts), and what to do for each failure the drills exercise.

Everything here is checked against the code where that is cheap: `node ops/check.mjs` fails if an alert rule names a metric or a label that no service defines, or if the metric table below is stale. Numbers that are targets or starting values say so. The only measured number is the instrumentation overhead in [the last section](#overhead).

## What every process exposes

| Endpoint | Purpose | Calls dependencies |
|---|---|---|
| `GET /healthz` | Liveness: the process runs and its event loop answers. 200 `{"status":"ok"}` | never |
| `GET /readyz` | Readiness: should traffic be sent here. 200, or 503 with a per-dependency JSON body (`{"status":"not_ready","checks":{"postgres":{"ok":false,"critical":true,"latencyMs":1000,"error":"postgres timed out after 1000 ms"}}}`) | Postgres / Redis / Kafka, 1 s timeout each, result cached 1 s |
| `GET /metrics` | Prometheus text format | Postgres only for the payments gauges (below) |

Ports: gateway 3100, inventory 3101, waiting-room 3102, payments 3103, catalog 3104. The notifications consumer has no API, so a tiny server on `OPS_PORT` (default 3105) serves the same three endpoints; if that port is taken the consumer still runs and logs a warning.

Liveness never touches a dependency, because restarting a healthy process does not repair a dead database. Probe endpoints are not counted in the request metrics, so health checks do not dilute the success ratio.

Readiness is deliberate per service (critical = a failure returns 503):

| Service | Postgres | Redis | Kafka | Why |
|---|---|---|---|---|
| gateway | - | non-critical | - | Availability fails open when the limiter store is down, so a Redis outage degrades the gateway but must not pull every instance out of rotation at once |
| inventory | critical | - | - | cannot hold seats without it |
| waiting-room | - | critical | - | the queue lives in Redis |
| payments | critical | - | non-critical | the outbox exists so payments keep working while the broker is down (drill 2) |
| catalog | critical | non-critical | - | Redis is only a cache; a failure acts as a miss |
| notifications | critical | - | critical | cannot consume or record deliveries without them |

The Postgres check runs on its own one- or two-connection pool, not the work pool. Otherwise a saturated work pool would flip readiness and every instance would leave rotation at the moment capacity matters most. While shutting down, `/readyz` answers 503 `{"status":"shutting_down"}`.

## Correlation: one id per purchase

- The gateway accepts `x-request-id` (printable, at most 128 characters, otherwise replaced) and the W3C `traceparent`. If there is no valid `traceparent` it becomes the trace root and generates the trace id. The response always carries `x-request-id`.
- Every hop creates a new span id and keeps the caller's span as parent. Outgoing calls (gateway to inventory / waiting-room, payments to inventory confirm) send `x-request-id` and `traceparent` with the sending hop's span.
- Every log line written inside a request has `requestId`, `traceId`, `spanId` and `parentSpanId`.
- Payments to notifications: the outbox payload gets `trace: { requestId, traceparent }`, the relay turns it into the Kafka headers `x-request-id` and `traceparent`, and the notifications consumer continues the same trace (new span) and passes the headers on to the dead-letter topic. Grepping one request id in the logs of all services therefore follows a purchase from the gateway to the notification.
- The payment row stores the trace of the request that created it (`payments.trace`, migration `002_trace.sql`); `transition()` copies it into every outbox payload. A saga answered 202 and finished later by the sweeper therefore keeps the original request id and trace id in its Kafka headers. Covered by `services/payments/src/trace.test.ts`, which fails if the column is not written.

Logs are one JSON object per line on stdout: `time`, `level`, `service`, `msg`, fields. Errors are serialised with `type`, `message`, `stack`, `code`, `cause`. `LOG_LEVEL` (trace, debug, info, warn, error, fatal, silent) defaults to `info`, and to `silent` under tests. Requests log at `error` for 5xx and at `debug` otherwise: a line per request is itself a cost at flash-sale rates.

## SLIs and SLOs for the flash-sale journey

The journey is: join the queue, wait, get admitted, hold seats, pay, get the confirmation. These are **proposed targets**, not measured results; the lab has no production traffic to calibrate them against.

| Journey step | SLI | Target (30 days) | Measured by | Alerting |
|---|---|---|---|---|
| Any step at the edge | share of gateway requests that are not 5xx (429 is deliberate shedding and counts as good; 503 and 504 count as bad) | 99.5 % | `http_requests_total{service="gateway"}` | burn rate (below) |
| Hold seats | share of `POST /events/:eventId/holds` answered within 500 ms at inventory (any status) | 99 % | `http_request_duration_seconds` bucket `le="0.5"` | burn rate (below) |
| Get admitted | people are admitted whenever the queue is not empty | no ratio SLO; a stall is binary | `waitingroom_queue_length`, `waitingroom_admitted_total`, `waitingroom_admission_errors_total` | threshold |
| Pay | share of payment requests answered with a final result instead of 202 | 95 % (proposal) | `payments_in_progress_total`, `payments_final_total` | threshold, no burn rate |
| Confirmation | events reach the broker promptly (oldest unpublished outbox row under 60 s) and the consumer keeps up | proposal | `payments_outbox_oldest_unpublished_age_seconds`, `notifications_consumer_lag_messages` | threshold |

What is not measured: the true end-to-end time from "payment confirmed" to "notification delivered". That needs the event timestamp carried to the consumer and a histogram there; the outbox age plus consumer lag are the two halves of a proxy. The consumer lag gauge is only updated when a batch is processed.

### Burn-rate alerts: why these windows

An SLO of 99.5 % over 30 days is an error budget of 0.5 % of requests. Burn rate is how fast that budget is spent relative to "exactly on budget" (burn rate 1 spends it in exactly 30 days). Alerting on a single window is either slow (long window) or noisy (short window), so each alert requires a long and a short window to be over the threshold at the same time: the long one says the burn is significant, the short one says it is still happening.

| Tier | Burn rate | Long / short window | Budget consumed if it continues for the long window | Routing |
|---|---|---|---|---|
| fast burn | 14.4 | 1 h / 5 m | 14.4 x 1 h / 720 h = 2 % | page |
| slow burn | 6 | 6 h / 30 m | 6 x 6 h / 720 h = 5 % | page |
| ticket | 1 | 3 d / 6 h | 1 x 72 h / 720 h = 10 % | ticket |

The short window is one twelfth of the long one in each tier. The error-ratio thresholds follow from the budget: for the availability SLO 14.4 x 0.5 % = 7.2 %, 6 x 0.5 % = 3 % and 1 x 0.5 % = 0.5 %; for the hold latency SLO (budget 1 %) 14.4 %, 6 % and 1 %. The rules, including the recording rules for each window, are in [`ops/alerts.yml`](../ops/alerts.yml). The 14.4 / 6 / 1 factors and the 2 % / 5 % / 10 % budget shares are the widely used multiwindow, multi-burn-rate scheme from the Google SRE workbook; the burn-rate maths is the reason they are not arbitrary, but the SLO targets they are applied to are this lab's proposals.

Cause-based alerts (limiter fail-closed, outbox lag, stuck sagas, DLQ, pool saturation, event-loop lag) are thresholds. Where a threshold is a guess it is labelled "starting value" in the alert summary: calibrate from a load run before trusting it.

Run it:

```
docker compose --profile observability up -d prometheus grafana   # Prometheus on 127.0.0.1:59090, Grafana on 127.0.0.1:53000
```

The services run on the host (`pnpm start`), so `ops/prometheus.yml` scrapes `host.docker.internal`. The profile does not start with `docker compose up`, and the default services are unchanged. Validate the rules syntax with `docker run --rm --entrypoint promtool -v "$PWD/ops":/ops prom/prometheus:v2.55.1 check rules /ops/alerts.yml`.

## Metric catalogue

Every series also carries a `service` label (set once per process). Labels are bounded by construction: `route` is the registered route pattern (`/events/:eventId/holds`), never the raw path; no metric is labelled by user id, seat id, event id or request id; `pool`, `strategy`, `channel`, `upstream`, `state` and `result` take a fixed small set of values. Default Node metrics (`nodejs_*`, `process_*`) are also exported by every process. The notifications consumer has no HTTP server, so it has no `http_*` metrics.

<!-- metrics:start (generated by `node ops/check.mjs --write`) -->
| Metric | Type | Labels | Services | Meaning |
|---|---|---|---|---|
| `catalog_cache_requests_total` | counter | `result` | catalog | Cache lookups by result. |
| `catalog_db_query_duration_seconds` | histogram | `op` | catalog | Postgres query time for catalog reads. |
| `gateway_admission_rejected_total` | counter | - | gateway | Hold/confirm requests refused for a missing or invalid admission token. |
| `gateway_limiter_decisions_total` | counter | `limiter`, `decision` | gateway | Rate limiter outcomes by limiter and decision (fail_open/fail_closed = limiter store unreachable). |
| `gateway_upstream_duration_seconds` | histogram | `upstream` | gateway | Time spent waiting for the upstream service. |
| `gateway_upstream_errors_total` | counter | `upstream`, `reason` | gateway | Upstream calls that ended in a 504 (timeout or unreachable). |
| `http_request_duration_seconds` | histogram | `method`, `route` | gateway, inventory, waiting-room, payments, catalog | HTTP request duration in seconds, from first byte to response close. |
| `http_requests_in_flight` | gauge | - | gateway, inventory, waiting-room, payments, catalog | HTTP requests currently being served. |
| `http_requests_total` | counter | `method`, `route`, `status_class` | gateway, inventory, waiting-room, payments, catalog | HTTP requests by route and status class. |
| `inventory_confirms_total` | counter | `result` | inventory | Seat confirm attempts by result. |
| `inventory_holds_total` | counter | `strategy`, `result` | inventory | Seat hold attempts by locking strategy and result. |
| `notifications_consumer_lag_messages` | gauge | `partition` | notifications | Consumer lag per partition as of the last processed batch. |
| `notifications_delivered_total` | counter | `channel` | notifications | Notifications delivered, by channel. |
| `notifications_dlq_total` | counter | - | notifications | Messages published to the dead-letter topic. |
| `notifications_duplicate_suppressed_total` | counter | `channel` | notifications | Duplicate deliveries suppressed by the per-channel dedup key. |
| `payments_final_total` | counter | `status` | payments | POST /payments answered with a final or terminal saga status. |
| `payments_in_progress_total` | counter | - | payments | POST /payments answered 202: the saga is not final yet and a retry with the same Idempotency-Key reads the result. |
| `payments_outbox_backlog` | gauge | - | payments | Outbox rows not yet published. |
| `payments_outbox_oldest_unpublished_age_seconds` | gauge | - | payments | Age of the oldest unpublished outbox row (0 when the outbox is empty). |
| `payments_outbox_published_total` | counter | - | payments | Outbox rows published to the broker. |
| `payments_outbox_relay_errors_total` | counter | - | payments | Relay iterations that failed (broker unreachable, DB error). |
| `payments_sagas` | gauge | `state` | payments | Payments by saga state (PENDING and CHARGED that stay non-zero are stuck sagas). |
| `payments_sweeper_resumed_total` | counter | - | payments | Sagas the sweeper resumed without error. |
| `payments_sweeper_runs_total` | counter | `result` | payments | Sweeper iterations (resume sagas stuck in PENDING/CHARGED). |
| `pg_pool_idle_connections` | gauge | `pool` | inventory, payments, catalog, notifications | Idle connections in the pool. |
| `pg_pool_total_connections` | gauge | `pool` | inventory, payments, catalog, notifications | Open connections in the pool (idle + in use). |
| `pg_pool_waiting_clients` | gauge | `pool` | inventory, payments, catalog, notifications | Requests waiting for a free connection (pool saturation). |
| `waitingroom_admission_errors_total` | counter | - | waiting-room | Admission ticks that failed (for example Redis unreachable). |
| `waitingroom_admitted_total` | counter | - | waiting-room | Users moved from the queue to admitted. |
| `waitingroom_joins_total` | counter | `result` | waiting-room | Queue join calls by result. |
| `waitingroom_queue_length` | gauge | - | waiting-room | Users waiting in the queue of the admitted event. |
<!-- metrics:end -->

Notes on specific series:

- `payments_outbox_backlog` and `payments_outbox_oldest_unpublished_age_seconds` are read from Postgres when scraped (cached 1 s, partial index on unpublished rows). If Postgres is unreachable the last value is kept and `/readyz` is the signal.
- `payments_sagas` is a `GROUP BY status` over `payments.payments` (no index on status, so a sequential scan), cached 10 s. Cheap in the lab; replace with counters or a partial index at scale. `PENDING`, `CHARGED` or `REFUNDING` staying above zero means stuck sagas.
- `waitingroom_queue_length` is the queue of event 1, the one event the admission tick serves.
- `http_request_duration_seconds` buckets: 5 ms to 10 s, dense around 100 ms, 250 ms, 500 ms, 1 s and 2.5 s, because "share under X" is only exact at a bucket boundary and these are the SLO thresholds.

## Runbooks

Each failure drill in [failure-drills.md](failure-drills.md) has a symptom you will see in production, the metric that shows it, and the first action. Thresholds in alert names refer to [`ops/alerts.yml`](../ops/alerts.yml).

### General

- First look: `/readyz` of the failing service (which dependency, with latency and error), then `pg_pool_waiting_clients` (pool saturation), `nodejs_eventloop_lag_p99_seconds` (CPU or a blocked loop), then the logs filtered by `requestId`.
- A pool with waiters and idle connections at zero: the pool or the database is the bottleneck, not the Node process. Do not scale the service out before checking Postgres `max_connections`.
- Do not restart a service because `/readyz` is 503: readiness only takes it out of rotation, the cause is the dependency.

### Gateway availability

Symptom: `GatewayAvailability*Burn`. Metrics: `http_requests_total{service="gateway",status_class="5xx"}` by `route`; `gateway_upstream_errors_total` by `upstream` and `reason` (504s); `gateway_limiter_decisions_total{decision="fail_closed"}` (503s). First action: split the 5xx by cause. 504 timeout: look at the upstream's latency and pool. 503 fail-closed: Redis, see drill 1. 5xx from the upstream itself: that service's own `ServerErrorRatioHigh` and logs by `requestId`.

### Hold latency

Symptom: `HoldLatency*Burn`. Metrics: `http_request_duration_seconds` for the holds route on inventory, `pg_pool_waiting_clients{service="inventory"}`, `inventory_holds_total` by `strategy` and `result`. First action: if the pool has waiters, the database is slower than the arrival rate (hot rows: compare the `for-update` and `atomic-update` series; the atomic strategy holds locks for one round trip). Check `nodejs_eventloop_lag_p99_seconds` to rule out the Node process itself.

### Drill 1: Redis down

- Symptom: gateway answers availability normally but holds and queue joins fail fast with 503; nobody is admitted; catalog is slower.
- Metrics: `gateway_limiter_decisions_total` `decision="fail_open"` (public reads served unlimited) and `"fail_closed"` (holds and queue refused); `waitingroom_admission_errors_total` rising; `catalog_cache_requests_total{result="error"}`; waiting-room `/readyz` 503 (Redis is critical there); gateway `/readyz` stays 200 and shows `redis` `ok:false`. Alerts: `GatewayLimiterFailClosed`, `GatewayLimiterFailOpen`, `WaitingRoomAdmissionErrors`, `CatalogCacheErrors`.
- First action: restore Redis. Do not restart the gateways: they reconnect on their own and fail fast meanwhile (that is the point of drill 1). While fail-open, the public read route has no rate limit, so watch inventory pool waiters. After Redis returns, check that the queue was not lost (`waitingroom_queue_length`): a Redis that restarted empty has lost the queue and admitted users, and that is a business decision, not an ops one.

### Drill 2: broker down

- Symptom: payments succeed, notifications stop arriving.
- Metrics: `payments_outbox_backlog` and `payments_outbox_oldest_unpublished_age_seconds` grow; `payments_outbox_relay_errors_total` rises; payments `/readyz` stays 200 with `kafka` `ok:false`. Alerts: `PaymentsOutboxLagHigh`, `PaymentsOutboxBacklogHigh`, `PaymentsRelayErrors`.
- First action: restore the broker. Do not stop or restart payments and do not purge the outbox: the rows are the only copy of the events. Verify recovery: backlog and oldest age fall to zero, then `notifications_consumer_lag_messages` spikes and drains. The relay is at-least-once, so expect duplicates downstream and `notifications_duplicate_suppressed_total` to count them.

### Drill 3: consumer killed

- Symptom: confirmations stop; lag grows.
- Metrics: `up{job="notifications"} == 0`, `notifications_delivered_total` rate zero, `notifications_consumer_lag_messages` above zero. Alerts: `InstanceDown`, `NotificationsNotDelivering`, `NotificationsConsumerLagHigh`.
- First action: restart the consumer. Expect the backlog to start draining only after the claim lease expires for the deliveries that were mid-send (30 s by default; measured 34.5 s in drill 3), so do not restart it again if the first minute looks idle. After a graceful stop (SIGTERM) the consumer finishes the current batch and leaves the group, so this wait does not apply.

### Drill 4: slow payment provider

- Symptom: payment requests answer 202 in-progress instead of a final result; users retry.
- Metrics: `payments_in_progress_total` rate up, `payments_sagas{state="PENDING"}` or `"CHARGED"` above zero, `http_request_duration_seconds` for `POST /payments` near the step timeout (2 s), `payments_sweeper_resumed_total` after recovery. Alerts: `PaymentsInProgressRatioHigh`, `PaymentsSagasStuck`, `PaymentsSweeperFailing`.
- First action: check the provider's own status and latency. Do not raise `PSP_TIMEOUT_MS` or the confirm timeout to make 202s go away: a timeout is an unknown outcome, and the step timeout must sit above the provider's healthy p99 only. Once the provider recovers the sweeper finishes the sagas by itself (3.1 s in the drill); `payments_sagas` for `PENDING`/`CHARGED` should return to zero. If they do not, look at the sweeper counters and the logs for the payment id.

### Drill 5: channel down, DLQ

- Symptom: some notification channel (for example email) fails; messages pile up in `<topic>.dlq`.
- Metrics: `notifications_dlq_total` increasing, `notifications_delivered_total` for the other channel still increasing. Alert: `NotificationsDeadLettered`.
- First action: fix the channel, then replay: `node -e "require('./services/notifications/dist/replay-dlq').replayDlq('localhost:59092','payments').then(console.log)"` (a library function, the same one `drills/dlq-replay.mjs` uses). The replay is safe to run twice because delivery is deduplicated per event and channel, so the channel that already worked is not resent. The DLQ is a log and is not emptied; the `replayed` header tells replays apart.

## Configuration and boot

Each service validates its environment at start and exits with code 78 and one message listing every problem (a non-numeric `PORT`, a malformed URL, a value out of range), instead of failing on the first or later at runtime. All existing variable names and defaults are unchanged. With `NODE_ENV=production`, `ADMISSION_SECRET` must be set and must not be the development default `dev-secret`; gateway and waiting-room refuse to start otherwise.

New variables: `OPS_PORT` (notifications, 3105), `SHUTDOWN_DEADLINE_MS` (10000), `SHUTDOWN_DRAIN_DELAY_MS` (0), `LOG_LEVEL` (info).

Database pools come from one helper (`createPool` in `@boxoffice/platform`): 20 connections, 5 s statement timeout, 2 s wait for a connection, `application_name` per service (so `pg_stat_activity` shows who holds what), and an `error` handler (an idle client that loses its connection no longer crashes the process). Migrations and seeding run with the statement timeout off in every service, including payments and notifications, which used to run them under the 5 s limit.

## Graceful shutdown

On SIGTERM or SIGINT every service: goes not-ready, optionally waits `SHUTDOWN_DRAIN_DELAY_MS` so a load balancer notices, stops accepting connections and drains in-flight requests (idle keep-alive connections are closed so they cannot hold the shutdown), stops its background workers (payments sweeper and outbox relay, waiting-room admission tick, notifications consumer: each finishes its current iteration), then closes pools and clients, and exits 0. All steps share `SHUTDOWN_DEADLINE_MS`; a step that fails or exceeds it makes the exit code 1 and the remaining steps still run. A second signal exits immediately with 1. The sequence is logged step by step.

## Overhead

Measured with `node ops/overhead.mjs` (Node 26 on a darwin/arm64 laptop, 50 keep-alive connections over loopback, 5 s per run, 3 alternating rounds; client and server share the machine, so the absolute numbers are not capacity numbers and run-to-run noise is large). One trivial JSON route:

| Variant | requests/s over the 3 rounds |
|---|---|
| bare Fastify | 30 224 / 30 722 / 35 065 |
| with the platform instrumentation (RED metrics, request context, `x-request-id`) | 24 890 / 22 373 / 27 981 |
| the same plus `LOG_LEVEL=debug` (one JSON line per request to `/dev/null`) | 21 505 / 24 915 / 24 101 |

On a route that does no work this is roughly 15 to 25 % of throughput, which is about 7 to 10 microseconds of CPU per request; on a route that waits for Postgres for milliseconds it is a rounding error, but it has not been measured there, and no service-level load run (k6) was repeated with the instrumentation. Treat the table as an upper bound for the instrumentation cost, not a statement about the services' benchmark results in each README, which were taken before this existed.

## Known gaps

- No distributed tracing backend: ids are propagated and logged, spans are not exported.
- No end-to-end "confirmed to delivered" latency histogram (see the SLI table).
- `payments_sagas` scans the payments table; no `status` index exists.
- The alert thresholds marked "starting value" are not calibrated.
