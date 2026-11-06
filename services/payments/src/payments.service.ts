import { traceFields } from "@boxoffice/platform";
import { Pool } from "pg";
import { Psp } from "./psp";

/** A downstream step did not answer in time. The outcome is UNKNOWN, so the saga must not compensate: it is retried later. */
export class StepTimeout extends Error {}

export type ConfirmSeats = (eventId: number, seatIds: number[], userId: string) => Promise<boolean>;
export interface PaymentRequest { idempotencyKey: string; eventId: number; userId: string; seatIds: number[]; amountCents: number }
export type PaymentView = { id: number; status: string };
interface PaymentRow { id: number; idempotency_key: string; event_id: number; user_id: string; seat_ids: number[]; amount_cents: number; status: string; trace?: { requestId: string; traceparent: string } | null }
/** Named step boundaries at which a fault can be injected (tests only; production passes no hook). */
export type FaultPoint =
  | "before-charge" | "after-charge"
  | "before-confirm" | "after-confirm"
  | "before-refund" | "after-refund"
  | "before-transition" | "after-transition";
export const FAULT_POINTS: readonly FaultPoint[] = [
  "before-charge", "after-charge", "before-confirm", "after-confirm",
  "before-refund", "after-refund", "before-transition", "after-transition",
];
/** Called at each boundary; throw to simulate a crash there. `from`/`to` are set for the transition points. */
export type FaultHook = (point: FaultPoint, info: { id: number; from?: string; to?: string }) => void | Promise<void>;
export type Outcome = { kind: "done"; payment: PaymentView } | { kind: "in-progress"; payment: PaymentView };

/**
 * Orchestrated saga: PENDING -> (charge) CHARGED -> (confirm seats) CONFIRMED,
 * or, when the hold expired, CHARGED -> REFUNDING -> (refund) REFUNDED.
 * REFUNDING is a claim taken BEFORE the irreversible refund call (ADR 005): only the runner that wins
 * the CHARGED -> REFUNDING compare-and-set may refund, so a racing runner that stored CONFIRMED
 * can never be followed by a refund of the same money.
 * Every state change and its event are one DB transaction (outbox), so a crash never leaves
 * "state changed but event lost". `resume` continues from the stored state after a crash.
 * The PSP is called with the idempotency key, so a retry after a crash cannot charge twice.
 */
export class PaymentsService {
  constructor(
    private readonly pool: Pool,
    private readonly psp: Psp,
    private readonly confirmSeats: ConfirmSeats,
    private readonly stepTimeoutMs = 2000,
    /** Optional fault-injection callback (tests only). */
    private readonly faults?: FaultHook,
  ) {}

  private async fault(point: FaultPoint, id: number, from?: string, to?: string): Promise<void> {
    if (this.faults) await this.faults(point, { id, from, to });
  }

  private async within<T>(p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new StepTimeout("step timed out")), this.stepTimeoutMs); })]);
    } finally { clearTimeout(timer); }
  }

  async pay(req: PaymentRequest): Promise<Outcome> {
    const ins = await this.pool.query(
      `INSERT INTO payments.payments (idempotency_key, event_id, user_id, seat_ids, amount_cents, trace)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id, status`,
      [req.idempotencyKey, req.eventId, req.userId, req.seatIds, req.amountCents, JSON.stringify(traceFields() ?? null)]
    );
    if (ins.rowCount === 0) {
      // Same key seen before: return the stored result, never charge again.
      const existing = (await this.pool.query("SELECT id, status FROM payments.payments WHERE idempotency_key=$1", [req.idempotencyKey])).rows[0];
      return this.isFinal(existing.status) ? { kind: "done", payment: existing } : { kind: "in-progress", payment: existing };
    }
    return this.runBounded(ins.rows[0].id);
  }

  /** Run the saga, but answer the caller within the step timeout: a timed-out step leaves the saga resumable and reports in-progress. */
  private async runBounded(id: number): Promise<Outcome> {
    try { return { kind: "done", payment: await this.run(id) }; }
    catch (e) {
      if (!(e instanceof StepTimeout)) throw e;
      const cur = (await this.pool.query("SELECT id, status FROM payments.payments WHERE id=$1", [id])).rows[0];
      return { kind: "in-progress", payment: cur };
    }
  }

  /** Background sweeper: resume sagas stuck in PENDING/CHARGED/REFUNDING (timeout, crash). Safe to run on many instances: transitions are compare-and-set and the PSP is idempotent. */
  async sweep(olderThanSeconds = 3, limit = 200, parallel = 10): Promise<number> {
    const ids = (await this.pool.query(
      `SELECT id FROM payments.payments WHERE status IN ('PENDING','CHARGED','REFUNDING') AND updated_at < now() - make_interval(secs => $1) ORDER BY id LIMIT $2`,
      [olderThanSeconds, limit])).rows.map((r) => r.id as number);
    let done = 0;
    for (let i = 0; i < ids.length; i += parallel) {
      const rs = await Promise.allSettled(ids.slice(i, i + parallel).map((id) => this.run(id))); // a timeout again is retried by the next sweep
      done += rs.filter((r) => r.status === "fulfilled").length;
    }
    return done;
  }

  /** Continue the saga from whatever state is stored. Safe to call repeatedly. */
  async resume(id: number): Promise<PaymentView> {
    return this.run(id);
  }

  /** REFUNDING is deliberately NOT final: the refund may still be in flight, callers see in-progress (202). */
  private isFinal(s: string) { return s === "CONFIRMED" || s === "REFUNDED" || s === "FAILED"; }

  private async run(id: number): Promise<PaymentView> {
    let p: PaymentRow = (await this.pool.query("SELECT * FROM payments.payments WHERE id=$1", [id])).rows[0];

    if (p.status === "PENDING") {
      await this.fault("before-charge", id);
      const c = await this.within(this.psp.charge(p.idempotency_key, p.amount_cents));
      await this.fault("after-charge", id);
      if (!c.ok) return this.transition(id, "PENDING", "FAILED", "payment.failed", p);
      const moved = await this.transition(id, "PENDING", "CHARGED", null, p);
      if (moved.status !== "CHARGED") return moved; // another runner got there first: do not continue on a stale view
      p = { ...p, status: "CHARGED" };
    }

    if (p.status === "CHARGED") {
      await this.fault("before-confirm", id);
      // Why confirm needs no REFUNDING-style claim: confirmSeats is idempotent in inventory (already sold to
      // this user counts as success) and its effect is not money. Two runners that both confirm leave the seats
      // sold once; the CAS to CONFIRMED lets one write the event and the loser just reports the stored state.
      // A lost CAS after confirm therefore never undoes or contradicts anything. Refund is different: it is an
      // irreversible external effect that contradicts CONFIRMED, so it must be claimed first.
      const ok = await this.within(this.confirmSeats(p.event_id, p.seat_ids, p.user_id));
      await this.fault("after-confirm", id);
      if (ok) return this.transition(id, "CHARGED", "CONFIRMED", "payment.confirmed", p);
      // Compensation: claim the refund BEFORE the irreversible call. Losing this CAS means another runner
      // already decided (CONFIRMED or REFUNDING); we must not touch the money.
      const claimed = await this.transition(id, "CHARGED", "REFUNDING", null, p);
      if (claimed.status !== "REFUNDING") return claimed;
      p = { ...p, status: "REFUNDING" };
    }

    if (p.status === "REFUNDING") {
      await this.fault("before-refund", id);
      // Idempotent lookup of the existing charge id. Never mark REFUNDED without a real refund: fail loudly, the sweeper retries.
      const c = await this.within(this.psp.charge(p.idempotency_key, p.amount_cents));
      if (!c.ok || !c.chargeId) throw new Error(`cannot refund payment ${id}: charge not found at the provider`);
      await this.within(this.psp.refund(c.chargeId, `refund:${p.idempotency_key}`)); // keyed: any retry or concurrent resumer is a no-op
      await this.fault("after-refund", id);
      return this.transition(id, "REFUNDING", "REFUNDED", "payment.refunded", p);
    }

    return { id, status: p.status };
  }

  /** Compare-and-set state change plus outbox row in a single transaction. If the compare-and-set is lost, returns the stored state. */
  private async transition(id: number, from: string, to: string, event: string | null, p: PaymentRow): Promise<PaymentView> {
    let won = false;
    await this.fault("before-transition", id, from, to);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query("UPDATE payments.payments SET status=$3, updated_at=now() WHERE id=$1 AND status=$2", [id, from, to]);
      won = r.rowCount === 1;
      if (won && event) {
        await client.query(
          "INSERT INTO payments.outbox (topic, key, payload) VALUES ('payments', $1, $2)",
          [String(id), JSON.stringify({ eventType: event, paymentId: id, userId: p.user_id, eventId: p.event_id, seatIds: p.seat_ids, amountCents: p.amount_cents, ...(p.trace ? { trace: p.trace } : {}) })]
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release(); // released before any further query: never wait for a second connection while holding one
    }
    await this.fault("after-transition", id, from, to);
    if (won) return { id, status: to };
    const cur = (await this.pool.query("SELECT status FROM payments.payments WHERE id=$1", [id])).rows[0];
    return { id, status: cur.status };
  }
}
