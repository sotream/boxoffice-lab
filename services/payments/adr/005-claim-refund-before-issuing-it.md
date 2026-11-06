# ADR 005: claim the refund (REFUNDING) before issuing it

**Status:** accepted. Supersedes the compensation step order described in ADR 001/004 (CHARGED -> REFUNDED in one step).

## Problem
`run()` called `psp.refund` first and recorded `CHARGED -> REFUNDED` afterwards. Two runners (request path and sweeper) can both read `CHARGED`. If one confirms the seats and stores `CONFIRMED` while the other gets a "no" from inventory, the second one refunded money for a payment that is stored as `CONFIRMED`: the customer holds seats and the money, and the ledger says the money was kept. The compare-and-set protected the row but came too late to protect the irreversible external call.

## Decision
Claim before the irreversible call. New state `REFUNDING`:

`CHARGED --(confirm said no)--> REFUNDING --(keyed psp.refund)--> REFUNDED + outbox event`

- `CHARGED -> REFUNDING` is a compare-and-set without an event. Only the winner calls the refund; a loser returns the stored state (`CONFIRMED` or `REFUNDING`) and touches no money.
- `REFUNDING -> REFUNDED` carries the `payment.refunded` outbox event in the same transaction, as before.
- `REFUNDING` is in progress, never final: `pay()` with the same key answers 202, and the sweeper selects `PENDING`, `CHARGED` and `REFUNDING`.
- A crash anywhere after the claim leaves `REFUNDING`; the sweeper re-issues the refund with the same key (`refund:<idempotencyKey>`), so a repeat is a no-op at the provider.
- The charge id is looked up through the idempotent charge call. If the provider cannot return it, the runner throws and the row stays `REFUNDING`; it is never marked `REFUNDED` without a refund (the old code skipped the refund silently in that case).
- The refund call is now bounded by the step timeout as well. A timeout is an unknown outcome and leaves `REFUNDING`.
- Migration: status is plain text, so no DDL is needed; `001_init.sql` only documents the state and stays idempotent.

## Why confirm needs no such claim
`confirmSeats` is idempotent in inventory: seats already sold to this user count as success (ADR 004). Two runners that both confirm leave the seats sold once, and the compare-and-set to `CONFIRMED` lets one write the event. A lost CAS after a confirm contradicts nothing. Refund is different because it is irreversible and contradicts `CONFIRMED`. Verified by a test with three concurrent runners against a stateful inventory model.

## Rejected alternatives
- **Refund, then CAS (the old order).** The window between the two is exactly the bug; shrinking it does not remove it.
- **Two-phase commit with the PSP.** The PSP offers no prepare/commit, and 2PC blocks on a dead coordinator (ADR 001).
- **A row lock held across the PSP call** (`SELECT ... FOR UPDATE`). Holds a database connection during a network call, which the capacity model forbids, and a crashed holder only releases through connection timeout.

## Residual risk
- The claim narrows the window to zero for the money, not for the seats: if inventory contradicted itself (a "no" after an earlier "yes" for the same user), the loser of the race can leave a `REFUNDED` payment whose seats were sold. Inventory's idempotent confirm rules this out; the property test lets the confirm answer vary per call and only asserts money conservation.
- Correctness relies on the PSP deduplicating refunds by key. Adapters must pass `pspContract` (`src/psp.contract.ts`); one that cannot dedupe must keep its own key table.
- A row stuck in `REFUNDING` because the provider keeps failing is retried forever by the sweeper; there is no alert or retry cap yet.
- A provider permanently slower than the step timeout never completes a saga (ADR 004); the property test excludes it from the model.
- Performance: the compensation path now costs 4 commits instead of 3. The earlier 561/s and 904/s figures were measured on that path and are **to be re-measured**; no new figure is claimed here.
