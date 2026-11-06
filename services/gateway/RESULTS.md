# gateway: measured results

Setup: MacBook Air M1, Node 26, gateway on plain Fastify 5 in front of inventory (NestJS 12 / Fastify 5), all services, Postgres and Redis on one machine, k6 on the same machine.

## Overhead of the hop (`load/overhead.js`, 50 VUs, 15 s, GET availability)
| Path | RPS | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|
| direct to inventory | 2 485 | 18.6 | 30.9 | 43.0 |
| through gateway (IP limiter + proxy) | 2 001 | 22.8 | 41.2 | 58.1 |

## Flash sale end to end (`load/flash-sale.js`)
2 000 users join, wait for admission (500/s), then each tries 3 random seats out of 5 000. Arrivals are spread over `ARRIVAL_SPREAD_S` seconds (default 3); 0 means all 2 000 dial in the same millisecond. Three saved runs (raw output in `docs/load-output/gateway.txt`):

| Arrival spread | Holds ok | Conflicts | Rate-limited | Admission timeouts | Failed requests | Held seats in Postgres |
|---|---|---|---|---|---|---|
| 3 s | 3 442 | 2 558 | 0 | 0 | 0 | 3 442 |
| 3 s | 3 486 | 2 514 | 0 | 0 | 0 | 3 486 |
| 0 s (instantaneous) | 3 408 | 2 304 | 0 | 96 | 96 | 3 408 |

- Spread runs: 6 000 attempts each (ok + conflicts), 0 failures. **Invariant: held seats in Postgres = successful holds in all three runs. No oversell**, including the run with failures.
- The 0 s run lost 96 users before they could join (96 x 3 attempts = 288 missing, 5 712 recorded attempts). Those are `dial: i/o timeout` errors in k6: the 2 000 simultaneous new connections overflow the accept queue. On macOS `kern.ipc.somaxconn` is 128 and caps that queue whatever the application asks for (the gateway also sets `backlog: 4096`, which on this machine does not lift the cap). The count varies between runs: 96 here, up to 944 in earlier runs of the instantaneous variant (those earlier runs were not saved). This is a load-generator and OS artefact of an unrealistic arrival pattern, not a gateway defect; the scenario therefore spreads arrivals over 3 s by default.
- Latency percentiles are not reported: 2 000 k6 VUs on the same laptop dominate the timings (generator-bound), so only correctness and counts are claimed here.
