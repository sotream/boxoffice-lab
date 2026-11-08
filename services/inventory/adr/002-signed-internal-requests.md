# ADR 002: inventory authenticates its callers with signed requests

**Status:** accepted. Applies the scheme of [payments ADR 006 (addendum)](../../payments/adr/006-internal-authentication-and-server-side-price.md) to inventory, with a key of its own.

## Problem
Inventory had no authentication. Anybody who could reach its port could call `POST /events/:id/confirm` (sell seats to any user without a payment), `POST /events/:id/holds` (hold seats for any user, bypassing the admission token and the per-user limiter of the gateway), `POST /events/:id/holds/verify` and read availability. The edge policy lives in the gateway (admission token, limiters, body user equals token user) and payments (price, ownership check): a caller that skips the gateway skips all of it. Payments had been closed the same way in ADR 006; inventory is the service that owns the seats, so it is the more valuable target. In the lab every service listens on the host, so "internal" is a convention, not a boundary.

## Decision
**Every inventory route except `/healthz`, `/readyz` and `/metrics` needs a signed request**, the same scheme as payments:
- Header `x-internal-auth: <ms>.<hex HMAC-SHA256>` over `timestamp, method, path without query, SHA-256 of the body`. The key is never sent; a captured header cannot be reused for another path, method or body, and stops working after 30 s of clock skew.
- The hooks are shared (`installInternalAuth` in `packages/platform/src/internal-auth.ts`): `onRequest` rejects a missing, malformed or stale header before anything is read; `preParsing` reads the raw body (cap 64 KiB), verifies the signature over those bytes and hands the same bytes to the parser. An unauthenticated caller gets 401 even for a malformed body, and no controller, validation or database code runs. Default deny: a route added later is protected without anybody remembering to guard it. Each service's `src/internal-auth.ts` states what it accepts (its keys, the body cap).
- **A separate key for inventory:** `INVENTORY_INTERNAL_TOKEN` (development default `dev-inventory-internal-token`, refused with `NODE_ENV=production`, optional `INVENTORY_INTERNAL_TOKEN_PREVIOUS` accepted while a rotation is in progress). It is not `PAYMENTS_INTERNAL_TOKEN`. A key that leaks from the gateway, which holds both, allows both; a key that leaks from payments allows only what inventory trusts payments with, not calling payments' own API; and the services can be rotated independently.
- **Callers sign:**
  - the gateway signs everything it forwards to inventory (holds, confirm, availability) in `forward()`: method, path without query, and the exact body string it sends. It still forwards only what it forwarded before (the exact route whitelist, POST-only for holds and confirm); a client-supplied `x-internal-auth` is never forwarded;
  - payments signs `confirm` and `holds/verify` (`confirm-seats.ts`) with the same variable name, `INVENTORY_INTERNAL_TOKEN`, so deployment is symmetrical: the key goes to inventory (to verify) and to its two callers (to sign);
  - the load scripts (`services/inventory/load/hold.js`, signed with `k6/crypto`), the drills and `scripts/bench.sh` that talk to inventory directly sign with the same key.

## What it fixes
- No unauthenticated call sells, holds or reads seats, whatever the body is. The end-to-end suite asserts that a direct unsigned confirm, hold, verify and availability read get 401 and that no seat row changes.
- The key is not on the wire, so it does not show up in a proxy log, and a captured request cannot be replayed with another body, path or method.
- Compromise of one callee's key is scoped to one callee.

## What it does NOT fix
- **Still one shared key per callee.** Inventory cannot tell the gateway from payments: both sign with the same key, and anybody who holds it can confirm seats for any user. The upgrade is a key per caller (or mutual TLS), which would also let inventory restrict `confirm` and `holds/verify` to payments and `holds` to the gateway.
- **Replay inside the 30 s window.** An identical request (same method, path and body) captured on the network can be sent again until the header is 30 s old. `confirm` is idempotent by design (a retry after a lost response must succeed), so a replayed confirm changes nothing; `holds/verify` is a read; a replayed `holds` is refused with 409 while the hold is live, but can take the seats again once the hold has expired. There is no nonce store.
- **Clock skew:** a skew above 30 s between a caller and inventory turns every request into a 401.
- **The ports are still open on the host** in this lab: the key, not the network, is the control. The ops endpoints stay unauthenticated and must stay off public networks.
- **Cost on the hot path: small but measurable.** Every request costs one SHA-256 over the body and one HMAC at the caller, and the same plus a constant-time compare (two when a previous key is configured) at inventory, and the verifying hook reads the body into memory before parsing. Measured on an M1 Air (2026-11-08): the HMAC itself is about 2.4 microseconds to sign and 3.2 to verify (about 2% of the CPU a request costs inventory); an A/B of the tree before and after this change (`scripts/bench.sh inventory 5`, unsigned, signed, unsigned again on a machine with load up to 5) gave 0.4% to 6.7% lower throughput for the signed tree, 3.6% on average over the four rows, and a p95 1 to 4 ms higher. See [benchmarks](../../../docs/benchmarks.md#request-signing-measured-as-an-ab-on-the-same-machine).

## Rejected
- **Reusing `PAYMENTS_INTERNAL_TOKEN`:** one key would open both services from either side; a leak from payments (the more exposed, money-moving service) would allow calling inventory directly.
- **Authenticating only `confirm` and `holds/verify`:** the two routes payments calls. The gateway-facing routes (`holds`, `availability`) would still be open, which bypasses the admission token and limiters; default deny is simpler and has no list to forget.
- **Mutual TLS or network policy:** the production answer (identity per workload), but it needs certificate issuance and a mesh the lab does not have; the shared hook has the same enforcement point and can be replaced without touching the controller.
- **Verifying in the controller or a Nest guard:** runs after the body is parsed and validated; the Fastify hooks reject first and keep the cap on what an unauthenticated caller can make the service buffer.
