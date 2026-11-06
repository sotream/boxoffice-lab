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

See [CAPACITY.md](CAPACITY.md), [adr/](adr/), [RESULTS.md](RESULTS.md).
