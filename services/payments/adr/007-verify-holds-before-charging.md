# ADR 007: ask inventory who holds the seats before charging

**Status:** accepted. Closes the "seat-hold ownership is verified only at confirm" gap listed in ADR 006; the compensation path of ADR 005 stays.

## Problem
Payments took `userId`, `seatIds` and the amount, charged the card, and only then asked inventory to confirm. Inventory's owner check (`held_by = user`) refuses a confirm for seats held by somebody else, the saga refunds (ADR 005), and nothing is lost, but an authenticated user could make the PSP charge and refund a card as often as they liked for seats they never held: PSP fees, a charge pending on the card statement for days, and load on the compensation path.

## Decision
Ask first, charge second. For a brand-new payment (the idempotency insert won), `pay()` calls inventory `POST /events/:id/holds/verify` (read only, no lock) before the PSP is touched:
- **200**: the payer holds every seat now (a live hold, or already sold to them). The saga goes on as before.
- **409**: not held (someone else's, free, expired, unknown). The payment goes `PENDING -> FAILED` by the usual compare-and-set with a `payment.failed` outbox event. The PSP is never called, so there is nothing to refund.
- **5xx, timeout, unreachable**: unknown. Not "not held" (ADR 004: unknown is not failed). The payment stays `PENDING`, the caller gets 202 in progress, and the sweeper continues it **without** asking again; confirm remains the authority.
- **any other 4xx**: a contract bug; the call fails loudly and the payment stays `PENDING` uncharged.

`holds/verify` is an inventory route the gateway does not route (the gateway's path whitelist is exact), so clients cannot call it; inventory has no authentication of its own, as before.

## Why only on the first call
A `PENDING` saga that is resumed (crash after the charge, timeout) may already have been charged at the PSP. Failing it on a later "not held" would leave money taken and the saga `FAILED`. The check therefore runs only in the call that created the row, when no PSP call can have happened yet, and never in `run()`.

## Why confirm stays
The answer is a snapshot: the hold can expire, or be re-taken, between the check and the confirm. The compensation path (charge, confirm says no, refund) still exists for that window and for the unknown case above; the hold-expiry fault scenario exercises it. The check removes the cheap abuse and the waste, not the race.

## Consequences
- A cheater's payment ends `FAILED` instead of `REFUNDED`, and the card is not touched. Clients already treat `FAILED` as final.
- One more inventory round trip per payment (a primary-key range read). It adds latency before the PSP call and uses the same 2 s bound as confirm (`CONFIRM_TIMEOUT_MS`).
- A race remains if the check takes longer than the sweeper's age threshold: the sweeper could charge a payment whose request path then fails it on "not held". The margin is a checked invariant, not two unrelated numbers. The threshold is `SWEEP_MIN_AGE_MS` (default 3000, unchanged) and payments refuses to start (exit 78, listed with every other config problem) unless `SWEEP_MIN_AGE_MS >= min(CONFIRM_TIMEOUT_MS, PSP_TIMEOUT_MS) + 500` (`src/sweep-margin.ts`). With the defaults that is 3000 >= 2000 + 500.
  - Which steps count: only the check itself, because it is the only step after which the request path can *fail* the payment on an answer about ownership. It ends after at most the smaller of two bounds: the HTTP abort of `holds/verify` (`CONFIRM_TIMEOUT_MS`) and `within`, the service's single step timeout (`PSP_TIMEOUT_MS`). The PSP charge, the confirm and the PENDING to CHARGED transition after a positive answer are not part of this race: a sweeper running them concurrently with the request path is the normal two-runner case (idempotent PSP call, compare-and-set transitions, ADR 004 and 005). Using the minimum rather than the maximum avoids refusing valid configurations such as a long `PSP_TIMEOUT_MS` with the default confirm timeout.
  - What is enforced: the configured bounds against the configured threshold, at startup, only while `VERIFY_HOLDS` is on (with it off there is no check to race). The 500 ms margin covers the insert-to-check gap, scheduling and clock noise.
  - What is not enforced: the real duration of the check (the bounds are timeouts, not measurements; a stalled event loop or a slow database round trip around the check is outside them), clock skew (the age is computed by the database clock only, so skew between payments hosts does not matter, but `updated_at` and the sweeper query use the same clock), and instances started with different settings: each instance validates only itself, and the sweeper of an instance with a smaller threshold also resumes payments created by the others. Keep the three variables identical across instances.
- During an inventory outage the check is unknown for everybody, so payments go on unchecked and are decided by confirm, as before this ADR. The pre-check does not make payments depend on inventory being up.
- The benchmark `services/payments/load/pay.js` pays for seats nobody holds. With the check on, every request would be a cheap `FAILED` and the number would measure something else, so `scripts/bench.sh` runs payments with `VERIFY_HOLDS=0`, a switch that is refused when `NODE_ENV=production`.

## Rejected
- **Verify inside the gateway:** it does not know who holds what and should not; payments is the service that moves money and owns the decision.
- **Hold-reservation token issued by inventory and presented by the client:** stronger (no TOCTOU window for the check itself), but a new credential, new state and a new expiry to manage; the confirm step already gives the strong guarantee.
- **Verify on every `run()`:** fails charged sagas, see above.
