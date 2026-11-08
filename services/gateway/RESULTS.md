# gateway: measured results

*Measurement status: these figures were measured before `@boxoffice/platform` (metrics, JSON logging, trace context) existed, and the hop was repeated on the final code on 2026-11-08 (M1 Air and M4 Pro, 5 000 seats): see [benchmarks](../../docs/benchmarks.md#gateway-hop) and the M4 Pro section there; the flash-sale run below was not repeated. The inventory behind the gateway ran on PostgreSQL 17 at that time. Overhead of the instrumentation alone: [operations.md](../../docs/operations.md#overhead).*

Setup: MacBook Air M1, Node 26, gateway on plain Fastify 5 in front of inventory (NestJS 12 / Fastify 5), all services, Postgres and Redis on one machine, k6 on the same machine.

## Overhead of the hop (`load/overhead.js`, 50 VUs, 15 s, GET availability)
These figures predate the final code (signed requests to inventory, `@boxoffice/platform`); `scripts/bench.sh gateway` now reproduces both rows with repeated runs ([benchmarks.md](../../docs/benchmarks.md#method)).

| Path | RPS | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|
| direct to inventory | 2 485 | 18.6 | 30.9 | 43.0 |
| through gateway (IP limiter + proxy) | 2 001 | 22.8 | 41.2 | 58.1 |

### Re-measured on the final code (2026-11-08, M1 Air, PostgreSQL 18, 5 000 seats, 3 runs, a noisier machine)
| Path | RPS median (min-max) | p95 ms | p99 ms |
|---|---|---|---|
| direct to inventory | 3 898 (1 955-3 953) | 21.4 | 31.6 |
| through gateway (IP limiter + proxy) | 2 984 (2 866-3 039) | 27.5 | 41.4 |

The hop costs about 23% of the throughput and about 6 ms at p95 (19% in the table above). Inventory now requires a signed request, so the direct row includes k6 signing and inventory verifying it, and the gateway row includes the gateway signing its forwarded request. Details, the seat count and the load during the runs: [benchmarks](../../docs/benchmarks.md#final-code-on-the-m1-air-request-signing-the-ownership-check-gateway-and-notifications). The flash-sale numbers below were not repeated.

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
