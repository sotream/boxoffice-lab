# gateway: capacity

## Limits are derived, not guessed
- Per-user hold limit: a human clicks ~1/s; allow **5/s, burst 10** (a script doing 100/s is cut off at the edge).
- Per-IP limit: office NATs and mobile carriers share IPs, so it must be generous: **50/s, burst 100** per IP is a safety net against floods, not the fairness mechanism (the waiting room is).
- Token bucket memory: 2 fields per key, ~100 B. 1M active keys = **~100 MB** in Redis, and keys expire after `burst / rate + 1 s` of idleness.

## Throughput
- Measured gateway in front of inventory (availability endpoint): **1 742 RPS vs 2 244 direct**, so the hop costs ~22% throughput and ~6 ms p50 (Redis round trip for the limiter + proxy). See RESULTS.md.
- Instances = ceil(peak / (RPS x 0.6)). The gateway sees all traffic: 10 000 status polls/s + 2 500 holds/s = 12 500 RPS -> 12 500 / (1 742 x 0.6) = **12 instances at this laptop's speed**; on a dedicated 4-vCPU box it would be several times fewer. Always re-measure on target hardware.
- Redis limiter load: 1 Lua call per request = 12 500 ops/s, ~12% of a single Redis node (~100k ops/s).

## Connections (a lesson from the lab)
- 2 000 simultaneous new connections made joins fail with connection reset on the default listen backlog: 72 of 2 000 (3.6%) in an isolated join burst, and 289 resets in the first full flash-sale run where polling added load (two separate runs, see RESULTS.md). Fix: `backlog: 4096` (the OS `somaxconn` / accept queue is a real capacity limit). Also in production: keep-alive, and a load balancer in front.
