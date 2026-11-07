import fc from "fast-check";
import { describe, it, expect } from "vitest";
import type { Pool } from "pg";
import { FAULT_POINTS, FaultPoint, PaymentsService, StepTimeout, scopedKey } from "./payments.service";
import { FakePsp, Psp } from "./psp";

type ConfirmAnswer = "yes" | "no" | "timeout";
type Runner = { kind: "pay" | "resume" | "sweep"; delayMs: number };
interface PaymentPlan {
  amountCents: number;
  declined: boolean;                                   // provider declines the charge (money never moves)
  psp: { latencyMs: number; failures: { mode: "before" | "after"; count: number } }; // transient provider errors (before or after the effect)
  confirm: ConfirmAnswer[];                            // answer of the n-th confirmSeats call; "yes" afterwards
  crashes: { point: FaultPoint; nth: number }[];       // crash at the nth time this payment reaches the boundary
  runners: Runner[];                                   // 1..4 concurrent runners; the first is always pay()
}

const planArb: fc.Arbitrary<PaymentPlan> = fc.record({
  amountCents: fc.integer({ min: 1, max: 100_000 }),
  declined: fc.integer({ min: 0, max: 5 }).map((n) => n === 0),
  psp: fc.record({
    latencyMs: fc.constantFrom(0, 0, 5, 20, 70), // 70 ms exceeds the 40 ms step timeout: a real timeout whose effect still lands
    failures: fc.record({ mode: fc.constantFrom<"before" | "after">("before", "after"), count: fc.integer({ min: 0, max: 2 }) }),
  }),
  confirm: fc.array(fc.constantFrom<ConfirmAnswer>("yes", "no", "timeout"), { maxLength: 4 }),
  crashes: fc.array(fc.record({ point: fc.constantFrom(...FAULT_POINTS), nth: fc.integer({ min: 1, max: 3 }) }), { maxLength: 3 }),
  runners: fc.array(fc.record({ kind: fc.constantFrom<Runner["kind"]>("pay", "resume", "sweep"), delayMs: fc.integer({ min: 0, max: 25 }) }), { minLength: 0, maxLength: 3 })
    .map((rest) => [{ kind: "pay" as const, delayMs: 0 }, ...rest]),
});

const scenarioArb = fc.array(planArb, { minLength: 1, maxLength: 4 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wraps FakePsp with scripted latency and transient failures, tracking in-flight calls so a run can wait for stragglers. */
class ScriptedPsp implements Psp {
  inflight = 0;
  private readonly failuresLeft = new Map<number, number>();
  private readonly calls = new Map<number, number>();
  constructor(readonly inner: FakePsp, private readonly plans: PaymentPlan[]) {}
  private idxOf(key: string) { return Number(/(\d+)$/.exec(key)![1]); }
  private async call<T>(key: string, op: () => Promise<T>): Promise<T> {
    const i = this.idxOf(key); const pl = this.plans[i];
    this.inflight++;
    try {
      // Slow only for the first two calls per payment: a provider that is permanently slower than the step timeout
      // can never complete a saga (ADR 004: the timeout must be set from the provider's p99), so that is out of model.
      const n = this.calls.get(i) ?? 0; this.calls.set(i, n + 1);
      await sleep(n < 2 ? pl.psp.latencyMs : 0);
      const left = this.failuresLeft.get(i) ?? pl.psp.failures.count;
      const fail = left > 0;
      if (fail) this.failuresLeft.set(i, left - 1);
      if (fail && pl.psp.failures.mode === "before") throw new Error("psp transient failure (before effect)");
      const r = await op();
      if (fail) throw new Error("psp transient failure (after effect)"); // the effect landed but the caller never heard: retry must be safe
      return r;
    } finally { this.inflight--; }
  }
  charge(key: string, amount: number) {
    return this.call(key, async () => this.plans[this.idxOf(key)].declined ? { ok: false } : this.inner.charge(key, amount));
  }
  refund(chargeId: string, key: string) {
    return this.call(key.replace(/^refund:/, ""), () => this.inner.refund(chargeId, key));
  }
}

const TERMINAL = ["CONFIRMED", "REFUNDED", "FAILED"];

export function registerPropertyTests(pool: Pool, numRuns = Number(process.env.SAGA_RUNS ?? 40)): void {
  describe("model-based: random crashes, outcomes, latencies and concurrent runners", () => {
    it(
      "invariants hold once the sweeper has run enough times",
      async () => {
        await fc.assert(
          fc.asyncProperty(scenarioArb, async (plans) => {
            await pool.query("TRUNCATE payments.payments, payments.outbox RESTART IDENTITY");
            const fake = new FakePsp();
            const psp = new ScriptedPsp(fake, plans);
            const occurrences = new Map<string, number>();
            const confirmCalls = new Map<number, number>();

            const svc = new PaymentsService(
              pool, psp,
              async (eventId) => {
                const n = confirmCalls.get(eventId) ?? 0; confirmCalls.set(eventId, n + 1);
                const a = plans[eventId].confirm[n] ?? "yes";
                if (a === "timeout") throw new StepTimeout("inventory slow");
                return a === "yes";
              },
              40,
              (point, info) => {
                // payment identity for the plan: id-1 modulo the plan count (ids are assigned in arrival order, which is arbitrary)
                const idx = (info.id - 1) % plans.length;
                const k = `${idx}:${point}`; const n = (occurrences.get(k) ?? 0) + 1; occurrences.set(k, n);
                if (plans[idx].crashes.some((c) => c.point === point && c.nth === n)) throw new Error(`crash ${k}#${n}`);
              },
            );

            const reqOf = (i: number) => ({ idempotencyKey: `k${i}`, eventId: i, userId: `u${i}`, seatIds: [i], amountCents: plans[i].amountCents });
            const runners: Promise<unknown>[] = [];
            plans.forEach((pl, i) => pl.runners.forEach((r) => runners.push((async () => {
              await sleep(r.delayMs);
              if (r.kind === "pay") await svc.pay(reqOf(i));
              else if (r.kind === "sweep") await svc.sweep(-1);
              else {
                const row = (await pool.query("SELECT id FROM payments.payments WHERE idempotency_key=$1", [scopedKey(`u${i}`, `k${i}`)])).rows[0];
                if (row) await svc.resume(row.id);
              }
            })().catch(() => undefined)))); // crashes and timeouts surface as rejections; the saga state is what matters
            await Promise.all(runners);

            // Quiesce: sweep until every payment is terminal. Every fault source is finite, so this must converge.
            let rounds = 0;
            const total = () => pool.query("SELECT count(*)::int c FROM payments.payments WHERE status <> ALL($1)", [TERMINAL]).then((r) => r.rows[0].c as number);
            while (rounds++ < 40) {
              while (psp.inflight > 0) await sleep(5); // let timed-out provider calls land
              if ((await total()) === 0) break;
              await svc.sweep(-1).catch((e) => { if (process.env.SAGA_DEBUG) console.log("sweep err", e); });
            }

            const rows = (await pool.query("SELECT id, idempotency_key, status, amount_cents FROM payments.payments ORDER BY id")).rows;
            const events = (await pool.query("SELECT payload->>'eventType' AS t, (payload->>'paymentId')::int AS pid FROM payments.outbox ORDER BY id")).rows;

            // (a) exactly one terminal state per payment; every payment that was started exists
            for (const r of rows) expect(TERMINAL, `payment ${r.id} stuck in ${r.status}`).toContain(r.status);
            expect(rows.length).toBe(plans.length);

            // (b) exactly one terminal event per payment, consistent with its state, never confirmed + refunded
            const wantEvent: Record<string, string> = { CONFIRMED: "payment.confirmed", REFUNDED: "payment.refunded", FAILED: "payment.failed" };
            for (const r of rows) {
              const mine = events.filter((e) => e.pid === Number(r.id)).map((e) => e.t);
              expect(mine, `events of payment ${r.id} (${r.status})`).toEqual([wantEvent[r.status]]);
            }

            // (e) outbox rows == terminal transitions
            expect(events.length).toBe(rows.filter((r) => TERMINAL.includes(r.status)).length);

            // (c) money conservation: effective charges - effective refunds == sum of CONFIRMED amounts
            const charged = [...fake.chargedCentsById.values()].reduce((a, b) => a + b, 0);
            let refunded = 0;
            for (const [chargeId, n] of fake.refundsPerCharge) refunded += n * fake.chargedCentsById.get(chargeId)!;
            const confirmedSum = rows.filter((r) => r.status === "CONFIRMED").reduce((a, r) => a + r.amount_cents, 0);
            expect(charged - refunded).toBe(confirmedSum);

            // (d) refunds <= 1 per charge/payment; exactly one charge per payment that was ever charged
            for (const n of fake.refundsPerCharge.values()) expect(n).toBeLessThanOrEqual(1);
            for (const r of rows) {
              const everCharged = fake.charges.has(r.idempotency_key);
              expect(everCharged, `payment ${r.id} ${r.status}`).toBe(r.status !== "FAILED");
              const refundsOfIt = everCharged ? fake.refundsPerCharge.get(fake.charges.get(r.idempotency_key)!) ?? 0 : 0;
              expect(refundsOfIt, `refunds of payment ${r.id}`).toBe(r.status === "REFUNDED" ? 1 : 0);
            }
            expect(fake.charges.size).toBe(rows.filter((r) => r.status !== "FAILED").length);
          }),
          { numRuns, endOnFailure: true },
        );
      },
      120_000,
    );
  });
}
