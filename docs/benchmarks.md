# Benchmarks: repeated runs and a second environment

The `RESULTS.md` files of the services each report one run on one MacBook Air M1. A single run says nothing about run-to-run noise, and one machine says nothing about other hardware. This page addresses both as far as a local checkout allows: `scripts/bench.sh` repeats the existing k6 scenarios and reports the spread, and a manually dispatched workflow runs the same scenarios on a GitHub-hosted runner. It does not change any figure in a `RESULTS.md`.

## Method

`scripts/bench.sh <scenario> [runs=3]` with scenario `inventory`, `waiting-room`, `payments`, `catalog` or `all`:

- starts the built services itself (`node dist/main.js` from each package, the environment of the existing `load/run.sh` scripts: `SEED_SEATS=100000 PG_POOL=20` for inventory, `SEED_EVENTS=200000` for catalog, `PSP_LATENCY_MS` 100 and 0 for payments);
- waits for `/readyz` instead of sleeping, refuses to start when the port already answers, and kills everything it started on exit (`trap EXIT`);
- runs the unchanged k6 scripts (`load/hold.js`, `join.js`, `pay.js`, `search.js`) N times with `--summary-export` and prints one Markdown row per scenario row: median, min and max of RPS, p95 and p99, plus failed requests, failed checks and how many runs breached a k6 threshold;
- keeps runs independent: inventory gets a fresh process and a re-seeded table per run; waiting-room uses a flushed Redis logical database (`BENCH_REDIS_DB`, default 12) because user ids repeat between runs; payments truncates `payments.payments` and `payments.outbox` before each run because idempotency keys repeat (otherwise a second run would replay stored results); catalog flushes the cache database before each run. Payments also starts inventory, as the saved payments run did, so that the seat confirm fails and every payment takes the compensation path. Payments needs Redpanda (`docker compose up -d`);
- flushes and truncates through the container that publishes port 56379 or 55432 (works for compose and for CI service containers; override with `REDIS_CONTAINER` and `PG_CONTAINER`). If no Redis container is found the flush is skipped with a note on stderr;
- checks the 1-minute load average before every run, logs it to `load.log`, waits up to 60 s while it is above 4 (`BENCH_MAX_LOAD`, `BENCH_LOAD_WAIT`) and then goes ahead and says so;
- writes the raw k6 summaries (`*.json`, plus the k6 exit code), `table.md` and `load.log` to `BENCH_OUT` (default `./bench-out`, gitignored). `VUS` and `DURATION` pass through to k6 for shorter smoke runs.

```bash
docker compose up -d && pnpm build
scripts/bench.sh inventory 3
BENCH_OUT=/path/to/dir scripts/bench.sh all 5
```

### GitHub-hosted runner

`.github/workflows/bench.yml` is `workflow_dispatch` only. It starts the same Postgres 18 and Redis 7 service containers as CI (Redpanda by hand only for `payments` and `all`), installs k6 2.3.0 with `grafana/setup-k6-action@v1`, logs `lscpu`, `nproc`, `free -m`, kernel, Node, k6 and Postgres versions to the job summary, runs `scripts/bench.sh`, appends the tables to the job summary and uploads `bench-out` as an artifact (90 days).

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

## Three environments compared

| Row (median RPS) | M1 Air (3 runs, noisy) | GitHub runner (5 runs) | M4 Pro (5 runs) |
|---|---|---|---|
| inventory atomic, low | 1 711 | 1 711 | 10 796 |
| inventory for-update, low | 2 067 | 1 812 | 10 720 |
| inventory atomic, hot | 1 995 | 1 960 | 12 261 |
| inventory for-update, hot | 3 400 | 2 476 | 13 682 |
| waiting-room | 7 505 | 6 522 | 39 144 |

- **Levels are not portable.** The M4 Pro is about 6x the runner on inventory and about 6x on waiting-room, with the same code, the same compose settings and k6 on the same machine. That includes whatever Docker Desktop's VM and the host network path add, and the cause of the factor was not isolated here. A capacity budget derived on one machine says little about another: the README formula (hold RPS x 0.6 / 3) gives about 342 users/s from the runner median and about 2 160 from the M4 Pro median, against a configured 500.
- **The strategy comparison is consistent where the spread is small.** At low contention atomic-update and for-update are indistinguishable on the runner (-6%) and on the M4 Pro (+0.7%); on neither does the single conditional UPDATE show the ~18% advantage of the first version. At hot contention for-update is faster on both (+26% on the runner, +12% on the M4 Pro). The M1 laptop ranges overlap too much to support either direction.
- This is the argument for the playbook's position: quote ranges, treat absolute figures as per-environment, and choose between the strategies on correctness.
