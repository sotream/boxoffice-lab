# Security

This is a learning and design lab, not a production system. Do not deploy it as is.

Known gaps that are deliberate and documented (see "Limits of this lab" in the README and `docs/e2e.md`):

- Payments authenticates its caller with a request signature (`x-internal-auth`: HMAC-SHA256 over timestamp, method, path and body, key `PAYMENTS_INTERNAL_TOKEN`, 30 s skew), not with mutual TLS. The key is never sent and a captured header cannot be reused for another request or after 30 s, but it is still one shared key: anybody who holds it can sign calls as the gateway, with any user and seats, and payments cannot tell its callers apart. A rotation is supported with `PAYMENTS_INTERNAL_TOKEN_PREVIOUS` (payments accepts both keys while the gateway is switched).
- Seat-hold ownership is verified only at confirm, not before the charge: an authenticated user can pay for seats another user holds; the card is charged, inventory refuses the confirm and the saga refunds (payments ADR 005). The end-to-end suite keeps this scenario.
- The payment provider is an in-process fake.
- Default secrets (`ADMISSION_SECRET=dev-secret`, `PAYMENTS_INTERNAL_TOKEN=dev-internal-token`, database `lab:lab`) are for local use only. In `NODE_ENV=production` the services refuse the default admission secret and the default internal token.
- The ops endpoints (`/metrics`, `/readyz`) expose internal counters and dependency errors and must stay off public networks.

Closed (see [payments ADR 006](services/payments/adr/006-internal-authentication-and-server-side-price.md)): payments used to accept any caller and to take user, seats and price from the request body. Now the only client is the gateway route `POST /events/:id/pay` (admission token, per-user limiter, body user must be the token's user); payments requires a signed request (`x-internal-auth`) before it parses the body, computes the amount itself (`seats x SEAT_PRICE_CENTS`) and scopes the idempotency key by user (another user's replay of a key is an independent payment, so nobody can squat a key) and answers 409 when the same user replays a key with another event or seats; duplicate seat ids are refused with 400. The ports are still open on the host in this lab: the token, not the network, is the control.

There are no real credentials in this repository or in its history. To report a problem, open an issue on GitHub.
