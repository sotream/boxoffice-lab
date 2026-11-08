# Open items

What was not verified at 1.0.0, with the command that would close each item. Nothing here blocks use of the playbook; each item is also stated where it matters (README Limits, [docs/benchmarks.md](benchmarks.md)).

| Item | What would close it | Command (M4 Pro or similar) |
|---|---|---|
| `overload.e2e` scenario 3 failed 1 time in 11 on the M4 Pro (error text not saved); 0 in 9 on the M1. Hypothesis: `kern.ipc.somaxconn` is 128 and the test opens 300 connections at once. | Rerun with the log saved to a file at low load. If it reproduces with `ECONNRESET`, cap the 300-connection flood near 100 or document the OS limit in the test. | `for i in 1 2 3 4 5 6 7 8 9 10; do pnpm --filter @boxoffice/e2e exec vitest run src/overload.e2e.test.ts -t "scenario 3" > e2e-rerun-$i.log 2>&1; echo "$i $?"; done` |
| Pool sizes between 20 and 40 were not tried; the default of 20 limits the no-check path at a 100 ms PSP by about 24%. | Find the size where the 100 ms inversion disappears, then decide whether to change the default `PG_POOL` of payments. | `PAYMENTS_BENCH_POOL=30 BENCH_CPU=1 scripts/bench.sh payments-verify 5` (also 25, 35) |
| The ownership check costs 11.5% at a 0 ms PSP with pool 20 but 18 to 21% with pools 40 and 100; the pool 20 series was measured on another commit and at another load. | All three pools on one commit, load below 3, modes alternating. | `for p in 20 40 100; do PAYMENTS_BENCH_POOL=$p BENCH_OUT=$PWD/bench-out-pool$p scripts/bench.sh payments-verify 7; done` |
| Whether dead tuples from re-seeding 100 000 seats per run affect the rows: `n_dead_tup` was never measured. | Read `pg_stat_user_tables.n_dead_tup` for the seats table before and after each run (extend `pg_query` in `scripts/bench.sh`). | not scripted |
| One failed check (a non-200 among 51 215 responses) in the PSP 0 check-off run 4 of the alternating series. | Rerun and look at the response status in the k6 output. | not scripted |
| Connection contention for the payments pool is consistent with the data but not measured directly (no pool wait counter). | Export the pool's `waitingCount` as a metric and compare it at pool 20 and 40. | not scripted |
| No test for a silent partition between payments and Postgres, Redpanda or notifications; no TCP keepalive for idle connections. | Fault cases like F13 and F14 through the TCP proxy for these paths. | see [docs/e2e.md](e2e.md) |
| No mutation for the waiting-room `commandTimeout`: `app.module.ts` is forbidden for the runner. | Move the option into a file the runner may mutate, then add the mutation. | `node scripts/mutation-check.mjs --validate` |
