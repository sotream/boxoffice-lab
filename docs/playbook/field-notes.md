# Field notes

Real production cases, reduced to numbers and decisions. No company names, no internal identifiers, no code or screenshots from an employer.

**Status: not verified.** The entries below are placeholders taken from a planning note. Each one must be confirmed, corrected and completed by the owner before this file is relied on or published; an unconfirmed entry must not be quoted as fact.

## Template

- **Situation**: the workload in numbers (volume, peak, latency budget).
- **Symptom**: what was slow, expensive or failing, with the measured figure.
- **Decision**: what was changed and what was rejected, and why.
- **Result**: the figure after the change and how it was measured.
- **Why it generalises**: the workload shape from [workload-to-architecture.md](workload-to-architecture.md) it belongs to.

## Entries (to be confirmed by the owner)

### 1. Ledger writes per order  [unverified]
Placeholder: ledger entries per order reduced from 10-15 to 2-4. Missing: what an order and an entry were, the volume, what caused the many entries, what was merged or dropped, how correctness (balances, reconciliation) was kept, the measured effect on latency or cost. Related shape: strict consistency, see [worked-scenarios/ledger.md](worked-scenarios/ledger.md).

### 2. Document OCR latency  [unverified]
Placeholder: OCR processing time reduced from about 30 s to 10-15 s. Missing: document size and type, where the time went (queueing, rendering, recognition, I/O), what was changed (parallelism, batching, model, resolution), the measured distribution (p50/p95), the cost effect. Related shape: long-running jobs, see [worked-scenarios/file-pipeline.md](worked-scenarios/file-pipeline.md).
