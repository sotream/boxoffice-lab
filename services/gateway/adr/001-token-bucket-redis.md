# ADR 001: token bucket in Redis for rate limiting

**Status:** accepted.

| Algorithm | Verdict |
|---|---|
| Fixed window counter | Cheapest, but allows 2x the limit at window edges. Rejected. |
| Sliding window log | Exact, but O(requests) memory per key. Rejected. |
| Sliding window counter | Good approximation; slightly harder to explain. Runner-up. |
| **Token bucket** | Chosen: allows controlled bursts (a human double-click), O(1) state, two numbers per key. |
| Leaky bucket | Smooths output; we want to reject, not queue. Rejected. |

## Where the state lives
- In-process counters: wrong with N instances (each allows the full limit). Rejected.
- **Redis + Lua**: one atomic round trip, shared clock via `TIME`. A `GET`-then-`SET` from the app would race (tested: 300 concurrent takes on a bucket of 100 allow ~100).
- Sticky routing + local buckets: fast but uneven and breaks on rebalancing. Rejected.

## Failure mode (fail open or closed?)
If Redis is down the limiter throws and requests fail (closed). For the sale that is the safe default: admission and the queue need Redis anyway. A public read-only API would fail open with a local fallback limit.

# ADR 002: signed admission token instead of a Redis lookup

Checking `admitted:{user}` in Redis on every hold costs a round trip on the hottest path and couples the gateway to the queue's storage. An HMAC token is verified in microseconds, carries its own expiry, and binds user and event. Trade-off: revocation is impossible before expiry (5 min). Acceptable; a revoked user can still only hold seats at the per-user rate limit. The secret must be rotated with an overlap window (accept two keys).
