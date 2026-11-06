# gateway: capacity

## Limits are derived, not guessed
- Per-user hold limit: a human clicks ~1/s; allow **5/s, burst 10** (a script doing 100/s is cut off at the edge).
- Per-IP limit: office NATs and mobile carriers share IPs, so it must be generous: **50/s, burst 100** per IP is a safety net against floods, not the fairness mechanism (the waiting room is).
- Token bucket memory: 2 fields per key; an estimate of 100 to 200 B per key including the key name, not measured here. 1M active keys = roughly 100 to 200 MB in Redis, and keys expire after `burst / rate + 1 s` of idleness.

## Throughput
- Measured gateway in front of inventory (availability endpoint): **2 001 RPS vs 2 485 direct**, so the hop costs ~19% throughput and ~4 ms p50 (Redis round trip for the limiter + proxy). See RESULTS.md.
- Instances = ceil(peak / (RPS x 0.6)). The gateway sees all traffic: 10 000 status polls/s + 2 500 holds/s = 12 500 RPS -> 12 500 / (2 001 x 0.6) = **11 instances at this laptop's speed**; on a dedicated 4-vCPU box it would be several times fewer. Always re-measure on target hardware.
- Redis limiter load: 1 Lua call per request = 12 500 ops/s, ~12% of a single Redis node (~100k ops/s).

## Connections (a lesson from the lab, and a correction)
- Dialling 2 000 new connections in the same millisecond failed some of them: k6 reported `dial: i/o timeout` for 96 of the 2 000 users in the saved instantaneous run, and for between 96 and 944 users across runs of that variant (RESULTS.md; only the 96 run is saved). Earlier unsaved runs showed the same symptom as connection resets.
- Cause, as far as the saved runs show: the OS accept queue. On macOS `kern.ipc.somaxconn` is 128 and caps the queue whatever the application asks for. The gateway sets `backlog: 4096`, but that setting alone did not fix the symptom on this machine; an earlier note here that it did was wrong. It is a load-generator and OS artefact of an unrealistic arrival pattern (2 000 users in one millisecond), not a measured gateway limit.
- What fixed the test: the scenario spreads arrivals over 3 s (`ARRIVAL_SPREAD_S`, default 3). Two such runs had 0 failed requests; the instantaneous variant is still reported next to them.
- Production lesson that stays: the OS `somaxconn` / accept queue is a real capacity limit, so raise it on the host together with the application backlog; also keep-alive and a load balancer in front.
