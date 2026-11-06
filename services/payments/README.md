# payments

Interview questions: **"How do you make payments safe to retry?"**, **"Saga vs 2PC"**, **"How do you publish an event and update the DB atomically?"**

## Requirements
- FR: pay for held seats with an `Idempotency-Key`; on success confirm the seats in inventory.
- FR: if the hold expired by the time the money is taken, refund automatically (compensation).
- FR: emit `payment.confirmed|refunded|failed` events for notifications.
- NFR: never charge twice, never lose an event, survive a crash at any step.

## Saga (orchestrated by this service)
`PENDING --charge--> CHARGED --confirm seats--> CONFIRMED`
`CHARGED --seats lost--> REFUNDED` (compensation) and `PENDING --charge declined--> FAILED`.
Every transition is a compare-and-set `UPDATE ... WHERE status = <from>` plus an outbox row in the **same transaction**. `resume(id)` continues from the stored state after a crash.

## Outbox relay
A loop reads unpublished outbox rows (`FOR UPDATE SKIP LOCKED`), sends them to Kafka (Redpanda) with `acks=-1`, then marks them published. Delivery is **at-least-once**; consumers deduplicate by `outboxId`.

## Timeouts and the 202 answer
Each outside step (PSP, inventory confirm) is bounded at 2 s. On timeout the API answers **202** `{status, inProgress: true}`; repeat the call with the same `Idempotency-Key` to read the final state. A timeout is an unknown outcome, never a reason to refund; a sweeper resumes stuck sagas (ADR 004, drill 4). `POST /admin/psp` (only with `PSP_ADMIN=1`) changes the fake PSP latency for drills.

See [CAPACITY.md](CAPACITY.md), [adr/](adr/), [RESULTS.md](RESULTS.md).
