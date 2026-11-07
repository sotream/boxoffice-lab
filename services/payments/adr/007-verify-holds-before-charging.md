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
- A race remains if the check takes longer than the sweeper's threshold (3 s): the sweeper could charge a payment whose request path then fails it on "not held". The check is bounded by the 2 s step timeout, so the margin is 1 s; changing either number needs this rechecked.
- During an inventory outage the check is unknown for everybody, so payments go on unchecked and are decided by confirm, as before this ADR. The pre-check does not make payments depend on inventory being up.
- The benchmark `services/payments/load/pay.js` pays for seats nobody holds. With the check on, every request would be a cheap `FAILED` and the number would measure something else, so `scripts/bench.sh` runs payments with `VERIFY_HOLDS=0`, a switch that is refused when `NODE_ENV=production`.

## Rejected
- **Verify inside the gateway:** it does not know who holds what and should not; payments is the service that moves money and owns the decision.
- **Hold-reservation token issued by inventory and presented by the client:** stronger (no TOCTOU window for the check itself), but a new credential, new state and a new expiry to manage; the confirm step already gives the strong guarantee.
- **Verify on every `run()`:** fails charged sagas, see above.
