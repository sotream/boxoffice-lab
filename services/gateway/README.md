# gateway

Interview questions: **"Design a rate limiter"** and **"How does the edge enforce the waiting room?"**

## Requirements
- FR: single entry point; routes `queue/*` to waiting-room and `holds|confirm|availability` to inventory.
- FR: `holds` and `confirm` need a valid admission token; otherwise 403 without touching inventory.
- FR: per-IP limit on public endpoints, per-user limit on holds; 429 with `Retry-After`.
- NFR: limiter must be correct across many gateway instances and add < 10 ms.

## Design
- Rate limiter: **token bucket in Redis**, one Lua script (read, refill, take, write) = atomic, one round trip. Time comes from Redis `TIME`, so all instances share one clock. Idle keys expire.
- Admission token: `user.event.expiry.HMAC-SHA256`, issued by waiting-room, verified by the gateway **without any Redis call** (`packages/admission`).
- The gateway is plain Fastify, not a Nest app: it is the hot path and has no business logic. In production this role is Envoy/Kong/an API gateway; the lab keeps it in code so the policy is readable.

See [CAPACITY.md](CAPACITY.md), [adr/](adr/), [RESULTS.md](RESULTS.md).
