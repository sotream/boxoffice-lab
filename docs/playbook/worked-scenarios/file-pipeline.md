# Worked scenario: file processing pipeline (long-running jobs)

[paper design] No code in this repo implements this system: every figure below is derived from stated assumptions with the formulas in [`packages/capacity`](../../../packages/capacity/src/index.ts), or borrowed from a measured component and cited. Nothing here was run.

Load shape: few requests, each one expensive and slow (seconds to minutes of CPU), bursty arrival, large payloads, and inputs that can be hostile. The limit is worker-seconds and the cost per file, not request rate. Matching shape in the playbook: [workload-to-architecture.md](../workload-to-architecture.md) (long-running / asynchronous jobs). Related: [reliability-patterns.md](../reliability-patterns.md), [scaling-ladder.md](../scaling-ladder.md), [numbers-to-know.md](../../numbers-to-know.md).

Labels: [measured] lab figure with its source file, [derived] arithmetic shown, [folk] common ballpark not measured here, [paper design] a design with no code here.

## Requirements

Functional
- A user uploads a document (typically 5 MB, up to 100 MB).
- The pipeline runs four steps in order: malware scan, text extraction (OCR), conversion to a preview format, search indexing.
- The user sees progress per file and a final status: done, or failed with a reason.
- A failed step is retried; a file that cannot be processed is parked for a human, not retried forever.

Non-functional (assumptions)
- 50 000 files per day, peak factor 10 (business-hours bursts), average 5 MB.
- Step durations on one worker slot (one vCPU): scan 2 s, OCR 12 s, convert 5 s, index 1 s, so 20 s per file (placeholders to measure).
- 95% of files finished within 5 minutes of upload, also at peak.
- No file processed twice in a visible way (no duplicate index entries, no double charge for a metered step).
- Originals kept 1 year.

## Estimates

Unit prices in this file are placeholders. `U` is a unit of money chosen by the reader: 1 U per vCPU-hour of worker and 1 U per TB-month of object storage are stand-ins, not real prices; replace them before using any cost line.

| Quantity | Formula and arithmetic | Result |
|---|---|---|
| Files per second | `traffic --dau 50k --actions 1 --peak 10`: 50 000 / 86 400 = 0.58; x 10 | 0.58 avg, 5.8 peak [derived] |
| Worker slots busy at peak (Little's law) | `concurrency --rps 5.787 --latency-ms 20000`: 5.8 x 20 s | 115.7 slots [derived] |
| Slots with headroom | 115.7 / 0.6 | 193 slots [derived]; at 4 slots per worker, ceil(193 / 4) = 49 workers |
| Slots busy on average | 0.58 x 20 s | 11.6 slots [derived] |
| Peak utilisation of a static fleet | work done per day = 50 000 x 20 s = 277.8 slot-hours; fleet sized for peak, 193 slots x 24 h = 4 632 slot-hours; 277.8 / 4 632 | 6% [derived]: a static fleet sized for peak is idle 94% of the day, so scale workers on queue depth |
| Cost per file | 20 s / 3 600 x 1 U per vCPU-hour | 0.0056 U compute per file [derived, placeholder price] |
| Upload bandwidth if the API proxies bytes | `bandwidth --rps 5.8 --bytes 5M` | 29 MB/s = 232 Mbit/s through the API at peak [derived]; zero if uploads go directly to object storage |
| Original storage | `storage --records-per-day 50k --bytes 5M --years 1 --replication 1` | 91.3 TB per year [derived]; at 1 U per TB-month the standing cost after a year is 91.3 U per month, plus derived artefacts (preview, text) which are an extra to estimate |
| Metadata writes | per file: 1 create + 4 steps x (start, finish) = 9 state changes; 9 x 5.8 | 52 writes/s at peak [derived], far under one Postgres (2 091 commits/s lower bound, [derived from payments RESULTS.md](../../../services/payments/RESULTS.md), 697 RPS x 3 commits) |
| Status polling | clients poll every 2 s while their file is in flight: 115.7 in flight x 0.5 | 58 RPS [derived]; trivial, cache it |
| Cost of poison files | max 3 attempts x 120 s timeout = 360 slot-s per poison file vs 20 s normal; at 1% poison = 500 files/day x 360 s / 3 600 | 50 slot-hours/day, 18% extra over the 277.8 slot-hours of normal work [derived] |

## Design

Components: API (issues presigned upload URLs, creates the file record, serves status), object storage (originals and outputs), queue, worker fleet (autoscaled by queue depth), Postgres (file and step state), and a dead-letter queue with a replay tool.

Data model
- `files(id, owner_id, object_key, size, status, created_at)`.
- `file_steps(file_id, step, status, attempts, last_error, started_at, finished_at, output_key)` with primary key `(file_id, step)`.
- Outputs are written to deterministic keys, e.g. `out/{file_id}/{step}/v{n}`.

Flow
1. Client asks the API for an upload URL; API creates the `files` row and returns a presigned URL. The client uploads directly to object storage. The API never touches the bytes (the 29 MB/s above disappears).
2. Object storage emits an "object created" notification; a small handler verifies size and enqueues one `process(file_id)` message.
3. A worker takes the message, then walks the steps. Each step: claim the `(file_id, step)` row with a lease, skip if already `done`, run, write the output to its deterministic key, mark `done` in one statement.
4. After the last step the file is `done`; the status endpoint reads the row.

Key decisions

1. Queue with per-message acknowledgement and visibility timeout, not a partitioned log.
   - Job durations vary by 100x (2 s to minutes). In a partitioned log one slow file blocks the partition behind it, and parallelism is capped by partitions: 193 slots would need 193 partitions ([numbers-to-know.md](../../numbers-to-know.md) section e: partitions bound consumer parallelism).
   - The lab chose a log for notifications because of replay and later consumers ([notifications adr/001](../../../services/notifications/adr/001-kafka-for-notifications.md)), and noted that a managed queue is the better fit for a pure task queue because per-message ack, delay and dead-letter are built in. This scenario is that pure task queue. Rejected here: Kafka. Rejected: a Postgres `SKIP LOCKED` table at larger scale; acceptable below roughly 50 files/s since the state table already exists (see x10).
2. Idempotent steps, state per step. A retry or a duplicate delivery must produce the same visible result: deterministic output keys (overwriting the same object is harmless), the index step is an upsert on `file_id`, and the step row is the arbiter, as the unique `(outbox_id, channel)` key is in notifications ([notifications adr/002](../../../services/notifications/adr/001-kafka-for-notifications.md): at-least-once, dedup key, lease so two workers cannot do the same item at once; measured 0 duplicate rows, [notifications RESULTS.md](../../../services/notifications/RESULTS.md)). Rejected: one big "process file" function that is re-run from step 1 on any failure, which pays the 12 s OCR again after an index failure.
3. Per-step retry policy, not per-file.
   - Transient errors (timeouts, 5xx from a scan service): exponential backoff with jitter, up to 3 attempts per step.
   - Permanent errors (unsupported format, encrypted file, scanner says infected): no retry, status `failed` with the reason shown to the user.
   - The attempt counter is incremented before the step starts, so a worker that crashes or is OOM-killed mid-step still counts; otherwise a file that kills the worker is retried forever (the classic poison file).
4. Poison files go to the dead-letter queue with the error and attempt history, and the queue moves on. Same decision as [notifications ADR 003](../../../services/notifications/adr/001-kafka-for-notifications.md) (measured: 10 poison messages gave exactly 10 dead letters and the other 38 000 deliveries completed). A step has a hard timeout (120 s here, 10x the 12 s typical OCR time) and a memory limit; zip bombs and 100 MB scans are bounded by those, not by hope. The 18% extra cost above is what the policy bounds: without the timeout and attempt cap a poison file is unbounded.
5. Visibility timeout rule: at least the step timeout plus margin (150 s here) with a heartbeat that extends it; shorter than the step and the same file is processed twice at once.
6. Progress reporting: the status endpoint returns the `file_steps` rows (step, status, percent when the step can report it). Rejected: pushing events to every client for every step at this scale; polling at 58 RPS is cheaper to build and to run, and server-sent events can be added later behind the same data.
7. Fail-safe on dependencies: the scan service down means the queue grows and files wait; nothing is dropped. Alert on queue age (oldest message), not on queue length, because age is what breaks the 5-minute objective.

## What breaks at x10

x10 means 500 000 files per day, 57.9 files/s at peak, 1 157 busy slots (`concurrency --rps 57.87 --latency-ms 20000`).

1. First bottleneck: worker fleet size and scale-up speed, which is a cost and latency problem, not a throughput one.
   - Slots with headroom: 1 157 / 0.6 = 1 929; at 4 slots per worker, 483 workers [derived]. If scaling out takes 3 minutes, a 10x burst already uses the 5-minute objective before the fleet exists.
   - Changes: scale on queue age with a minimum warm pool; reduce per-file work (skip OCR for files that already contain text, which is the largest step at 12 of 20 s, 60% of the cost [derived]); a priority lane so small files are not stuck behind 100 MB ones.
   - Cost at x10: 500 000 x 0.0056 U = 2 778 U per day of compute at the placeholder price, linear in files [derived]; the saving lever is seconds per file, not instance type.
2. Second bottleneck: state writes and queue as a database table.
   - State changes: 9 x 57.9 = 521 writes/s at x10 [derived], inside the 1 255 per second budget (2 091 x 0.6). The budget is exhausted at 1 255 / 52 = x24 [derived], so the `file_steps` table with a `SKIP LOCKED` queue on the same primary stops being enough near x24; move the queue to a managed queue and keep only state in Postgres. Also partition `file_steps` by month and prune finished rows.
3. Not yet a bottleneck at x10: status polling (580 RPS, [derived]) and original storage growth (913 TB per year at x10 [derived: 10 x 91.3], which is a cost line, so add lifecycle rules: move originals to a cheaper tier after 30 days).

## What would be measured first

1. Real step durations and memory per step on a sample of 1 000 real files of the expected size mix: the 2/12/5/1 s figures decide everything above. Report p50, p95, p99 per step and peak memory.
2. Queue and worker behaviour under a burst: a script modelled on [services/notifications/load/bench.js](../../../services/notifications/load/bench.js) (it produces N items including duplicates and poison messages, runs consumers with injected latency, flaky provider failures and a concurrency setting, then verifies counts, duplicates and dead letters). Adapt it: items are files, latency is per step, 1% poison, 5% duplicates, 3% transient failures. Pass criteria written first: every non-poison file `done` exactly once, poison files exactly in the dead-letter queue, oldest-message age below 5 minutes at the 10x burst.
3. Worker kill mid-step: copy [drills/consumer-kill.mjs](../../../drills/consumer-kill.mjs) (SIGKILL a consumer at about half progress; expect all items finished, 0 duplicates, recovery equal to the lease or visibility timeout). The 30 s lease recovery measured in [failure-drills.md](../../failure-drills.md) drill 3 is the reference shape; here the timeout would be 150 s.
4. API under many in-flight uploads: k6 against the presign and status endpoints only (copy [services/waiting-room/load/join.js](../../../services/waiting-room/load/join.js), which does one write and polls status twice per iteration), to confirm the 58 RPS estimate is trivial and that no bytes pass through the API.

## Where this is proven in the repo / what is still paper

Proven (other components): at-least-once with a dedup key and a lease, dead-letter for poison messages, exact counts after 1 000 duplicates and 10 poison messages, and recovery after a killed consumer ([notifications RESULTS.md](../../../services/notifications/RESULTS.md), [failure-drills.md](../../failure-drills.md) drill 3); idempotency keys as a unique column ([payments adr/003](../../../services/payments/adr/001-saga-over-2pc.md)); the commit-rate floor of one Postgres ([payments RESULTS.md](../../../services/payments/RESULTS.md)).

Still paper: the upload flow, presigned URLs, step runner, autoscaling, the step durations, the cost per file (placeholder price), all x10 figures. The notifications consumer handles 20 ms sends, not 12 s CPU steps, so its per-second figures do not transfer.
