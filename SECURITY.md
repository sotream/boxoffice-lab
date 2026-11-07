# Security

This is a learning and design lab, not a production system. Do not deploy it as is.

Known gaps that are deliberate and documented (see "Limits of this lab" in the README and `docs/e2e.md`):

- Payments authenticates its caller with a shared secret (`x-internal-token`, env `PAYMENTS_INTERNAL_TOKEN`), not with mutual TLS: anybody who holds the token can call payments as the gateway, with any user and seats. There is one secret for all callers and no rotation mechanism.
- Seat-hold ownership is verified only at confirm, not before the charge: an authenticated user can pay for seats another user holds; the card is charged, inventory refuses the confirm and the saga refunds (payments ADR 005). The end-to-end suite keeps this scenario.
- The payment provider is an in-process fake.
- Default secrets (`ADMISSION_SECRET=dev-secret`, `PAYMENTS_INTERNAL_TOKEN=dev-internal-token`, database `lab:lab`) are for local use only. In `NODE_ENV=production` the services refuse the default admission secret and the default internal token.
- The ops endpoints (`/metrics`, `/readyz`) expose internal counters and dependency errors and must stay off public networks.

Closed (see [payments ADR 006](services/payments/adr/006-internal-authentication-and-server-side-price.md)): payments used to accept any caller and to take user, seats and price from the request body. Now the only client is the gateway route `POST /events/:id/pay` (admission token, per-user limiter, body user must be the token's user); payments requires `x-internal-token` before it reads the body, computes the amount itself (`seats x SEAT_PRICE_CENTS`) and answers 409 when an idempotency key is replayed with another user, event or seats. The ports are still open on the host in this lab: the token, not the network, is the control.

There are no real credentials in this repository or in its history. To report a problem, open an issue on GitHub.
