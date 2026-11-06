import { Pool } from "pg";
import { Psp } from "./psp";

/** A downstream step did not answer in time. The outcome is UNKNOWN, so the saga must not compensate: it is retried later. */
export class StepTimeout extends Error {}

export type ConfirmSeats = (eventId: number, seatIds: number[], userId: string) => Promise<boolean>;
export interface PaymentRequest { idempotencyKey: string; eventId: number; userId: string; seatIds: number[]; amountCents: number }
export type PaymentView = { id: number; status: string };
export type Outcome = { kind: "done"; payment: PaymentView } | { kind: "in-progress"; payment: PaymentView };

/**
 * Orchestrated saga: PENDING -> (charge) CHARGED -> (confirm seats) CONFIRMED,
 * or, when the hold expired, CHARGED -> (compensate) REFUNDED.
 * Every state change and its event are one DB transaction (outbox), so a crash never leaves
 * "state changed but event lost". `resume` continues from the stored state after a crash.
 * The PSP is called with the idempotency key, so a retry after a crash cannot charge twice.
 */
export class PaymentsService {
  /** Test hook: throw to simulate a crash at a named step. */
  crashAt?: "after-charge" | "after-confirm";

  constructor(private readonly pool: Pool, private readonly psp: Psp, private readonly confirmSeats: ConfirmSeats, private readonly stepTimeoutMs = 2000) {}

  private async within<T>(p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new StepTimeout("step timed out")), this.stepTimeoutMs); })]);
    } finally { clearTimeout(timer); }
  }

  async pay(req: PaymentRequest): Promise<Outcome> {
    const ins = await this.pool.query(
      `INSERT INTO payments.payments (idempotency_key, event_id, user_id, seat_ids, amount_cents)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id, status`,
      [req.idempotencyKey, req.eventId, req.userId, req.seatIds, req.amountCents]
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

  /** Background sweeper: resume sagas stuck in PENDING/CHARGED (timeout, crash). Safe to run on many instances: transitions are compare-and-set and the PSP is idempotent. */
  async sweep(olderThanSeconds = 3, limit = 200, parallel = 10): Promise<number> {
    const ids = (await this.pool.query(
      `SELECT id FROM payments.payments WHERE status IN ('PENDING','CHARGED') AND updated_at < now() - make_interval(secs => $1) ORDER BY id LIMIT $2`,
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

  private isFinal(s: string) { return s === "CONFIRMED" || s === "REFUNDED" || s === "FAILED"; }

  private async run(id: number): Promise<PaymentView> {
    let p = (await this.pool.query("SELECT * FROM payments.payments WHERE id=$1", [id])).rows[0];

    if (p.status === "PENDING") {
      const c = await this.within(this.psp.charge(p.idempotency_key, p.amount_cents));
      if (!c.ok) return this.transition(id, "PENDING", "FAILED", "payment.failed", p);
      await this.transition(id, "PENDING", "CHARGED", null, p);
      if (this.crashAt === "after-charge") throw new Error("crash after charge");
      p = { ...p, status: "CHARGED" };
    }

    if (p.status === "CHARGED") {
      const ok = await this.within(this.confirmSeats(p.event_id, p.seat_ids, p.user_id));
      if (this.crashAt === "after-confirm") throw new Error("crash after confirm");
      if (ok) return this.transition(id, "CHARGED", "CONFIRMED", "payment.confirmed", p);
      // Compensation: hold expired or was lost, give the money back.
      const c = await this.within(this.psp.charge(p.idempotency_key, p.amount_cents)); // idempotent: returns the existing charge id
      if (c.chargeId) await this.psp.refund(c.chargeId);
      return this.transition(id, "CHARGED", "REFUNDED", "payment.refunded", p);
    }

    return { id, status: p.status };
  }

  /** Compare-and-set state change plus outbox row in a single transaction. */
  private async transition(id: number, from: string, to: string, event: string | null, p: any): Promise<PaymentView> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query("UPDATE payments.payments SET status=$3, updated_at=now() WHERE id=$1 AND status=$2", [id, from, to]);
      if (r.rowCount === 1 && event) {
        await client.query(
          "INSERT INTO payments.outbox (topic, key, payload) VALUES ('payments', $1, $2)",
          [String(id), JSON.stringify({ eventType: event, paymentId: id, userId: p.user_id, eventId: p.event_id, seatIds: p.seat_ids, amountCents: p.amount_cents })]
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    return { id, status: to };
  }
}
