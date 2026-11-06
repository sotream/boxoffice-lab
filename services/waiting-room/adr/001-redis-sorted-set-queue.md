# ADR 001: Redis sorted set for the queue, sequence as score

**Status:** accepted.

| Option | Verdict |
|---|---|
| Postgres table with `ORDER BY joined_at` | Rejected: queue writes would hit the same database we are protecting. |
| Kafka topic as queue | Rejected: no cheap "what is my position" lookup; offsets are per partition. |
| SQS / RabbitMQ | Rejected: queues give no random access to a user's position. |
| **Redis sorted set** | Chosen: `ZADD NX` (idempotent join), `ZRANK` (position in O(log n)), `ZPOPMIN` (admit N atomically). |

## Details
- Score is an `INCR` counter, not `Date.now()`: two joins in the same millisecond and clock skew between app nodes cannot reorder users.
- Admission is `ZPOPMIN` then keys with TTL: an admitted user who does not show up loses the slot automatically.
- Admission rate is a fixed budget, not adaptive. Adaptive (watch inventory p99) is better in production but harder to explain; noted as the next step.

## Consequences
- Redis is a single point of failure for the sale. Mitigation: replica + failover; worst case users re-join (idempotent), and order is lost, not money.
- The queue protects capacity only if `inventory` rejects requests without an admission. See the gateway stage.
