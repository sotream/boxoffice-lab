# Failure drills

Each drill breaks one dependency while the system is under traffic and records what happens. Scripts are in `drills/`. Setup: all services, Postgres, Redis and Redpanda on one laptop (see RESULTS.md files for the usual caveat).

| # | Drill | Expected | Observed | What changed in the code |
|---|---|---|---|---|
| 1 | Redis stopped for 10 s under traffic on the gateway | degraded service | v1: **100% errors** for the whole outage, each request hung until the drill script's own 2 s abort (the service itself had no timeout, which was the problem); v2: **0 errors** on availability, holds/queue return a fast 503 | fail-fast Redis client (no offline queue, 200 ms timeout), per-route fail-open/closed policy |
| 2 | Redpanda (Kafka) stopped while 300 payments are made | payments keep working, events not lost | 300/300 payments OK in 0.7 s; 300 events buffered in the outbox; **caught up 1.2 s** after the broker returned; topic grew by exactly 300 | none needed: this is what the outbox is for |
| 3 | Notifications consumer SIGKILLed at 6 492 / 12 000 deliveries | no loss, no duplicates | restarted consumer finished all **12 000 / 12 000**, 0 duplicate rows, 0 rows stuck; took 33.6 s because 25 claims were mid-send and wait out the 30 s lease | none: lease expiry is the designed recovery path |
| 4 | Payment provider slow (20 s) while 300 payments run | degraded, bounded | before: **300 of 300 clients timed out at 15 s with no answer** while the service finished the work silently; after: **300 x 202 in-progress at p50 2.09 s**, all final **3.2 s** after recovery, 0 duplicate charges, 0-1 DB connections throughout | step timeouts (PSP, inventory confirm), 202 + sweeper, idempotent confirm, relay on its own pool, pool/statement/upstream timeouts |
| 5 | Email channel down, 200 messages dead-lettered, then fixed and the DLQ replayed | no loss, no resend | all **400 of 400** deliveries completed, push (already sent) **not resent**, 0 duplicate rows | `replay-dlq.ts`: republish the DLQ, rely on per-channel dedup |

## Sentences these give you
1. "I tested the failure path: with Redis down my first gateway returned 100% errors because the client queued commands and every call hung. I made the client fail fast and chose fail-open for public reads and fail-closed for anything that spends inventory."
2. "Payments do not depend on the broker being up. The outbox row commits with the state change; the relay catches up. When I stopped the broker, 300 payments succeeded and all 300 events arrived 1.2 s after it returned."
3. "A killed consumer neither lost nor duplicated deliveries. Recovery time equals the lease length (30 s), which is the explicit trade-off between fast takeover and double sends."

4. "When the payment provider got slow, clients used to hang until their own timeout with no answer while the server finished the work silently. I bounded each step at 2 s and answer 202 in-progress; a sweeper completes the saga. The catch I measured: a timeout is an unknown outcome, not a failure. If it were treated as failure, a timed-out inventory confirm would refund a sold seat. And the timeout must sit above the provider's p99, or healthy-but-slow calls get turned into async ones."
5. "Dead-lettered messages are replayable because delivery state is per channel: after fixing email I replayed 200 messages and only the email channel was sent."

## Not drilled (stated honestly)
Postgres failover, network partitions between services, clock skew, disk full, slow Postgres, slow Redis and a slow broker (proposed with derived expectations in [reliability-patterns](playbook/reliability-patterns.md), none run). Slow PSP is drill 4.

## Run
```
docker compose up -d
pnpm -r build
node drills/redis-down.mjs      # needs inventory 3101, waiting-room 3102, gateway 3100 running
node drills/kafka-down.mjs      # needs inventory 3101, payments 3103 running
node drills/consumer-kill.mjs   # starts and kills its own consumers
node drills/slow-psp.mjs 20000  # needs inventory 3101 and payments 3103 started with PSP_ADMIN=1
node drills/dlq-replay.mjs      # needs the notifications package built; runs its own consumer
```
