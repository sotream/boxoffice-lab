# waiting-room: capacity

*The measured figures quoted here come from the RESULTS.md of this service, taken before the metrics/logging of `@boxoffice/platform` existed and (where Postgres is involved) on PostgreSQL 17; they have not been re-measured. See the measurement status at the top of [RESULTS.md](RESULTS.md).*

## The key formula: admission rate
admit/s = protected capacity x headroom / attempts per admitted user
- `inventory` measured 2 654 hold RPS per instance (planning figure 2 600, rounded down). One instance, headroom 0.6 -> 1 560 holds/s (2 654 x 0.6 = 1 592 unrounded).
- An admitted user makes ~3 hold attempts (seat taken, try another) -> 1 560 / 3 = **~520 users/s** (2 654 x 0.6 / 3 = ~531 unrounded). The configured `ADMIT_PER_SECOND` stays at 500, deliberately a little below the derived value.
- Drain time for the flash sale: 50 000 / 500 = **100 s** worst wait. That is the number to give the product owner.

## Traffic to the waiting room itself
- 50 000 users, each polls status every 5 s while waiting 100 s -> 20 polls -> 1M polls + 50k joins in the first minutes.
- Peak ~ 50 000 / 5 s = 10 000 status RPS at the start, falling as the queue drains.
- Measured: 10 134 RPS per instance on a laptop (RESULTS.md), planned as 10 100 -> instances = ceil(10 000 / (10 100 x 0.6)) = **2**. Stateless, so it scales horizontally; Redis is the shared state.
- Cheaper options if polling dominates: poll interval with jitter, long-poll or SSE, a CDN-cached static "queue is open" page.

## Redis memory
- 100 to 150 B per queued user (sorted set entry + user id; RESULTS.md bounds it at 140 B) -> 1M users in queue = **100 to 150 MB**. One small Redis node, no cluster needed.
- Redis single-thread ceiling is ~100k simple ops/s, 10x above the peak here.
