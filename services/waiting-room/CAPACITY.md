# waiting-room: capacity

## The key formula: admission rate
admit/s = protected capacity x headroom / attempts per admitted user
- `inventory` measured ~2 300 hold RPS per instance. One instance, headroom 0.6 -> 1 380 holds/s.
- An admitted user makes ~3 hold attempts (seat taken, try another) -> 1 380 / 3 = **~460 users/s**, configured as 500.
- Drain time for the flash sale: 50 000 / 500 = **100 s** worst wait. That is the number to give the product owner.

## Traffic to the waiting room itself
- 50 000 users, each polls status every 5 s while waiting 100 s -> 20 polls -> 1M polls + 50k joins in the first minutes.
- Peak ~ 50 000 / 5 s = 10 000 status RPS at the start, falling as the queue drains.
- Measured: **~7 600 RPS per instance** on a laptop (RESULTS.md) -> instances = ceil(10 000 / (7 600 x 0.6)) = **3**. Stateless, so it scales horizontally; Redis is the shared state.
- Cheaper options if polling dominates: poll interval with jitter, long-poll or SSE, a CDN-cached static "queue is open" page.

## Redis memory
- ~100 B per queued user (sorted set entry + user id) -> 1M users in queue = **~100 MB**. One small Redis node, no cluster needed.
- Redis single-thread ceiling is ~100k simple ops/s, 10x above the peak here.
