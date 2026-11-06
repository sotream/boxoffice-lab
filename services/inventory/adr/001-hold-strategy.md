# ADR 001: how to hold a seat without double booking

**Status:** accepted. **Decision:** conditional `UPDATE ... WHERE free RETURNING` in one statement (`atomic-update`).

## Options considered
| Option | Result |
|---|---|
| Check then write in the app | Rejected: race between SELECT and UPDATE, the classic double booking bug. |
| `SELECT ... FOR UPDATE` then UPDATE | Correct. Two round trips and locks held across them. Measured ~18% lower throughput at low contention. |
| **Single conditional UPDATE** | Correct. One round trip, row locks held only for the short transaction around it. Chosen. |
| Redis `SET NX EX` as the hold | Fast, built-in TTL, but a second source of truth to reconcile with the sale in Postgres. Rejected for now; revisit if the DB becomes the bottleneck. |
| Serializable isolation | Correct but needs retry loops on serialization failures; heavier than needed for single-row predicates. |

## Details that matter
- `for-update` locks rows with an explicit `ORDER BY seat_id`, so two requests for `[4,5]` and `[5,4]` lock in the same order and cannot deadlock. `atomic-update` sorts ids in the application, but its single `UPDATE ... WHERE seat_id = ANY(...)` has no `ORDER BY`, so lock order follows the query plan; the concurrency test passes for the plan used, which is evidence, not a guarantee.
- Multi-seat holds are all-or-nothing: compare `rowCount` with the number requested, else rollback.
- Expiry is lazy: an expired hold is treated as free inside the WHERE clause. No sweeper job to fail.

## Consequences
- Correctness is enforced by the database, so extra app instances are safe.
- Hot seats cause a stream of 409s, not timeouts; the client UX must handle "seat just taken".
