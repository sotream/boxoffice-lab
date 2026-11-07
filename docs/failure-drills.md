# Failure drills

Each drill breaks one dependency while the system is under traffic and records what happens. Scripts are in `drills/`. Setup: all services, Postgres, Redis and Redpanda on one laptop (see RESULTS.md files for the usual caveat). What to do in production for each failure (symptom, metric, first action) is in the runbook column, which links to [operations.md](operations.md). To run the drills yourself see [development.md](development.md#running-the-failure-drills): they stop containers and truncate shared tables.

| # | Drill | Expected | Observed | What changed in the code | Runbook |
|---|---|---|---|---|---|
| 1 | Redis stopped for 10 s under traffic on the gateway | degraded service | v1: **100% errors** for the whole outage, each request hung until the drill script's own 2 s abort (the service itself had no timeout, which was the problem); v2: **0 errors** on availability (0 errors in every one of the 26 one-second buckets of the latest run, including the 10 s outage), holds/queue return a fast 503 | fail-fast Redis client (no offline queue, 200 ms timeout), per-route fail-open/closed policy | [runbook](operations.md#drill-1-redis-down) |
| 2 | Redpanda (Kafka) stopped while 300 payments are made | payments keep working, events not lost | 300/300 payments OK in 0.7 s; 300 events buffered in the outbox; **caught up 0.7 s** after the broker returned; topic grew by exactly 300 | none needed: this is what the outbox is for | [runbook](operations.md#drill-2-broker-down) |
| 3 | Notifications consumer SIGKILLed at 6 229 / 12 000 deliveries | no loss, no duplicates | restarted consumer finished all **12 000 / 12 000**, 0 duplicate rows, 0 rows stuck; took 34.5 s because 25 claims were mid-send and wait out the 30 s lease | none: lease expiry is the designed recovery path | [runbook](operations.md#drill-3-consumer-killed) |
| 4 | Payment provider slow (20 s) while 300 payments run | degraded, bounded | before: **300 of 300 clients timed out at 15 s with no answer** while the service finished the work silently; after: **300 x 202 in-progress at p50 2.1 s**, all final **3.1 s** after recovery in the latest run (3.2 s in the first run, 4.5 s in an earlier saved rerun), 0 duplicate charges, 0-1 DB connections throughout | step timeouts (PSP, inventory confirm), 202 + sweeper, idempotent confirm, relay on its own pool, pool/statement/upstream timeouts | [runbook](operations.md#drill-4-slow-payment-provider) |
| 5 | Email channel down, 200 messages dead-lettered, then fixed and the DLQ replayed | no loss, no resend | all **400 of 400** deliveries completed, push (already sent) **not resent**, 0 duplicate rows | `replay-dlq.ts`: republish the DLQ, rely on per-channel dedup | [runbook](operations.md#drill-5-channel-down-dlq) |

## Raw output and reproducibility

The raw output is saved in [`drill-output/`](drill-output/), one file per drill, with date, Node version and commit in the header. Drills 1, 2 and 4 (gateway, inventory, payments) were re-run on 2026-11-06 after the upgrade from NestJS 10 / Fastify 4 to NestJS 12 / Fastify 5; their files carry the NestJS and Fastify versions in the header. Drills 3 and 5 only involve the notifications consumer and Kafka, which were not upgraded and not re-run, so their files come from the earlier saved run the same day (Node 26, MacBook Air M1, everything on one machine). The figures in this file and in the playbook that carry a time are taken from those files. The first run, made earlier the same day without saving the output, gave the same invariants (no lost events, no duplicates, no errors on the fail-open route) and these timings: broker catch-up 1.2 s (latest 0.7 s), consumer killed at 6 492 / 12 000 and finished in 33.6 s (saved run 6 229 and 34.5 s), slow-PSP recovery 3.2 s (an earlier saved rerun 4.5 s, the latest run on the new stack 3.1 s). Timings vary between runs on a laptop; the invariants are what the drills assert.

Not reproducible: the "before" rows of drills 1 and 4 (100% errors when Redis stops; 300 of 300 clients timing out against a 20 s PSP) describe the code before the fixes. Those results were observed once; the old code no longer exists in the tree.


## Sentences these give you
1. "I tested the failure path: with Redis down my first gateway returned 100% errors because the client queued commands and every call hung. I made the client fail fast and chose fail-open for public reads and fail-closed for anything that spends inventory."
2. "Payments do not depend on the broker being up. The outbox row commits with the state change; the relay catches up. When I stopped the broker, 300 payments succeeded and all 300 events arrived 0.7 s after it returned."
3. "A killed consumer neither lost nor duplicated deliveries. Recovery time is bounded by the lease length (34.5 s measured with a 30 s lease), which is the explicit trade-off between fast takeover and double sends."

4. "When the payment provider got slow, clients used to hang until their own timeout with no answer while the server finished the work silently. I bounded each step at 2 s and answer 202 in-progress; a sweeper completes the saga. The catch I measured: a timeout is an unknown outcome, not a failure. If it were treated as failure, a timed-out inventory confirm would refund a sold seat. And the timeout must sit above the provider's p99, or healthy-but-slow calls get turned into async ones."
5. "Dead-lettered messages are replayable because delivery state is per channel: after fixing email I replayed 200 messages and only the email channel was sent."

## Refund recovery (REFUNDING): tested, not a timed drill
The payments saga claims the refund (`CHARGED -> REFUNDING`, compare-and-set) before it issues the keyed refund ([ADR 005](../services/payments/adr/005-claim-refund-before-issuing-it.md)). A crash after the claim leaves `REFUNDING`; the sweeper picks up `PENDING`, `CHARGED` and `REFUNDING` and re-issues the refund with the same key, so the provider sees one refund. This is covered by tests, not by a drill with timings: `services/payments/src/saga.races.ts` (REFUNDING claim races, a refund call that times out and is finished by the sweeper, a provider that cannot find the charge leaves `REFUNDING`) and a crash injected at each of 8 boundaries (`FaultHook`, before and after charge, confirm, refund and transition) for both confirm outcomes, plus a fast-check model-based test with random crashes and 1 to 4 concurrent runners. `payments_sagas{state="REFUNDING"}` staying above zero is the production signal ([operations](operations.md#metric-catalogue)). Residual risk, from the ADR: a provider that keeps failing is retried forever, with no retry cap or dedicated alert.

## Not drilled (stated honestly)
Three of the claims in the drills above are also asserted automatically, with invariants and on private containers, by the [fault suite](e2e.md#fault-suite-pnpm-teste2efaults): Redis down (drill 1: holds and pay 503 with Retry-After, availability open, what the waiting room loses), broker down (drill 2: the outbox backlog grows, the gauges show it, the relay publishes it once after recovery) and a Postgres outage, which no drill covers. That suite does not replace the drills: it has no load numbers and no raw output, only pass or fail.

Postgres failover (a Postgres outage without failover is in the fault suite), network partitions between services, clock skew, disk full, slow Postgres, slow Redis and a slow broker (proposed with derived expectations in [reliability-patterns](playbook/reliability-patterns.md), none run). Slow PSP is drill 4.

## Run
The drills stop and start the compose containers and truncate shared tables (`notifications.deliveries`), so do not run them while tests or load scripts use the same Postgres, Redis or Redpanda. Details: [development.md](development.md#running-the-failure-drills).
```
docker compose up -d
pnpm build
node drills/redis-down.mjs      # needs inventory 3101, waiting-room 3102, gateway 3100 running
node drills/kafka-down.mjs      # needs inventory 3101, payments 3103 running (the drills send PAYMENTS_INTERNAL_TOKEN, default dev-internal-token)
node drills/consumer-kill.mjs   # starts and kills its own consumers
node drills/slow-psp.mjs 20000  # needs inventory 3101 and payments 3103 started with PSP_ADMIN=1
node drills/dlq-replay.mjs      # needs the notifications package built; runs its own consumer
```
