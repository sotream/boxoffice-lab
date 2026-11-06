# gateway: measured results

Setup: MacBook Air M1, all services, Postgres and Redis on one machine, k6 on the same machine.

## Overhead of the hop (`load/overhead.js`, 50 VUs, 15 s, GET availability)
| Path | RPS | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|
| direct to inventory | 2 244 | 20.8 | 33.6 | 44.9 |
| through gateway (IP limiter + proxy) | 1 742 | 26.4 | 46.4 | 63.0 |

## Flash sale end to end (`load/flash-sale.js`)
2 000 users join, wait for admission (500/s), then each tries 3 random seats out of 5 000.
- Holds: 3 530 ok + 2 470 conflicts = 6 000 attempts, 0 rate-limited, 0 admission timeouts, 0 failed requests.
- **Invariant: held seats in Postgres = 3 530 = successful holds. No oversell.**
- Latency percentiles are not reported: 2 000 k6 VUs on the same laptop dominate the timings (generator-bound), so only correctness and counts are claimed here.
- First run had 289 connection resets at the 2 000-connection burst: listen backlog, fixed (see CAPACITY.md).
