# ADR 001: Kafka-compatible log (Redpanda) as the transport

**Status:** accepted.

| Option | Verdict |
|---|---|
| Direct HTTP call from payments | Rejected: payments' latency and availability would depend on the email provider; no replay. |
| SQS / RabbitMQ | Good fit for pure task queues (per-message ack, built-in DLQ and delay). Runner-up: simpler for this one consumer. |
| **Kafka / Redpanda** | Chosen: replay (re-send a day's notifications after a bug), multiple independent consumers later (analytics, fraud) on the same log, partition-ordered per payment. |

Cost: no per-message ack/delay, so retry, backoff and DLQ are application code here (the handler). That code is the point of the lab; with SQS it would be configuration.

# ADR 002: at-least-once with a database dedup key

**Status:** accepted.

Exactly-once delivery to an external provider does not exist: if the process dies after the provider accepted the email but before we record `SENT`, we cannot know. Options: **at-most-once** (record first, send after: may lose a notification), **at-least-once** (send, then record: may duplicate). A lost "your tickets are confirmed" email is worse than a rare duplicate, so at-least-once, plus:
- the `deliveries` PK `(outbox_id, channel)` stops duplicates caused by the pipeline itself (outbox relay resends, Kafka redelivery);
- the claim is a **lease**, so two workers cannot send the same notification at once and a crashed worker's claim expires;
- the provider gets `outboxId:channel` as its idempotency key where supported.

# ADR 003: DLQ as a topic, and per-channel state

**Status:** accepted.

A message that fails permanently is published to `payments.dlq` with the error in a header, then offsets move on, so one poison message cannot stall the partition. Operations replay the DLQ after a fix. Because state is per channel, replaying a message whose email failed never re-sends the push that already succeeded (tested).

# Bugs found by tests and the load run (kept as lessons)
1. A `FAILED` channel could never be retried (claim only matched `SENDING`).
2. Dedup by "row exists" was not exclusive: 20 concurrent duplicates sent several emails. Fixed with a lease and an `InFlight` signal.
3. `InFlight` thrown in a batch crashed the consumer, which then restarted with a ~10 s backoff and stalled processing (15k of 38k delivered after 5 min). Fixed with a short local retry.
