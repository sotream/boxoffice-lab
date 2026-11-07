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
- `for-update` locks rows with an explicit `ORDER BY seat_id`, so two requests for `[4,5]` and `[5,4]` lock in the same order and cannot deadlock. `atomic-update` was first a bare `UPDATE ... WHERE seat_id = ANY(...)`, whose lock order follows the query plan; a hold and a confirm under different plans deadlocked (`40P01`, reproduced by `lockorder.test.ts`). **Update 2026-11-06:** hold and confirm now lock their rows first, in `seat_id` order, inside the same statement (`WITH locked AS MATERIALIZED (... ORDER BY seat_id FOR UPDATE) UPDATE ... FROM locked`). Still one statement and one round trip. Re-measured on 2026-11-07 (PostgreSQL 18, instrumented): 2 294 hold RPS at low contention against 2 654 before, so the ordered locking costs about 14%; `for-update` is unchanged (2 168 against 2 182). See RESULTS.md.
- Multi-seat holds are all-or-nothing: compare `rowCount` with the number requested, else rollback. `confirm` is too: it runs in a transaction and rolls back unless every requested seat matched (a property test found a version that sold the matching seats and still answered false; see [testing](../../../docs/testing.md#bugs-found-by-these-tests)).
- Expiry is lazy: an expired hold is treated as free inside the WHERE clause. No sweeper job to fail.

## Consequences
- Correctness is enforced by the database, so extra app instances are safe.
- Hot seats cause a stream of 409s, not timeouts; the client UX must handle "seat just taken".
