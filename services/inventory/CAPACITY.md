# inventory: capacity

*The measured figures quoted here come from the RESULTS.md of this service, taken before the metrics/logging of `@boxoffice/platform` existed and (where Postgres is involved) on PostgreSQL 17; they have not been re-measured. See the measurement status at the top of [RESULTS.md](RESULTS.md).*

Formulas live in `packages/capacity`. Assumptions are stated so you can change them.

## Traffic (flash sale, the worst case)
- 50 000 users arrive in 60 s, each retries ~3 times -> 150 000 hold attempts.
- peak RPS = 150 000 / 60 = **2 500 RPS** (average day: 1M DAU x 2 holds / 86 400 = 23 RPS; peak factor ~100).

## Instances
- Measured one Node instance: 2 654 hold RPS on the first version, 2 294 on the final code in one noisy run (PostgreSQL 18, instrumented, ordered locks; see RESULTS.md), and 1 711 / 3 624 / 10 679 as 5-run medians on a GitHub runner, a quiet M1 Air and an M4 Pro. The planning figure below (2 600) is rounded down from the first measurement; with the final code it would be 2 200.
- instances = ceil(2 500 / (2 600 x 0.6)) = **2** (0.6 = headroom for GC, deploys, a failed node).
- But the real limit is Postgres, not Node: all instances write to one primary.

## Database
- Concurrency (Little's law) = RPS x latency = 2 500 x 0.018 s (measured p50 of 18 ms) = **~45 connections** in flight. Two instances at 20 connections each give 40, which is short of 45, so use a pool of about 25 per instance or a pooler in front.
- Writes: each hold is 1 row update, ~2 500 TPS. A single Postgres primary on SSD handles several thousand simple TPS, so **no sharding needed** for one event. Hot seats serialise on row locks, which is the point.
- If many events sell at once: shard by `event_id` (shards = peak writes / (writes per shard x 0.6)).

## Storage
- 100 000 seats x ~100 B = **10 MB** per big event. 5 years x 1 000 events/year = ~50 GB with indexes. Trivial; capacity is a CPU and lock problem here, not a disk problem.
