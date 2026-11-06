# Failure drills

Each drill breaks one dependency while the system is under traffic and records what happens. Scripts are in `drills/`. Setup: all services, Postgres, Redis and Redpanda on one laptop (see RESULTS.md files for the usual caveat).

| # | Drill | Expected | Observed | What changed in the code |
|---|---|---|---|---|
| 1 | Redis stopped for 10 s under traffic on the gateway | degraded service | v1: **100% errors** for the whole outage, each request hung until the drill script's own 2 s abort (the service itself had no timeout, which was the problem); v2: **0 errors** on availability, holds/queue return a fast 503 | fail-fast Redis client (no offline queue, 200 ms timeout), per-route fail-open/closed policy |
| 2 | Redpanda (Kafka) stopped while 300 payments are made | payments keep working, events not lost | 300/300 payments OK in 0.7 s; 300 events buffered in the outbox; **caught up 1.2 s** after the broker returned; topic grew by exactly 300 | none needed: this is what the outbox is for |
| 3 | Notifications consumer SIGKILLed at 6 492 / 12 000 deliveries | no loss, no duplicates | restarted consumer finished all **12 000 / 12 000**, 0 duplicate rows, 0 rows stuck; took 33.6 s because 25 claims were mid-send and wait out the 30 s lease | none: lease expiry is the designed recovery path |

## Interview sentences these give you
1. "I tested the failure path: with Redis down my first gateway returned 100% errors because the client queued commands and every call hung. I made the client fail fast and chose fail-open for public reads and fail-closed for anything that spends inventory."
2. "Payments do not depend on the broker being up. The outbox row commits with the state change; the relay catches up. When I stopped the broker, 300 payments succeeded and all 300 events arrived 1.2 s after it returned."
3. "A killed consumer neither lost nor duplicated deliveries. Recovery time equals the lease length (30 s), which is the explicit trade-off between fast takeover and double sends."

## Not drilled (stated honestly)
Postgres failover, network partitions between services, clock skew, disk full, and a slow (not dead) dependency. A slow dependency is the most common real failure and deserves a drill (add latency to the PSP or Redis, watch pool exhaustion and timeouts).

## Run
```
docker compose up -d
pnpm -r build
node drills/redis-down.mjs      # needs inventory 3101, waiting-room 3102, gateway 3100 running
node drills/kafka-down.mjs      # needs inventory 3101, payments 3103 running
node drills/consumer-kill.mjs   # starts and kills its own consumers
```
