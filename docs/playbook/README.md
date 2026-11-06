# Playbook: workload-driven architecture decisions

The services in this repo prove individual patterns with measurements. This playbook is the layer above them: how to choose a pattern for a given shape of load, and at which number to move to the next one.

## Evidence labels

Every figure in the playbook is labelled, so you can see what to trust:

| Label | Meaning |
|---|---|
| `[measured]` | A figure from a `RESULTS.md` or a drill in this repo. Laptop, k6 on the same machine: a per-instance planning number, not a production claim. |
| `[derived]` | Computed on paper from stated assumptions with the formulas in `packages/capacity`. The arithmetic is shown. |
| `[folk]` | A widely quoted ballpark from general engineering knowledge. Not measured here. |
| `[paper design]` | A design with no code in this repo. Estimates are derived, nothing is measured. |
| `[public price, 2026-11-06]` | An official public list price (AWS Price List files, on-demand, eu-central-1, no free tier, no Savings Plans) with its SKU, unit and source in the Price sources table in [from-100-to-1m-users.md](from-100-to-1m-users.md#price-sources). Any total built from it is [derived] from these prices. |

A paper design is never presented as proven. If a number cannot be derived or measured, the document says what would have to be measured. List prices change; recompute with the date shown.

## Reading order

1. [workload-to-architecture.md](workload-to-architecture.md): workload shape, what breaks first, pattern, trigger number.
2. [scaling-ladder.md](scaling-ladder.md): the order of escalation and the number for each rung.
3. [data-store-selection.md](data-store-selection.md): stores by access pattern.
4. [consistency-and-contention.md](consistency-and-contention.md): locks, idempotency, saga, outbox, with the tests that prove them.
5. [reliability-patterns.md](reliability-patterns.md): timeouts, retries, backpressure, fail-open/closed.
6. [worked-scenarios/](worked-scenarios/): five paper designs with other load shapes (URL shortener, feed, ledger, event ingestion, file pipeline).
7. [from-100-to-1m-users.md](from-100-to-1m-users.md): what to build first, what to postpone, build versus buy.

Related: [numbers-to-know](../numbers-to-know.md), [failure drills](../failure-drills.md), [ADR index](../adr-index.md) (every decision with its status), [operations](../operations.md) (SLIs, alerts, runbooks), [testing and invariant proofs](../testing.md), [capacity CLI](../../packages/capacity).
