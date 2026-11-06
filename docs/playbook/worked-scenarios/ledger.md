# Worked scenario: double-entry ledger (strict consistency)

[paper design] No code in this repo implements a ledger: every figure below is derived from stated assumptions with the formulas in [`packages/capacity`](../../../packages/capacity/src/index.ts), or borrowed from a measured component and cited. Nothing here was run.

Load shape: moderate rate, zero tolerance for wrong answers. The limit is correctness under retries and hot accounts, and the commit rate of one database, not raw throughput. Matching shape in the playbook: [workload-to-architecture.md](../workload-to-architecture.md) (strict consistency / contention). Related: [consistency-and-contention.md](../consistency-and-contention.md), [reliability-patterns.md](../reliability-patterns.md), [numbers-to-know.md](../../numbers-to-know.md).

Labels: [measured] lab figure with its source file, [derived] arithmetic shown, [folk] common ballpark not measured here, [paper design] a design with no code here.

## Requirements

Functional
- Post a transaction made of two or more entries (debit and credit lines); the sum of debits equals the sum of credits.
- Posting is idempotent by a client-supplied key.
- Entries are never updated or deleted; a mistake is corrected by a reversing transaction.
- Read the balance of an account at a point in time; list entries for an account.
- Customer accounts must never go below zero (no overdraft); system accounts (fees, settlement) may.
- Reconcile against an external statement.

Non-functional (assumptions)
- 5M transactions per day, 2 entries each (10M entries per day), peak factor 10.
- Posting p99 under 100 ms, durable before acknowledging (synchronous commit).
- Retention 7 years (a placeholder for a regulatory number the reader must replace). Average entry row 150 B with indexes.
- Zero lost or duplicated postings; the sum over all entries is exactly zero at every moment.

## Estimates

| Quantity | Formula and arithmetic | Result |
|---|---|---|
| Transactions per second | `traffic --dau 5M --actions 1 --peak 10`: 5 000 000 / 86 400 = 57.9 avg; x 10 | 57.9 avg, 578.7 peak [derived] |
| Entry rows per second at k entries per transaction | 578.7 x k | k=2: 1 157; k=4: 2 315; k=10: 5 787 rows/s [derived] |
| Commits per second | one commit per posting transaction, independent of k | 578.7 at peak [derived] |
| Commit ceiling of one primary (lab lower bound) | payments run at 697 RPS with 3 commits per payment, Postgres CPU-bound: 697 x 3 | 2 091 commits/s [derived from one measured run, [payments RESULTS.md](../../../services/payments/RESULTS.md)]; a lower bound because the same Postgres also did the other work of the saga, on a laptop |
| Headroom check | 578.7 / (2 091 x 0.6) = 578.7 / 1 255 | 0.46 of the budget, so one primary is enough at x1 [derived] |
| Single hot row | a row updated by every transaction is serialised: max rate = 1 / lock hold time; with 2 ms (commit time, an assumption to measure) | 500 tx/s, below the 578.7 peak [derived] |
| Entries storage, k=2 | `storage --records-per-day 10M --bytes 150 --years 7 --replication 1` | 3.8 TB per replica; 11.5 TB with the default replication 3 [derived] |
| Entries storage, k=4 / k=10 | 20M / 50M rows per day x 150 B x 365 x 7 | 7.7 TB / 19.2 TB per replica [derived] |
| Reconciliation scan, one day | 10M rows x 150 B = 1.5 GB; sequential read ~1 ms per MB ([folk], [numbers-to-know.md](../../numbers-to-know.md) section a) | ~1.5 s of I/O per daily partition [derived] |

## Design

Components: ledger service (the only writer), one Postgres primary with a synchronous replica, an outbox relay publishing posted transactions (pattern as [payments adr/002](../../../services/payments/adr/001-saga-over-2pc.md)), a reconciliation job, read replicas for statements.

Data model
- `accounts(id, kind, currency, allow_negative)`.
- `transactions(id, idempotency_key unique, posted_at, metadata)`.
- `entries(id, transaction_id, account_id, amount bigint, direction, seq)` where `amount` is an integer in minor units. Partitioned by month; the only privilege the application role has on it is `INSERT` and `SELECT`.
- `balances(account_id, balance, last_seq)` for accounts with a no-overdraft rule only; it is a cache of the entries, rebuildable from them.

Key decisions

1. Append-only entries, corrections by reversal. Rejected: editing rows, which destroys the audit trail and makes reconciliation unfalsifiable. Enforced by removing `UPDATE`/`DELETE` privileges and a trigger that rejects them, not by convention.
2. Double-entry invariant checked in the database. A deferred constraint trigger asserts, at commit, that the entries of each transaction sum to zero per currency. Rejected: checking only in the application, because a second writer or a manual fix would bypass it.
3. Idempotent postings. `INSERT ... ON CONFLICT DO NOTHING` on the unique `idempotency_key`; a retry reads the stored result. This is the same mechanism as [payments adr/003](../../../services/payments/adr/001-saga-over-2pc.md), where 50 concurrent identical requests produce one insert, and [payments RESULTS.md](../../../services/payments/RESULTS.md) records 0 duplicate idempotency keys over a run with every 5th request retried ([measured]).
4. Balances as derived data. Truth is the entries; a balance is `sum(entries)`.
   - System and hot accounts get no balance row in the posting transaction: there is nothing to serialise on, so the 500 tx/s hot-row ceiling above does not apply; the balance is computed by a projection that batches entries (single writer per account, eventually consistent, seconds behind).
   - Customer accounts with a no-overdraft rule keep a `balances` row updated in the same transaction with a conditional update (`UPDATE ... SET balance = balance - $x WHERE balance >= $x`), the same one-statement conditional write the lab chose for seats ([inventory adr/001](../../../services/inventory/adr/001-hold-strategy.md)). Per-account rates are low, so the row is not hot. Account ids are locked in sorted order so two postings over the same accounts cannot deadlock (also from that ADR).
   - Rejected: updating one balance row for every account on every posting, because the fee account then caps the whole ledger at 1 / hold time.
5. Entries per transaction is a design lever.
   - More entries in one transaction (fees, tax, splits as separate lines) cost rows, not commits: k from 2 to 10 multiplies rows per second by 5 (1 157 to 5 787) but leaves commits at 578.7 per second, and one commit is what the primary is short of. Storage multiplies by 5 as well (3.8 to 19.2 TB).
   - Fewer, wider transactions lock more accounts at once and raise deadlock and contention risk; keep k small for customer-facing postings and net many small movements into one settlement posting (batch netting) where the business allows.
   - Rejected: one transaction per entry. It breaks atomicity (a half-posted transfer) and multiplies commits by k.
6. No distributed transaction across ledgers. Shard by ledger (tenant or currency) so a posting never spans shards; a cross-ledger transfer is two postings linked by a saga ([payments adr/001](../../../services/payments/adr/001-saga-over-2pc.md): saga, not 2PC) with a clearing account between them.
7. Reconciliation is a first-class job. Daily: (a) sum of all entries equals zero; (b) per-account recomputed balance equals the cached balance; (c) ledger totals match the external statement. Differences open an incident, they are never auto-corrected.

## What breaks at x10

x10 means 50M transactions per day: `traffic --dau 50M --actions 1 --peak 10` = 578.7 avg and 5 787 peak tx/s [derived].

1. First bottleneck: commits per second on one primary.
   - 5 787 commits/s exceeds the 2 091 lower bound above, and the 1 255 budget at headroom 0.6, at about x2.2 (1 255 / 578.7). The lab figure is from a laptop and must be re-measured, so the multiple moves, but the mechanism is fixed: durable commits.
   - Changes in order of cost: (a) group commit tuning (`commit_delay`) and batching several postings per transaction where the caller sends batches; (b) faster storage and `synchronous_commit` only on the replica set, never off for postings; (c) shard by ledger: `shards --peak-writes 5787 --per-shard 2091` = ceil(5 787 / (2 091 x 0.6)) = ceil(4.6) = 5 shards [derived from the lower bound].
2. Second bottleneck: balance reads on large accounts. A read of `sum(entries)` for an account with 50M entries a day scans far too much; a snapshot per account (balance and last seq, written by the projection hourly) reduces it to the entries since the snapshot. At 578.7 entries/s on one account that is 2.1M rows per hour [derived: 578.7 x 3 600]; snapshot more often or keep the running balance in the projection.
3. Third: storage and vacuum. 3.8 TB at x1 becomes 38 TB per replica at x10 [derived: 10 x 3.8]; monthly partitions, detach and archive partitions older than the online window to cheaper storage, keep sums per closed partition so balances stay cheap.

## What would be measured first

1. Commit rate of one Postgres for a posting transaction: a k6 script `load/post.js` that posts 2-entry transactions with idempotency keys, 100 VUs, pool 20. Copy [services/payments/load/pay.js](../../../services/payments/load/pay.js) (it already sends every 5th request again with the same idempotency key; duplicates are checked afterwards with a query, as recorded in its RESULTS.md) and [services/inventory/load/hold.js](../../../services/inventory/load/hold.js) (contention parameter). Run with k = 2, 4, 10 to confirm that commits, not rows, are the limit.
2. Hot account: a variant where every posting touches one fee account, once with an updated balance row and once append-only. This measures the 500 tx/s serialisation estimate directly.
3. Invariant check after each run: sum of all entries equals zero, duplicate idempotency keys equal zero, recomputed balances equal cached balances (the same "integrity after the run" section style as [payments RESULTS.md](../../../services/payments/RESULTS.md)).
4. Crash test: kill the service mid-run, restart, re-send the same keys; expect no duplicates and no half-posted transactions (copy [drills/consumer-kill.mjs](../../../drills/consumer-kill.mjs)).

## Where this is proven in the repo / what is still paper

Proven (other components): idempotency key as a unique column and 0 duplicates under retries, 3 commits per payment with Postgres as the limit ([payments RESULTS.md](../../../services/payments/RESULTS.md)); conditional single-statement write with sorted locking ([inventory adr/001](../../../services/inventory/adr/001-hold-strategy.md)); outbox ([failure-drills.md](../../failure-drills.md) drill 2).

Still paper: the ledger schema, the deferred sum-to-zero constraint, the projection, snapshots, reconciliation, the 2 ms hold time, and every x10 figure. The 2 091 commits/s figure is derived from one laptop run and is a floor, not a capacity.
