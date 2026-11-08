# Benchmarks: repeated runs and a second environment

The `RESULTS.md` files of the services each report one run on one MacBook Air M1. A single run says nothing about run-to-run noise, and one machine says nothing about other hardware. This page addresses both as far as a local checkout allows: `scripts/bench.sh` repeats the existing k6 scenarios and reports the spread, and a manually dispatched workflow runs the same scenarios on a GitHub-hosted runner. It does not change any figure in a `RESULTS.md`.

## Method

`scripts/bench.sh <scenario> [runs=3]` with scenario `inventory`, `waiting-room`, `payments`, `catalog`, `gateway`, `notifications` or `all`:

- starts the built services itself (`node dist/main.js` from each package, the environment of the existing `load/run.sh` scripts: `SEED_SEATS=100000 PG_POOL=20` for inventory, `SEED_EVENTS=200000` for catalog, `PSP_LATENCY_MS` 100 and 0 for payments; for `gateway`, inventory with the inventory settings and the gateway with `IP_RATE=100000 IP_BURST=100000`, the values of the e2e Stack);
- waits for `/readyz` instead of sleeping, refuses to start when the port already answers, and kills everything it started on exit (`trap EXIT`);
- runs the unchanged k6 scripts (`load/hold.js`, `join.js`, `pay.js`, `search.js`, `overhead.js`) N times with `--summary-export` and prints one Markdown row per scenario row: median, min and max of RPS, p95 and p99, plus failed requests, failed checks and how many runs breached a k6 threshold;
- keeps runs independent: inventory gets a fresh process and a re-seeded table per run; waiting-room uses a flushed Redis logical database (`BENCH_REDIS_DB`, default 12) because user ids repeat between runs; payments truncates `payments.payments` and `payments.outbox` before each run because idempotency keys repeat (otherwise a second run would replay stored results); catalog flushes the cache database before each run. Payments also starts inventory, as the saved payments run did, so that the seat confirm fails and every payment takes the compensation path. Payments needs Redpanda (`docker compose up -d`);
- `gateway` has two rows from `services/gateway/load/overhead.js` (GET availability, 50 VUs, 15 s): `direct to inventory` (`BASE=http://localhost:3101`) and `through gateway` (`BASE=http://localhost:3100`). It starts only inventory and the gateway (waiting-room and payments are not touched by that route; the gateway's `/readyz` is on its ops port 3106) and flushes the Redis database before each gateway run. Inventory requires signed requests: the script signs the direct request and the gateway signs its own, both with `INVENTORY_INTERNAL_TOKEN` (development default unless exported). The gateway's per-IP limiter is **effectively off** for the measurement (limit 100 000 requests per second, burst 100 000) so that it does not cap throughput; the limiter and its Redis round trip are still in the path, so the row measures proxy plus limiter, not the limit. A 429 would show up under failed requests;
- `notifications` is not a k6 scenario: `services/notifications/load/bench.js` is one node process that creates a fresh 3-partition topic, produces 21 010 events (20 000 unique, 1 000 duplicates, 10 poison), consumes them in-process with `PARTS=1` and `PARTS=3` partitions at once (provider 20 ms, `CONCURRENCY` 25, as the saved run) and prints one JSON line. `bench.sh` runs it N times per row and prints time and deliveries/s (median, min, max) together with the integrity checks of every run: deliveries sent against expected, duplicate `(event, channel)` rows, dead letters (10 expected) and provider calls; a run that fails a check is counted in the last column. Needs Postgres and Redpanda (`docker compose up -d`) but not k6. It truncates `notifications.deliveries` before each run and after the last one, and on exit removes leftover `payments-bench-*` topics and `g-*` groups. `N`, `SENDER_LATENCY_MS` and `CONCURRENCY` pass through to the script; the saved run's partition count is fixed at 3 by the script. `BENCH_CPU=1` samples the bench process as `node`;
- flushes and truncates through the container that publishes port 56379 or 55432 (works for compose and for CI service containers; override with `REDIS_CONTAINER` and `PG_CONTAINER`). If no Redis container is found the flush is skipped with a note on stderr;
- checks the 1-minute load average before every run, logs it to `load.log`, waits up to 60 s while it is above 4 (`BENCH_MAX_LOAD`, `BENCH_LOAD_WAIT`) and then goes ahead and says so;
- writes the raw k6 summaries (`*.json`, plus the k6 exit code), `table.md` and `load.log` to `BENCH_OUT` (default `./bench-out`, gitignored). `VUS` and `DURATION` pass through to k6 for shorter smoke runs;
- with `BENCH_CPU=1` (default off, nothing changes when unset) a background sampler reads `ps -Ao pcpu,comm` every `BENCH_CPU_INTERVAL` seconds (default 5) during each k6 run, for `node`, `k6`, `postgres`, `redis-server` and the VM/container layer (macOS `com.apple.Virtualization.VirtualMachine`, Linux `dockerd` and `containerd-shim`, as present). Raw samples go to `cpu-<label>.log`; after each scenario row a table of peak and mean per process is printed and appended to `table.md`. Per sample, same-named processes are summed (all Postgres backends count as one `postgres`), and a sample where a process is absent counts as 0 in the mean.
- Read the numbers as % of one core: 190 means about 1.9 cores busy, so the split between service, k6 and database shows where the machine saturates. On macOS Docker runs in a VM, so Postgres and Redis show up only inside the `com.apple.Virtualization.VirtualMachine` row, and `ps` reports a decayed average rather than an instantaneous value, so the first samples lag and short peaks are smoothed; on Linux `ps` reports CPU time over process lifetime, which also lags for long-running processes (dockerd, postgres). Use it for the rough split, not for exact figures.

```bash
docker compose up -d && pnpm build
scripts/bench.sh inventory 3
scripts/bench.sh gateway 3
scripts/bench.sh notifications 3
BENCH_OUT=/path/to/dir scripts/bench.sh all 5
```

### GitHub-hosted runner

`.github/workflows/bench.yml` is `workflow_dispatch` only. It starts the same Postgres 18 and Redis 7 service containers as CI (Redpanda by hand only for `payments`, `notifications` and `all`), installs k6 2.3.0 with `grafana/setup-k6-action@v1`, logs `lscpu`, `nproc`, `free -m`, kernel, Node, k6 and Postgres versions to the job summary, runs `scripts/bench.sh`, appends the tables to the job summary and uploads `bench-out` as an artifact (90 days).

```bash
gh workflow run bench.yml -f scenario=inventory -f runs=3
gh run list --workflow bench.yml --limit 1
gh run watch          # then open the run page: the tables are in the job summary
```

Differences from the local setup that matter when comparing: the runner has few vCPUs and shares the host, Postgres runs with its default settings (the compose file sets `max_connections=200` and `shared_buffers=256MB`, a service container cannot take start arguments), and the load generator again shares the machine with everything else.

## Local: MacBook Air M1

Date 2026-11-07, commit 567c0bd (the working tree also held uncommitted edits to other packages at the time), MacBook Air M1 (16 GB), macOS 26.7, Node 26, Postgres 18.6 and Redis 7 in Docker, `scripts/bench.sh inventory 3` and `scripts/bench.sh waiting-room 3` with the script defaults (inventory 50 VUs, 20 s; waiting-room 100 VUs, 20 s). **k6, the service, Postgres and Redis share the one machine**, and the machine was not idle: other development work ran at the same time (see the load note below). Cells are median (min-max) over 3 runs; 0 failed requests, 0 failed checks and 0 breached thresholds in every row.

| Row | RPS | p95 ms | p99 ms |
|---|---|---|---|
| inventory, atomic-update, low contention (100 000 seats) | 1711 (1484-2113) | 47.7 (34.9-61.2) | 77.4 (46.2-142.3) |
| inventory, atomic-update, hot (20 seats) | 1995 (1038-2324) | 43.1 (33.1-102.7) | 60.5 (48.4-199.9) |
| inventory, for-update, low contention (100 000 seats) | 2067 (1415-2396) | 34.8 (28.4-59.1) | 44.0 (35.0-88.7) |
| inventory, for-update, hot (20 seats) | 3400 (2983-3410) | 20.4 (20.2-25.9) | 27.1 (26.5-35.2) |
| waiting-room, join + 2 status polls | 7505 (5986-8444) | 23.3 (19.5-31.9) | 33.0 (26.8-51.4) |

Load average (1 minute) logged before the 15 runs: 3.7 to 19.0; 11 of 15 runs started above the threshold of 4 even after waiting 60 s, and 5 of them above 6. Part of that is the benchmark's own previous run (a 1-minute average decays slowly), part is other processes on the machine. These are therefore noisy runs, and they are reported as such; a quiet-machine repeat is a new measurement. The raw summaries and `load.log` are not committed (`bench-out/` is gitignored).

## Local: MacBook Pro M4 Pro

Date 2026-11-07, commit `47158f1` (clean clone), MacBook Pro with Apple M4 Pro, macOS 27.2, on AC power, Node 26.13.0, pnpm 12.16.1, k6 2.3.0, Docker Desktop (server 29.9.2) with 12 CPUs and 8.3 GB in the VM, Postgres 18 and Redis 7 from `docker-compose.yml`. `scripts/bench.sh inventory 5` and `scripts/bench.sh waiting-room 5`, script defaults, 5 runs each, 0 failed requests, 0 failed checks, 0 breached thresholds. The Docker Desktop virtualization mode could not be read and is not stated here.

| Row | RPS median (min-max) | p95 ms | p99 ms |
|---|---|---|---|
| inventory, atomic-update, low contention (100 000 seats) | 10 796 (10 619-10 863) | 5.9 | 7.0 |
| inventory, atomic-update, hot (20 seats) | 12 261 (12 183-12 308) | 4.9 | 5.9 |
| inventory, for-update, low contention (100 000 seats) | 10 720 (10 658-10 764) | 6.3 | 7.3 |
| inventory, for-update, hot (20 seats) | 13 682 (13 640-13 778) | 4.4 | 5.1 |
| waiting-room, join + 2 status polls | 39 144 (38 744-39 364) | 3.8 | 4.3 |

Load average (1 minute): 2.6 to 3.1 before the runs; 10 of the 20 inventory runs still started above the threshold of 4 (highest 6.05), all 5 waiting-room runs started below it (3.4 to 4.0). On 12 cores a load of 4 to 6 is not saturation, and the spread is tight (under 2% for every row). No thermal data was collected. The optional payments run failed before starting because of a bug in `bench.sh` (it truncated the payments tables before the service had created its schema); fixed in the same change, so payments has still not been measured here.

## GitHub-hosted runner (ubuntu-latest)

Commit `62a1445`, AMD EPYC 7763, 4 vCPU, 16 GB, Postgres 18 with default settings, k6 on the same runner, 5 runs per scenario, 0 failed requests. Runs: [inventory](https://github.com/sotream/boxoffice-lab/actions/runs/42369726037), [waiting-room](https://github.com/sotream/boxoffice-lab/actions/runs/42369728641). RPS is the median with min-max in brackets.

| scenario | RPS | p95 ms | p99 ms |
|---|---|---|---|
| inventory atomic, low contention | 1 711 (1 666-1 737) | 37.6 | 47.1 |
| inventory atomic, hot | 1 960 (1 925-1 968) | 32.6 | 39.8 |
| inventory for-update, low contention | 1 812 (1 789-1 821) | 35.7 | 43.7 |
| inventory for-update, hot | 2 476 (2 424-2 487) | 26.0 | 32.7 |
| waiting-room | 6 522 (6 265-6 565) | 22.8 | 28.0 |

The spread here is tight (under 5%), unlike the laptop. Finding: on the final code for-update is equal or faster than atomic-update, so the earlier "single UPDATE is ~18% faster" claim is retracted. Absolute numbers are lower than the laptop's because of 4 shared vCPUs and default Postgres settings, so compare ratios, not levels.

## Reading the spread

- Run-to-run noise on this machine is large. Max over min of RPS in the same row: 1.4x (atomic-update low), 2.2x (atomic-update hot), 1.7x (for-update low), 1.1x (for-update hot), 1.4x (waiting-room). p99 varies even more (atomic-update hot: 48 to 200 ms).
- That noise is at least as large as the differences the playbook and README quote: about 18% to 22% between atomic-update and for-update at low contention in `services/inventory/RESULTS.md`, 2 485 vs 2 001 RPS (about 19%) for the gateway overhead, or the 9% by which the configured admission budget exceeds the re-derived one. A single run cannot support a claim of that size; with spreads of 40% to 120% even three runs only support an order-of-magnitude statement.
- In this repeat the ordering at low contention is even the reverse of the saved table (median for-update 2 067 vs atomic-update 1 711 RPS, but the ranges 1 415-2 396 and 1 484-2 113 overlap almost completely), and the absolute level is 5% to 40% below the saved single run in the same rows (for example atomic-update low 1 711 vs 2 654 RPS). The saved figures were measured on Postgres 17 before the platform instrumentation, in a quieter session, so level and noise are not separable here.
- What the data does support: the hot-contention for-update row is stable (1.1x) and fastest, and waiting-room runs at several thousand RPS, an order of magnitude above its admission budget of 500 users/s. Differences below roughly 2x between rows should be read as "not distinguishable" unless they repeat across a quiet-machine run and the runner.
- This is an argument for quoting ranges, and for treating the planning figures in the playbook (which are rounded down, see [numbers-to-know](numbers-to-know.md)) as orders of magnitude.

## Local: MacBook Air M1, repeat on a quieter machine

Same machine as the first M1 section, repeated the same day (2026-11-07, 15:59 to 16:30 CET) on AC power, with the other applications closed and Redpanda stopped, after the first M1 numbers turned out to be depressed by load. Branch `bench/m4-pro-results` (services unchanged since `47158f1` except the pool handler and the payments key scoping), Docker Desktop with 8 CPUs and 8.3 GB, `scripts/bench.sh inventory 5` then `scripts/bench.sh waiting-room 5`, 0 failed requests, 0 breached thresholds. The machine was not idle: the 1-minute load average before the 25 runs was 3.8 to 16.2 (one outlier, 16.2), and 15 of the 25 runs still started above the threshold of 4 after the 60 s wait; the spread is nevertheless under 6% per row.

| Row | RPS median (min-max) | p95 ms | p99 ms |
|---|---|---|---|
| inventory, atomic-update, low contention (100 000 seats) | 3 624 (3 547-3 799) | 18.7 | 23.4 |
| inventory, atomic-update, hot (20 seats) | 4 207 (4 082-4 485) | 15.9 | 20.3 |
| inventory, for-update, low contention (100 000 seats) | 3 759 (3 364-3 851) | 18.4 | 23.6 |
| inventory, for-update, hot (20 seats) | 5 214 (5 020-5 469) | 13.9 | 18.7 |
| waiting-room, join + 2 status polls | 15 216 (13 761-16 247) | 11.5 | 17.3 |

CPU sampled with `ps` every 5 s during the runs: the Node service peaks at about 160% and k6 at about 160% of one core, on the same machine (this is a single-host test: load generator, service and database compete for the same cores).

The first M1 table above (1 711 to 7 505 RPS) is therefore a result of the machine's state, not of the code: the same rows are 2.0 to 2.4 times higher here. It is kept as a record of how far an uncontrolled run can be off.

## Three environments compared

| Row (median RPS) | GitHub runner, 4 vCPU (5 runs) | M1 Air, quieter (5 runs) | M4 Pro (5 runs) |
|---|---|---|---|
| inventory atomic, low | 1 711 | 3 624 | 10 796 |
| inventory for-update, low | 1 812 | 3 759 | 10 720 |
| inventory atomic, hot | 1 960 | 4 207 | 12 261 |
| inventory for-update, hot | 2 476 | 5 214 | 13 682 |
| waiting-room | 6 522 | 15 216 | 39 144 |

The M4 Pro column is the first M4 Pro run (2026-11-07, commit `47158f1`, [above](#local-macbook-pro-m4-pro)). The repeat with CPU sampling (2026-11-07, commit `90b6a5a`, [below](#m4-pro-with-cpu-sampling-and-payments-on-two-machines)) gave 10 679 RPS for the first row, 1.1% lower; the README, `services/inventory/RESULTS.md` and `numbers-to-know.md` quote that repeat, so their budget is about 2 140 users/s against about 2 160 here. Both are medians of 5 runs; the difference is within the run-to-run spread.

- **The factor is nearly constant across rows.** M1 over runner: 2.1x, 2.1x, 2.1x, 2.1x, 2.3x. M4 Pro over M1: 3.0x, 2.9x, 2.8x, 2.6x, 2.6x. Rows that exercise Postgres with a commit per request and a row that touches only Redis scale by the same amount, and the Node service and k6 each use well over one core, so the single-host test is limited by the CPU the machine can give to service, load generator and the Docker VM (which holds Postgres and Redis and showed 200% to 260% of a core in a `BENCH_CPU=1` waiting-room run on the M1) together; the sampling shows that all three parts are busy, not which one is the limit. That is what the data supports. It does not separate core count from per-core speed (runner 4 vCPU, M1 4 performance plus 4 efficiency cores, M4 Pro 12 cores in Docker's view), and the CPU sampling was not repeated on the runner, so the split is not proven. The M4 Pro sampling is in the next section.
- **The 6x that triggered this was mostly a measurement problem plus real hardware.** M4 Pro over runner is 5.5x to 6.3x, but about 2x of that is the runner against a quiet M1, and about 2.8x is the M1 against the M4 Pro; the first M1 run sat in between only by accident of load.
- **Levels are not portable.** With the README formula (hold RPS x 0.6 / 3) the budget is about 342 users/s from the runner median, about 725 from the quiet M1 and about 2 160 from the M4 Pro, against a configured 500. Derive it on the target hardware.
- **The strategy comparison is consistent where the spread is small.** At low contention atomic-update and for-update are indistinguishable on the runner (-6%), the quiet M1 (-4%) and the M4 Pro (+0.7%); on none does the single conditional UPDATE show the ~18% advantage of the first version. At hot contention for-update is faster everywhere (+26%, +24%, +12%).
- This supports the playbook's position: quote ranges, treat absolute figures as per-environment, and choose between the strategies on correctness.

## M4 Pro with CPU sampling, and payments on two machines

Repeat on the M4 Pro (2026-11-07, 17:04 to 17:43 CET), commit `90b6a5a`, AC power at 100%, Docker Desktop on the Apple Virtualization framework with 12 CPUs and 8.3 GB (the Rosetta setting and the Resources limits were not read), `BENCH_CPU=1 scripts/bench.sh inventory 5`, `waiting-room 5`, `payments 3`. 0 failed requests, 0 failed checks, 0 breached thresholds in all 33 runs. The quiet check before the start read a 1-minute load of 1.8. The load the script logged before the inventory runs was 3.6 to 6.5 and 7 of 20 runs started above 4 even after the 60 s wait; the machine was idle otherwise, so this is mostly the tail of the previous run's own load (the 1-minute average includes the benchmark itself), which means the "wait until load < 4" gate is weak for back-to-back runs. The spread is about 2% or less per row.

| Row | RPS median (min-max) | p95 ms | p99 ms |
|---|---|---|---|
| inventory, atomic-update, low contention (100 000 seats) | 10 679 (10 591-10 712) | 6.0 | 7.1 |
| inventory, atomic-update, hot (20 seats) | 12 095 (11 885-12 140) | 5.0 | 6.0 |
| inventory, for-update, low contention (100 000 seats) | 10 603 (10 468-10 612) | 6.4 | 7.4 |
| inventory, for-update, hot (20 seats) | 13 492 (13 436-13 606) | 4.5 | 5.2 |
| waiting-room, join + 2 status polls | 39 231 (39 077-39 480) | 3.7 | 4.3 |
| payments, PSP 100 ms | 475 (475-497) | 273.5 | 280.5 |
| payments, PSP 0 ms | 2 151 (2 133-2 212) | 68.2 | 73.2 |

The M4 Pro rows agree with the first M4 Pro run within 1.1% to 1.4% (inventory) and 0.2% (waiting-room), so the earlier figures were not a load artefact.

Mean CPU during the runs, as `ps` percent of one core (peak in brackets). The Docker VM is `com.apple.Virtualization.VirtualMachine` and holds Postgres, Redis and Redpanda.

| Scenario | M4 Pro: VM | M4 Pro: k6 | M4 Pro: node | M1: VM | M1: k6 | M1: node |
|---|---|---|---|---|---|---|
| inventory atomic, low | 398 (546) | 84 (112) | 60 (84) | not sampled | | |
| inventory for-update, hot | 325 (450) | 98 (133) | 62 (87) | not sampled | | |
| waiting-room | 129 (176) | 194 (260) | 79 (106) | 200 to 260 (earlier run) | | |
| payments, PSP 0 ms | 316 (470) | 21 (33) | 91 (122) | 341 (455) | 15 (21) | 83 (132) |
| payments, PSP 100 ms | 94 (131) | 6 (11) | 36 (48) | 219 (313) | 10 (18) | 56 (74) |

What this shows, and what it does not:

- **On the M4 Pro the machine is not saturated.** The three sampled processes together average about 5.4 cores of the 12 in the inventory runs and about 4 in waiting-room. Neither the Node service (60% to 90% of one core) nor k6 is at a core limit, so "the test is CPU-bound" does not hold for the M4 Pro in the sense of all cores being busy. The largest consumer in the inventory and payments rows is the Docker VM (3 to 5.5 cores), i.e. Postgres plus the VM's network and disk path; in waiting-room, which touches only Redis, it is k6 (about 2 cores). The single Node process uses one core by design, so a service that is not CPU-limited at 60% to 90% of a core is waiting on something: the round trip to Postgres or Redis through the VM. That is a hypothesis consistent with the numbers; it was not tested (for example by running Postgres natively or with more service instances).
- **Payments is dominated by the PSP latency, then by the VM.** With a 100 ms PSP the 100 VUs are mostly waiting (k6 at 6%, node at 36% of a core) and throughput is about VUs divided by latency; with a 0 ms PSP the throughput is 4.5 times higher on the M4 Pro (2 151 against 475) and 1.8 times higher on the M1 (959 against 536). M4 Pro over M1 is 2.2x without PSP latency (2 151 against 959) and 0.9x with it (475 against 536): the 100 ms row is limited by the latency, not by the machine, and the M4 Pro's p95 there (273 ms) is not better than the M1's (250 ms). With three runs each and a 100 ms floor, this row does not rank the machines.
- **Runner and M1 still have no CPU split for the inventory rows**, so "cores versus per-core speed" remains open; the M1 payments sample (VM at 341% mean of 8 CPUs, node at 83%) points the same way as the M4 Pro.

## Final code on the M1 Air: request signing, the ownership check, gateway and notifications

2026-11-08, 01:49 to 02:34 CET, commit `e57f0bf` (after inventory ADR 002 and payments ADR 007), MacBook Air M1 on AC power, Docker Desktop 8 CPUs and 8.3 GB, Postgres 18, `BENCH_CPU=1`, `scripts/bench.sh inventory 5`, `payments 3`, `gateway 3`, `notifications 3` run one after another by a script that waited for AC power and a 1-minute load below 3 for five minutes. 0 failed requests and 0 breached thresholds everywhere; notifications integrity 38 000 of 38 000, 0 duplicate rows, 10 dead letters, 38 180 provider calls in all runs.

**The machine was not idle.** The containers of two other projects (`evcharge-*`, `normkompass-db`) were running, and the 1-minute load logged before the runs was 3.3 to 5.5 for inventory (8 of 20 runs started above 4 after the 60 s wait), up to 4.4 for payments and gateway and up to 4.8 for notifications. Read the rows below as one more noisy sample, not as a controlled comparison.

| Row (median RPS, min-max) | Quiet M1, before signing (earlier section) | Now |
|---|---|---|
| inventory atomic, low (100 000 seats) | 3 624 | 3 323 (3 280-3 357) |
| inventory atomic, hot (20 seats) | 4 207 | 4 032 (3 442-4 128) |
| inventory for-update, low | 3 759 | 3 179 (2 918-3 284) |
| inventory for-update, hot | 5 214 | 4 871 (4 817-4 954) |
| payments, PSP 100 ms | 536 (520-536) | 521 (519-525) |
| payments, PSP 0 ms | 959 (950-960) | 912 (879-928) |

The k6 scripts now sign every request (`k6/crypto`) and inventory and payments verify it, so these rows include the signing cost on both sides. Every row is 3% to 15% lower than the earlier quiet sample. That comparison is weak, because the earlier sample was taken on a different day with its own load (3.8 to 16.2 before the runs) and a spread of up to 2x between runs on this machine in the first M1 section, so the next subsection measures the effect of signing directly.

### Request signing, measured as an A/B on the same machine

Three runs of `scripts/bench.sh inventory 5` back to back (02:43 to 03:57 CET, same machine, same session, AC power, the other projects' containers still running): **A** is the tree before inventory authentication (`b51732a`, the parent of PR #28), **B** is the tree of PR #28 itself (`5875217`: signed requests, nothing else changed; the later pool and waiting-room changes are not in it), **A2** is the unsigned tree again, to show the drift of the machine. Median RPS (min-max), p95 in ms:

| Row | A (unsigned) | B (signed) | A2 (unsigned again) | B against the mean of A and A2 |
|---|---|---|---|---|
| atomic-update, low (100 000 seats) | 3 468 (3 206-3 570), p95 20.5 | 3 458 (3 344-3 496), p95 23.6 | 3 479 (3 387-3 501), p95 24.8 | -0.4% |
| atomic-update, hot (20 seats) | 4 198 (4 043-4 262), p95 17.1 | 4 083 (3 977-4 172), p95 20.2 | 4 305 (4 210-4 347), p95 18.6 | -3.9% |
| for-update, low | 3 459 (3 210-3 470), p95 21.4 | 3 221 (3 103-3 308), p95 25.4 | 3 442 (3 204-3 480), p95 22.3 | -6.7% |
| for-update, hot | 5 057 (4 875-5 113), p95 14.0 | 4 890 (4 806-4 929), p95 16.1 | 5 066 (4 978-5 098), p95 14.0 | -3.4% |

The two unsigned runs differ from each other by at most 2.5% per row, so the drift of the machine over the 75 minutes was small; the signed run is 0.4% to 6.7% lower (3.6% on average over the four rows), clearly outside that drift in three rows and inside it in the first. Load before the runs was up to 4.9 (A, 4 of 20 runs above 4), 5.1 (B, 9 of 20) and 4.7 (A2, 7 of 20); B did start under slightly more load, which may account for part of its gap. The p95 of the signed run is 1 to 4 ms higher. Reading: signing and verifying cost inventory a small but measurable share of its throughput, **about 0% to 7%, 3.6% on average** here, which is more than the HMAC alone (below) and consistent with the extra work the verifying hook does (it reads the whole body into memory and hands it to the parser as a new stream) plus the signing work k6 does for every request. The split between these was not measured.

What was measured directly for the HMAC: a Node microbenchmark of `signInternalRequest` / `verifyInternalRequest` with a 45-byte body (300 000 calls after a warm-up, on a busy machine) gave 2.4 microseconds to sign and 3.2 to verify. Inventory spends about 170 microseconds of CPU per request at these rates (56% of a core at 3 300 RPS) and only verifies, so the HMAC is about 2% of that; the rest of the 3.6% is the body handling and the caller's side of the signing.

**Payments with the ownership check on is not in this table**: `bench.sh` starts payments with `VERIFY_HOLDS=0` because `load/pay.js` pays for seats nobody holds (see payments ADR 007), so the extra inventory round trip per payment was not measured in that run. `scripts/bench.sh payments-verify` now measures it (`pay.js` with `HELD=1`: seats are held in SQL before each run, every payment ends CONFIRMED, with the check on and, as a control, off); it is meant to be run on the M4 Pro and has no published numbers yet. It does different work from the `payments` rows (confirmed path with one PSP call versus compensation with two and a refund), so the two are not a before-and-after pair.

### Gateway hop

The first run of the new `gateway` scenario seeded inventory with 100 000 seats like the other scenarios and gave 380 RPS direct and 363 through the gateway (p95 189 and 199 ms), against 2 485 and 2 001 in the first measurement. That was an error of the scenario, not a regression: `GET availability` counts the seats of the event on every request, so with 100 000 seats each request scans 100 000 rows and the run measures that scan (the Docker VM sat at 568% of a core). The scenario now seeds 5 000 seats (`GATEWAY_BENCH_SEATS`), the size of `flash-sale.js`; the first measurement does not state its seat count, so the comparison below is approximate.

| Path | RPS median (min-max) | p95 ms | p99 ms | Node mean CPU % |
|---|---|---|---|---|
| direct to inventory | 3 898 (1 955-3 953) | 21.4 | 31.6 | 48 |
| through gateway (IP limiter + proxy) | 2 984 (2 866-3 039) | 27.5 | 41.4 | 78 |

The hop costs about 23% of the throughput (19% in the first measurement, 2 485 to 2 001) and about 6 ms at p95. The direct row contains one run at 1 955 RPS (the other two are within 1.5% of each other); the median ignores it. Both rows ran with a load of 3.7 to 4.1 before the run.

### Notifications

| Partitions consumed at once | Seconds median (min-max) | Deliveries/s median (min-max) | First measurement |
|---|---|---|---|
| 1 | 81.6 (81.5-81.6) | 466 (466-466) | 447 |
| 3 | 27.4 (27.4-27.4) | 1 388 (1 387-1 389) | 1 393 |

Within 4% of the first measurement on Postgres 17 (provider latency 20 ms and concurrency 25, which the first record did not state, so the default of `load/bench.js` was assumed). The consumer is bound by `concurrency x partitions / (provider latency + database time)`, so it moves little with the machine; the Docker VM averaged 165% to 184% of a core and Node 10% to 17% while it ran.


## Final code on the M4 Pro: all scenarios, and payments with the ownership check on

2026-11-08, 09:44 to 12:19 CET, commit `0c1c3c5`, MacBook Pro M4 Pro (8 performance and 4 efficiency cores), AC power at 100%, Docker Desktop on the Apple Virtualization framework with 12 CPUs and 8.3 GB (the Rosetta setting and the Resources limits were not read), `BENCH_CPU=1 scripts/bench.sh <scenario> 3` for every scenario, one after another, 3 runs each, 0 failed checks and 0 breached thresholds in every row. The 1-minute load average was 2.5 to 3 before the runs started, but many runs began after the 10 to 60 s wait of `BENCH_MAX_LOAD` with a load of 3 to 5: inventory 3 of 12 runs above 4, catalog 12 of 18 (peak 16.5 before `fts ranked + Redis cache` run 1, source not identified), gateway 6 of 6 (peak 7.7), waiting-room 1 of 3, notifications 1 of 6, payments and payments-verify none. The container of another project was running throughout. The machine was therefore not quiet, and the figures are comparable with each other and with the 2026-11-07 M4 Pro run only loosely.

Tests on the same checkout: `pnpm test` 616 passed in 45 s, `pnpm mutation:validate` ok (82 mutations), `pnpm test:e2e:faults` 17 passed in 451 s (F1 to F14), `pnpm test:e2e` 11 of 12 passed (see the end of this section).

| Row | RPS median (min-max) | p95 ms | p99 ms | 2026-11-07 RPS (commit `90b6a5a`) |
|---|---|---|---|---|
| inventory, atomic-update, low contention | 10 138 (7 164-10 140) | 6.4 | 7.6 | 10 679 |
| inventory, atomic-update, hot (20 seats) | 11 528 (11 508-11 533) | 5.4 | 6.6 | 12 095 |
| inventory, for-update, low contention | 10 049 (10 037-10 077) | 6.8 | 8.0 | 10 603 |
| inventory, for-update, hot (20 seats) | 12 912 (12 867-12 967) | 4.8 | 5.8 | 13 492 |
| waiting-room, join + 2 status polls | 36 582 (36 476-36 740) | 4.0 | 4.6 | 39 231 |
| payments, PSP 100 ms (compensation, `VERIFY_HOLDS=0`) | 475 (468-482) | 276.5 | 283.6 | 475 |
| payments, PSP 0 ms (compensation, `VERIFY_HOLDS=0`) | 2 120 (2 116-2 124) | 69.2 | 75.9 | 2 151 |
| **payments-verify**, PSP 100 ms (check on, CONFIRMED) | 1 068 (1 064-1 076) | 132.0 | 137.1 | not measured before |
| **payments-verify**, PSP 0 ms (check on, CONFIRMED) | 2 672 (2 532-2 681) | 47.5 | 53.2 | not measured before |
| gateway, direct to inventory | 8 918 (8 918-9 036) | 7.8 | 10.3 | not measured on this machine |
| gateway, through the gateway | 6 927 (6 800-7 508) | 10.4 | 12.7 | not measured on this machine |

- **Inventory and waiting-room are 4% to 7% lower than on 2026-11-07**, in all five rows and in the same direction. Between the two runs the code gained request signing and verification on inventory (ADR 002) and a Redis command timeout in the waiting room; the A/B on the M1 measured signing at 3.6% on average, which is the same size. This run is not an A/B (different load, no unsigned control on this machine), so the difference is consistent with the signing cost and is not attributed to it. One run is an outlier: atomic-update low contention run 1 gave 7 164 RPS and p99 80.2 ms, while runs 2 and 3 gave 10 140 and 10 138. Its load before the run was 2.55, the lowest of all, and the cause was not found; the median ignores it.
- **Payments on the compensation path barely moved** (475 against 475, 2 120 against 2 151, minus 1.4%), although the code gained signed payments requests (PR #20) between the two runs; the pre-charge check is off in this scenario. Signing a request costs microseconds, and a payment here costs milliseconds, so this is the size expected.
- **payments-verify is a different piece of work, not a before-and-after pair.** The compensation path calls the PSP twice and refunds; the CONFIRMED path calls the PSP once and confirms the seats, and with the check on it first asks inventory (`POST /events/1/holds/verify`, signed). At PSP 100 ms the 100 VUs mostly wait for the PSP, and 1 068 against 475 RPS is the size that one PSP call instead of two would give; this is a reading, not a measurement of its own. The cost of the check itself is therefore **not isolated** by this data: that needs the same CONFIRMED path with `VERIFY_HOLDS=0` against `VERIFY_HOLDS=1`, which `scripts/bench.sh payments-verify` has run as separate rows since the run described here (it did not at the time); that measurement is in [the next section](#m4-pro-the-ownership-check-switched-on-and-off-and-a-second-ab-of-signing). What the data does show: with the check on and the seats held, the service sustains 2 672 RPS at p95 47.5 ms with a 0 ms PSP, so the check is not what limits it. After the last run (PSP 0 ms, run 3) the database held 44 559 payments, all CONFIRMED, and 44 559 sold seats, so the runs measured the path they claim to.
- **The gateway hop costs 22% of the throughput on the M4 Pro** (8 918 to 6 927 RPS, p95 7.8 to 10.4 ms), against 23% on the M1 Air (3 898 to 2 984). The relative cost is the same on a machine about 2.3 times faster; the absolute added latency is smaller (2.6 ms against 6 ms at p95).

| Notifications partitions | seconds | deliveries/s | sent / expected | duplicate rows | dead letters | provider calls |
|---|---|---|---|---|---|---|
| 1 | 82.4 (81.9-82.8) | 461 (459-464) | 38 000 / 38 000 | 0 | 10 | 38 180 |
| 3 | 26.8 (26.7-26.8) | 1 421 (1 420-1 421) | 38 000 / 38 000 | 0 | 10 | 38 180 |

The same as on the M1 Air within 2.4% (466 and 1 388 there), and 38 000 is 20 000 unique events times their channels (90% on two, 10% on one), which the table header's "20 000 unique events" does not say. The consumer is bound by the 20 ms provider call and the concurrency of 25, not by the machine.

**Catalog** (medians of 3): ilike 14 179 RPS, fts-date 15 711, fts ranked 2 611, fts ranked with the Redis cache 39 070, rare term with ilike 65 (p95 1 011 ms), rare term with fts-date 28 476. `fts ranked` run 3 had 30 failed requests of 35 923 (0.08%, no failed checks) and 2 070 RPS against about 2 610 in the other two runs; the k6 output has no error text, so the type of the failure is unknown. The machine load before that run was above 4.

Mean CPU (percent of one core, peak in brackets; the VM scale goes to 1 200). The VM holds Postgres, Redis and Redpanda.

| Scenario | VM | k6 | node |
|---|---|---|---|
| inventory (4 rows) | 320 to 444 mean, 435 to 1 068 peak | 84 to 104 (118 to 141) | 68 to 72 (92 to 98) |
| waiting-room | 127 (183) | 181 (239) | 79 (107) |
| payments PSP 100 / 0 ms | 91 (126) / 309 (464) | 7 (11) / 21 (35) | 38 (49) / 95 (124) |
| payments-verify PSP 100 / 0 ms | 175 (242) / 386 (502) | 13 (19) / 30 (40) | 60 (122) / 120 (161) |
| gateway direct / through the gateway | 586 (836) / 510 (733) | 59 (92) / 57 (80) | 54 (74) / 128 (183) |
| catalog (6 rows) | 110 to 879 mean, 168 to 1 181 peak | 2 to 209 | 3 to 79 |
| notifications 1 / 3 partitions | 64 (94) / 99 (140) | not k6 | 8 (14) / 13 (25) |

The machine was not saturated here either: k6 and node stayed below 300% in every scenario, the VM peaked at 1 181 of 1 200 only in `catalog rare term: ilike` (a sequential scan, k6 at 2% and node at 3% mean) and was above 1 000 in one inventory row. The node process of the payments service averages 95% of one core at a 0 ms PSP on the compensation path and 120% on the CONFIRMED path with the check, which is the one process that gets close to a core limit.

**End-to-end suite, one failure, not reproduced.** `pnpm test:e2e` failed `overload.e2e.test.ts > scenario 3` once on the M4 Pro with `TypeError: fetch failed`, `Caused by: Error: connect ECONNRESET 127.0.0.1:55776`; the 11 other tests passed and the run was not repeated there. The same test passed in 9 of 9 runs on the M1 Air afterwards. The error is a refused connect, not an HTTP answer, and the test fires 300 simultaneous connections at the gateway (plus a storm of 1 000 holds) on a system whose `kern.ipc.somaxconn` is 128; that is a hypothesis, not a finding, and the cause is open; the same OS limit is documented for the k6 flash sale, where 2 000 simultaneous new connections overflowed the accept queue ([gateway RESULTS](../services/gateway/RESULTS.md#flash-sale-end-to-end-loadflash-salejs)). The fault suite (`pnpm test:e2e:faults`, F1 to F14) ran green in 451 s on the same machine.

### A/B of inventory request signing on a second machine

`scripts/ab-signing.sh [runs]` repeats the unsigned, signed, unsigned-again comparison of the M1 section above on any machine: it builds the commit before ADR 002 (`b51732a`) and the one with it (`5875217`) in throwaway worktrees and runs `BENCH_CPU=1 scripts/bench.sh inventory` from each, in the order A, B, A2. The difference between A and A2 (same code) is the noise of the machine; a signing cost smaller than that cannot be claimed. The M4 Pro result is in [the next section](#m4-pro-the-ownership-check-switched-on-and-off-and-a-second-ab-of-signing).

## M4 Pro: the ownership check switched on and off, and a second A/B of signing

2026-11-08, 13:22 to 15:40 CET, commit `42d192d`, MacBook Pro M4 Pro on AC power, Docker Desktop (Apple Virtualization, 12 CPUs, 8.3 GB), `BENCH_CPU=1`, 5 runs per row. The machine was not quiet: the 1-minute load before most runs was 3.5 to 5.6 (7.0 and 7.2 at the start of the signed and the second unsigned side of the A/B), after the 10 to 60 s wait of `BENCH_MAX_LOAD`; the cause was not identified (a container of another project exited during the run, so the load was not that). No failed request or check in any of the 16 rows.

### The check on and off

Same work in both rows: seats held in SQL beforehand, every payment ends CONFIRMED with one PSP call; only the signed `POST /events/1/holds/verify` to inventory differs (`VERIFY_HOLDS=1` against `0`). The modes ran as two blocks (all "on" runs, then all "off" runs) at each PSP latency.

| Row | RPS median (min-max) | p95 ms median (min-max) | p99 ms |
|---|---|---|---|
| PSP 100 ms, check on | 1 060 (1 012-1 122) | 131.7 (110.3-136.7) | 138.3 |
| PSP 100 ms, check off | 845 (831-857) | 147.5 (146.3-150.3) | 155.5 |
| PSP 0 ms, check on | 2 664 (2 332-2 693) | 47.8 (46.5-56.6) | 53.0 |
| PSP 0 ms, check off | 3 012 (2 850-3 045) | 41.8 (41.7-46.7) | 46.1 |

Node mean CPU (percent of one core): 63 on and 42 off at 100 ms, 116 on and 93 off at 0 ms; k6 14 and 8, 29 and 32; the Docker VM 178 and 124, 377 and 383.

- **At PSP 0 ms the check costs 11.6% of the throughput** (3 012 to 2 664 RPS) and 6 ms at p95 (41.8 to 47.8), with RPS ranges that do not overlap (confirmed by the repeat below). Node uses about 25 points of a core more with the check on, in line with one more signed HTTP round trip per payment.
- **At PSP 100 ms the sign is the wrong way round**: "on" is 25% faster than "off" (1 060 against 845 RPS) with ranges that do not overlap. The code cannot explain that: with `VERIFY_HOLDS=0` the service only skips the call (`payments.service.ts`), so "off" does strictly less work. The "on" figure agrees with the earlier M4 Pro run (1 068); it is the "off" row that is low. The two modes ran in separate blocks, so a drift of the machine or the database between the blocks is a confound this run cannot remove. Candidates not tested: each run re-seeds 100 000 seats (a `DELETE` and an insert), so dead tuples accumulate across the session and autovacuum may lag; and the load of the machine. **The 100 ms row therefore says nothing about the cost of the check, and the 0 ms figure shares the same confound.** `bench.sh payments-verify` now alternates the modes run by run (on, off, on, off) and logs the end state of every run to `payments-verify-state.log`; the repeat with the modes alternating is in the next subsection.
- **Correctness**: the state was read for the last run only (PSP 0, check off): 50 633 payments, all CONFIRMED, 50 633 sold seats. The other three rows were not read; the changed script now records it for every run.

### A second A/B of inventory signing

`scripts/ab-signing.sh 5`: A is `b51732a` (unsigned), B is `5875217` (signed), A2 is `b51732a` again.

| Row | A RPS | B RPS | A2 RPS | A2 against A | B against the mean of A and A2 |
|---|---|---|---|---|---|
| atomic-update, low contention | 10 511 | 10 165 | 9 877 | -6.0% | -0.3% |
| atomic-update, hot (20 seats) | 12 033 | 11 573 | 11 523 | -4.2% | -1.7% |
| for-update, low contention | 10 425 | 9 790 | 10 442 | +0.2% | -6.2% |
| for-update, hot (20 seats) | 12 626 | 12 671 | 13 459 | +6.6% | -2.8% |

p95 ms (A, B, A2): 6.1, 6.4, 6.5; 5.0, 5.4, 5.4; 6.6, 7.0, 6.5; 5.0, 5.0, 4.5. Medians of 5 runs, load before the runs 3.6 to 5.6.

- **The throughput cost of signing cannot be told from the noise.** The two unsigned sides differ by 4% to 7% in three rows, in different directions (down in the atomic rows, up in for-update hot), which is the noise of the machine; the signed side sits 0.3% to 2.8% below the mean of the two in three rows, inside that spread. One row (for-update, low contention) has B 6.2% below while A and A2 agree within 0.2%, and its B range (8 759 to 9 894) does not overlap A2 (10 385 to 10 491); one row of four is not a result. The M1 A/B (3.6% on average) is neither confirmed nor refuted by this one.
- **The CPU is a more consistent signal than the throughput.** The signed side used more Node CPU in all four rows: mean 68, 71, 67 and 70 against 58 to 61 on the two unsigned sides (+12% to +20% of the node's CPU), and more k6 CPU in three of four (90, 96, 86, 103 against 82 to 97; k6 signs on its side). Throughput did not drop by that much, which is what a limit elsewhere would look like: the Docker VM held at 312 to 406% of a core, and nothing in this data shows the Node process at a core limit (peak 79 to 97). That is a reading, not a test: the CPU difference includes the HMAC (2.4 and 3.2 microseconds per request, measured on the M1) and the reading of the body into memory, which were not separated.

### The check on and off, repeated with the modes alternating

2026-11-08, 16:20 to 16:44 CET, commit `63b7619`, same machine, 7 runs per row, on and off alternating run by run. Load before the runs: 1.3 to 1.6 for the first two PSP 100 runs, then 2.8 to 4.7 (all 14 PSP 0 runs started after a 20 to 60 s wait at 3.5 to 4.7). 28 of 28 runs: every payment CONFIRMED and sold seats equal to payments (`payments-verify-state.log`).

| Row | RPS median (min-max) | p95 ms median (min-max) | p99 ms | Failed requests / checks |
|---|---|---|---|---|
| PSP 100 ms, check on | 1 064 (936-1 118) | 130.4 (116.5-135.2) | 136.6 | 0 / 0 |
| PSP 100 ms, check off | 847 (829-850) | 147.7 (146.6-150.2) | 151.6 | 0 / 0 |
| PSP 0 ms, check on | 2 712 (2 647-2 728) | 46.5 (46.2-50.5) | 52.4 | 0 / 0 |
| PSP 0 ms, check off | 3 067 (3 056-3 071) | 41.4 (41.2-41.8) | 45.0 | 0 / 1 |

The one failed check (a response other than 200 among 51 215 in PSP 0, check off, run 4) was not investigated; the same run had no failed request and a consistent end state.

Pair by pair (run r with the check on against run r with it off), off minus on as a share of off:

| | r=1 | r=2 | r=3 | r=4 | r=5 | r=6 | r=7 |
|---|---|---|---|---|---|---|---|
| PSP 0 ms | +13.7% | +11.3% | +11.8% | +11.5% | +11.1% | +11.5% | +11.7% |
| PSP 100 ms | -25.3% | -25.2% | -12.1% | -21.8% | -34.8% | -31.3% | -27.1% |

- **At a 0 ms PSP the ownership check costs 11% to 14% of the throughput** (median 11.5%, 3 067 to 2 712 RPS) and 5 ms at p95, with the same sign in all seven pairs, non-overlapping ranges and a narrow spread. The earlier two-block run gave 11.6%, so alternating the modes did not change the figure. With 100 VUs, the mean latency of an iteration is about VUs divided by RPS, 32.6 ms without and 36.9 ms with the check: about 4 ms more per payment, the cost of one more signed HTTP round trip plus its query under this load (Little's law, applied loosely: retries are counted in RPS). Node uses about 19 points of a core more (114 against 95); the VM is unchanged (385 against 390), so the extra work is on the Node side of the payments service and in inventory's own process, which was not sampled separately.
- **At a 100 ms PSP the sign is still inverted and the cause is open.** The check-on row is 25.7% faster than check-off in all seven pairs, so the earlier suspicion that the two-block order caused it is ruled out. The check-off row is flat (829 to 850), the check-on row varies (936 to 1 118). The code cannot explain it, since the check-off path does strictly less work. Whether the pool of 20 connections is the shared resource was tested afterwards: see [the pool size, tested](#the-pool-size-tested-the-100-ms-inversion-goes-away-at-40-and-100). It is not a measurement of the cost of the check, and the figure of this section for the cost is the 0 ms one: when the PSP is the dominant wait the check is hidden or even helped, and it is a visible cost only when the PSP is fast.
- **No downward trend by run order** in any row (the check-off rows are flat; check-on at 0 ms has a lower first run, 2 647, then 2 702 to 2 728). That does not support dead tuples from the re-seeding of 100 000 seats per run as the cause of the inversion; `n_dead_tup` itself was not measured.

### The pool size, tested: the 100 ms inversion goes away at 40 and 100

2026-11-08, commit `ea57fbd` (services unchanged since `63b7619`; the commits between touch documentation and `bench.sh`), same M4 Pro on mains power, `PAYMENTS_BENCH_POOL` 40 and 100 (payments pool, default 20), 5 runs per row, modes alternating. Load before the PSP 100 runs 1.5 to 4.0; before the PSP 0 runs up to 4.35, and three runs started above the wait threshold of 4 after the 60 s wait (pool 40 PSP 0 off r3, pool 100 PSP 0 r4 on and off). The pool 100 series started right after the pool 40 one (load 7.1 at start). 40 of 40 runs: every payment CONFIRMED, sold seats equal payments. 0 failed requests and checks at PSP 100.

| PSP 100 ms | Check | RPS median (min-max) | p95 ms median (min-max) |
|---|---|---|---|
| pool 20 (7 runs, `63b7619`) | on | 1 064 (936-1 118) | 130.4 (116.5-135.2) |
| pool 20 | off | 847 (829-850) | 147.7 (146.6-150.2) |
| pool 40 | on | 1 118 (1 116-1 122) | 111.2 (109.1-111.4) |
| pool 40 | off | 1 109 (1 082-1 122) | 117.1 (111.0-134.4) |
| pool 100 | on | 1 121 (1 120-1 123) | 109.8 (109.3-110.0) |
| pool 100 | off | 1 120 (1 109-1 126) | 110.8 (109.1-114.4) |

- **The inversion is gone.** Off minus on, as a share of off: -25.6% at pool 20, -0.8% at pool 40, -0.1% at pool 100. With a larger pool the check-off row rises from 847 to 1 109-1 120 and the check-on row stays at 1 118-1 121, so the two meet at the throughput the 100 ms PSP allows (about 100 VUs / 0.1 s). Pair by pair: on faster in 4 of 5 at pool 40 and in 3 of 5 at pool 100, with differences of 0.3% or less in all pairs but one (about 1%, r2) at pool 100, so no sign there. This agrees with the pool of 20 being the shared resource that check-off runs queue on; contention for connections was not measured directly (no pool wait counter), so it is consistent with the data, not proved.
- **A pool of 20 under a 100 ms PSP costs the no-check path about 24% of its throughput** (847 against 1 109 to 1 120). The default of 20 is what the earlier payments rows used; their 100 ms figures are limited by it. Not tested: pool sizes between 20 and 40.
- **At a 0 ms PSP the check looks dearer with a larger pool, and this is not explained.** Off minus on: 11.5% at pool 20 (`63b7619`), 18.2% at pool 40 (2 631 against 3 218 RPS, p95 52.3 against 40.8 ms), 21.3% at pool 100 (2 650 against 3 368, p95 52.9 against 41.4 ms), on slower in all 10 pairs at both pools. The pool 20 series was measured on another commit and at another load, so the comparison is conditional; the 11.5% stays the figure for the default pool, and with a larger pool the check-off path gets faster while the check-on one does not.
- **CPU at PSP 100** (peak/mean, % of one core): node 99/78 (pool 40, on), 87/59 (off), 108/77 (pool 100, on), 90/61 (off); k6 about 20 and the VM 226 to 253 peak, 167 to 187 mean. No process is bound to a core; node uses 17 to 19 points more on average with the check on.

**The e2e test that failed once, rerun.** On the M4 Pro `overload.e2e.test.ts > scenario 3` was run 5 times right after the benchmark (load 7.25): 4 passed, run 3 failed with one failed test, and its text was not saved (the `grep` caught neither `ECONN` nor `fetch failed`). Six further runs with logs all passed. So the failure reproduced once in 11 on the M4 and 0 in 9 on the M1, the error text of the second failure is unknown, and the `somaxconn` hypothesis stays untested. The load at the time of the failing run is a possible factor, not a finding.
