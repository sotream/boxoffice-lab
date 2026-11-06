# ADR 001: token bucket in Redis for rate limiting

**Status:** accepted.

| Algorithm | Verdict |
|---|---|
| Fixed window counter | Cheapest, but allows 2x the limit at window edges. Rejected. |
| Sliding window log | Exact, but O(requests) memory per key. Rejected. |
| Sliding window counter | Good approximation; slightly harder to explain. Runner-up. |
| **Token bucket** | Chosen: allows controlled bursts (a human double-click), O(1) state, two numbers per key. |
| Leaky bucket (as a queue) | Smooths output by delaying requests; we want to reject, not delay. Rejected. |

## Where the state lives
- In-process counters: wrong with N instances (each allows the full limit). Rejected.
- **Redis + Lua**: one atomic round trip, shared clock via `TIME`. A `GET`-then-`SET` from the app would race (tested: 300 concurrent takes on a bucket of 100 allow exactly 100).
- Sticky routing + local buckets: fast but uneven and breaks on rebalancing. Rejected.

## Failure mode (decided by a failure drill, see docs/failure-drills.md)
First version: Redis down meant every request hung until the client timeout (ioredis queues commands while offline) and 100% failed. Now the Redis client fails fast (no offline queue, 200 ms command timeout) and the policy is per route:
- **public reads (availability): fail open.** Serve without the limiter; a read is cheap and the DB is protected by its own pool.
- **holds and queue calls: fail closed with an immediate 503 + `Retry-After`.** Holds spend scarce inventory, and the queue itself needs Redis.
Measured: availability stayed at 0 errors through a 10 s Redis outage; recovery after Redis came back needed no restart.

# ADR 002: signed admission token instead of a Redis lookup

Checking `admitted:{user}` in Redis on every hold costs a round trip on the hottest path and couples the gateway to the queue's storage. An HMAC token is verified in microseconds, carries its own expiry, and binds user and event. Trade-off: revocation is impossible before expiry (5 min). Acceptable; a revoked user can still only hold seats at the per-user rate limit. The secret must be rotated with an overlap window (accept two keys).
