import { counter, gauge } from "@boxoffice/platform";
import type { Pool } from "pg";

/** Paid-request outcomes as seen by the caller of POST /payments. */
export const inProgress = counter("payments_in_progress_total", "POST /payments answered 202: the saga is not final yet and a retry with the same Idempotency-Key reads the result.");
/** status: CONFIRMED | REFUNDING | REFUNDED | FAILED | other. */
export const finalResults = counter("payments_final_total", "POST /payments answered with a final or terminal saga status.", ["status"]);
/** result: ok | error. */
export const sweeperRuns = counter("payments_sweeper_runs_total", "Sweeper iterations (resume sagas stuck in PENDING/CHARGED).", ["result"]);
export const sweeperResumed = counter("payments_sweeper_resumed_total", "Sagas the sweeper resumed without error.");
export const outboxPublished = counter("payments_outbox_published_total", "Outbox rows published to the broker.");
export const outboxRelayErrors = counter("payments_outbox_relay_errors_total", "Relay iterations that failed (broker unreachable, DB error).");

const STATES = ["PENDING", "CHARGED", "CONFIRMED", "REFUNDING", "REFUNDED", "FAILED"];
export const stateLabel = (s: string): string => (STATES.includes(s) ? s : "other");

/** Reads on a short cache so a scrape storm cannot turn into a query storm. */
function cached<T>(ttlMs: number, load: () => Promise<T>): () => Promise<T | undefined> {
  let at = 0, value: T | undefined, running: Promise<void> | undefined;
  return async () => {
    if (Date.now() - at >= ttlMs) {
      running ??= load().then((v) => { value = v; at = Date.now(); }, () => undefined).finally(() => { running = undefined; });
      await running;
    }
    return value;
  };
}

/** Backlog and age of the oldest unpublished outbox row: the end-to-end lag of "committed in Postgres, not yet on the broker". */
export function registerOutboxGauges(pool: Pick<Pool, "query">): void {
  const read = cached(1000, async () => (await pool.query(
    `SELECT count(*)::int AS n, COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::float AS age
     FROM payments.outbox WHERE published_at IS NULL`)).rows[0] as { n: number; age: number });
  gauge("payments_outbox_backlog", "Outbox rows not yet published.", [], async function () { const r = await read(); if (r) this.set(r.n); });
  gauge("payments_outbox_oldest_unpublished_age_seconds", "Age of the oldest unpublished outbox row (0 when the outbox is empty).", [], async function () { const r = await read(); if (r) this.set(r.age); });
}

/**
 * Sagas per state, read from Postgres at scrape time (cached 10 s). This is a GROUP BY over payments.payments (no index on
 * status), so it is a sequential scan: cheap in the lab, something to replace with counters or a partial index at scale.
 */
export function registerSagaGauge(pool: Pick<Pool, "query">): void {
  const read = cached(10_000, async () => (await pool.query("SELECT status, count(*)::int AS n FROM payments.payments GROUP BY status")).rows as { status: string; n: number }[]);
  gauge("payments_sagas", "Payments by saga state (PENDING and CHARGED that stay non-zero are stuck sagas).", ["state"], async function () {
    const rows = await read();
    if (!rows) return;
    const by = new Map<string, number>([...STATES, "other"].map((s) => [s, 0]));
    for (const r of rows) by.set(stateLabel(r.status), (by.get(stateLabel(r.status)) ?? 0) + r.n);
    for (const [s, n] of by) this.set({ state: s }, n);
  });
}
