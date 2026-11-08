# notifications

Interview question: **"Design a notification system"** (at-least-once delivery, retries, dedup, DLQ, fan-out).

## Requirements
- FR: consume `payments` events; send email and/or push depending on the event type (fan-out).
- FR: retry transient provider errors; park permanently failing messages in a dead-letter topic.
- NFR: no lost notifications (at-least-once), no duplicate sends in normal operation, one slow channel must not block or re-send another.
- NFR: a poison message (invalid JSON) never blocks a partition.

## Design
- Kafka consumer group on `payments` (3 partitions), batch handling with bounded concurrency, offsets committed after the batch.
- Per `(outboxId, channel)` row in `notifications.deliveries`: **dedup key and state machine** (`SENDING` lease -> `SENT` | `FAILED`).
- Retry with exponential backoff and full jitter, 4 attempts; then the message goes to `payments.dlq` and counts as handled.
- Duplicate sitting next to its original in the same batch is "in flight": retried locally for up to ~2 s, then the batch is redelivered.

Replay: `src/replay-dlq.ts` republishes `<topic>.dlq` after the cause is fixed; safe because delivery state is per channel (drill 5).

Poison messages (invalid JSON, or valid JSON that is not an event with an `outboxId`) go to the DLQ and the offset moves on.

See [CAPACITY.md](CAPACITY.md), [adr/](adr/), [RESULTS.md](RESULTS.md).

## Endpoints
No business API: the process is a Kafka consumer. A small server on `OPS_PORT` (default 3105) serves `GET /healthz`, `/readyz` and `/metrics`; if the port is taken the consumer keeps running and logs a warning.

## Environment
Read and validated at start (`src/main.ts`); bad values exit with code 78. Start with `pnpm --filter @boxoffice/notifications start` after `pnpm build`.

| Variable | Default | Meaning |
|---|---|---|
| `OPS_PORT` | 3105 | Port of the ops server |
| `DATABASE_URL` | `postgres://lab:lab@localhost:55432/lab` | Postgres |
| `PG_POOL` | 20 | Postgres pool size (minimum 1) |
| `KAFKA_BROKER` | `localhost:59092` | Broker `host:port` |
| `TOPIC` | `payments` | Topic to consume; the DLQ is `<TOPIC>.dlq` |
| `GROUP_ID` | `notifications` | Consumer group |
| `CONCURRENCY` | 25 | Parallel deliveries per partition batch |
| `SENDER_LATENCY_MS` | 20 | Fake provider latency |
| `SHUTDOWN_DEADLINE_MS` | 10000 | Total time for graceful shutdown, minimum 100 |
| `SHUTDOWN_DRAIN_DELAY_MS` | 0 | Wait after going not-ready, so a load balancer notices |
| `LOG_LEVEL` | `info` (`silent` under tests) | trace, debug, info, warn, error, fatal, silent |

## Operations
- Every process serves `GET /healthz` (liveness, never calls a dependency), `GET /readyz` (readiness) and `GET /metrics` (Prometheus) on `OPS_PORT`. Readiness: Postgres and Kafka are both critical.
- Metrics of this service: `notifications_delivered_total{channel}`, `notifications_duplicate_suppressed_total{channel}`, `notifications_dlq_total`, `notifications_consumer_lag_messages{partition}` (updated per processed batch), `pg_pool_*`; no `http_*`. Series definitions: the generated table in [operations.md](../../docs/operations.md#metric-catalogue).
- Logs are JSON lines on stdout with `requestId`, `traceId` and `spanId`; `x-request-id` and `traceparent` are accepted and propagated ([Correlation](../../docs/operations.md#correlation-one-id-per-purchase)).
- Shutdown (SIGTERM or SIGINT): goes not-ready, the consumer finishes its current batch and leaves the group, the pools and the ops server are closed (a SIGKILLed consumer instead waits out the 30 s claim lease, drill 3). All steps share `SHUTDOWN_DEADLINE_MS`; a second signal exits 1 at once ([Graceful shutdown](../../docs/operations.md#graceful-shutdown)).
- Invalid configuration exits with code 78 and one message listing every problem ([Configuration and boot](../../docs/operations.md#configuration-and-boot)).
- Runbooks for the drills that hit this service: [operations.md](../../docs/operations.md#runbooks).

## Load
`load/bench.js` (after `pnpm build`, needs Postgres and Redpanda) produces events to a fresh 3-partition topic and consumes them in-process; `PARTS=1` or `PARTS=3` sets how many partitions are consumed at once. `scripts/bench.sh notifications [runs]` runs both and prints time, deliveries/s and the integrity checks (sent vs expected, duplicate rows, dead letters, provider calls) ([benchmarks.md](../../docs/benchmarks.md#method)).

## Tests
`docker compose up -d postgres && pnpm --filter @boxoffice/notifications test` (unit and property tests use a fake `kafkajs`; only `src/ops.e2e.test.ts` needs Redpanda on :59092, so use `docker compose up -d` for the whole package).
- `src/handler.test.ts`: dedup, lease, retries, `InFlight`. `src/properties.test.ts`: random messages with duplicates and flaky providers (the set of successful sends equals the set of unique `outboxId:channel` keys), concurrent duplicates, and the real `consumer.ts` against a fake broker (DLQ routing, offsets always resolved). Replay with `FC_SEED=<seed>`.
- `src/ops.e2e.test.ts`: the built consumer as a child process.
- Coverage: `pnpm --filter @boxoffice/notifications exec vitest run --coverage`. Mutations: ids `not-*` ([testing](../../docs/testing.md)).
