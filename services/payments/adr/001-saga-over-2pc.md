# ADR 001: orchestrated saga with compensation, not two-phase commit

**Status:** accepted.

The charge happens in an external system (PSP) which cannot take part in a distributed transaction, and inventory is another service with its own database. 2PC needs a coordinator, holds locks across network calls, and blocks if the coordinator dies. Rejected.

**Saga:** each step is a local transaction, failures run a compensation. Chosen order: **charge first, then confirm seats, refund if confirm fails.** The reverse (confirm first, charge later) would sell seats for money we may never collect. The cost of our order is a refund when the 10-minute hold expired mid-payment; the refund path is tested.

**Orchestration vs choreography:** orchestration (this service owns the state machine) is easier to reason about, to test (crash at each step) and to explain. Choreography would spread the flow across event handlers, which is attractive only with many more participants.

# ADR 002: transactional outbox, not "write DB then publish"

Dual write (UPDATE then `producer.send`) loses events if the process dies in between, and publishing inside the transaction makes commit and publish disagree if either fails. The outbox row commits atomically with the state change; the relay publishes afterwards. Cost: at-least-once delivery (duplicates on relay crash) and a polling delay (~50 ms). Rejected alternatives: CDC/Debezium (correct, more infrastructure; the production upgrade), 2PC between DB and Kafka (unsupported).

# ADR 003: idempotency key is a unique column

`INSERT ... ON CONFLICT DO NOTHING` on `idempotency_key` makes the database the arbiter: of 50 concurrent identical requests exactly one inserts and runs the saga, the others read the stored state (`inProgress: true` while running). The PSP is also called with the same key, so a retry after a crash cannot charge twice. Redis `SETNX` as a lock was rejected: it adds a second system whose failure semantics must match the database's.
