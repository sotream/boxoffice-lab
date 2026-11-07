import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { FAULT_POINTS, FaultHook, PaymentsService, PaymentRequest, StepTimeout } from "./payments.service";
import { FakePsp, Psp } from "./psp";

/** Deterministic race, REFUNDING and crash-at-every-boundary tests. Registered from payments.test.ts (one file owns the DB tables). */
export function registerRaceTests(pool: Pool): void {
  const req = (key: string, over: Partial<PaymentRequest> = {}): PaymentRequest =>
    ({ idempotencyKey: key, eventId: 1, userId: "u1", seatIds: [1, 2], amountCents: 5000, ...over });
  const outbox = async () => (await pool.query("SELECT payload->>'eventType' AS t FROM payments.outbox ORDER BY id")).rows.map((r) => r.t as string);
  const statusOf = async (id = 1) => (await pool.query("SELECT status FROM payments.payments WHERE id=$1", [id])).rows[0].status as string;
  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
  /** Put a payment into CHARGED by crashing right after the PENDING -> CHARGED commit. */
  const toCharged = async (psp: Psp, key = "race") => {
    const svc = new PaymentsService(pool, psp, async () => true, 2000, (p, i) => { if (p === "after-transition" && i.to === "CHARGED") throw new Error("crash"); });
    await expect(svc.pay(req(key))).rejects.toThrow("crash");
    expect(await statusOf()).toBe("CHARGED");
  };

  describe("refund is claimed before it is issued (REFUNDING)", () => {
    it("a runner whose confirm answer is 'no' but who lost the race to CONFIRMED must not refund", async () => {
      const psp = new FakePsp();
      await toCharged(psp);
      const slow = gate();
      let calls = 0;
      const confirm = async () => { if (calls++ === 0) { await slow.p; return false; } return true; };
      const loser = new PaymentsService(pool, psp, confirm);
      const winner = new PaymentsService(pool, psp, confirm);
      const lost = loser.resume(1);            // blocked inside confirm, will answer false
      await new Promise((r) => setTimeout(r, 20));
      expect((await winner.resume(1)).status).toBe("CONFIRMED");
      slow.open();
      expect((await lost).status).toBe("CONFIRMED"); // lost the CAS, reports the stored state
      expect(psp.refundCalls).toBe(0);
      expect(psp.refundsApplied).toBe(0);
      expect(await outbox()).toEqual(["payment.confirmed"]);
    });

    it("the symmetric order: refund claimed first, a late 'yes' cannot flip it to CONFIRMED or double-write", async () => {
      const psp = new FakePsp();
      await toCharged(psp);
      const slow = gate();
      let calls = 0;
      const confirm = async () => { if (calls++ === 0) { await slow.p; return true; } return false; };
      const late = new PaymentsService(pool, psp, confirm).resume(1);
      await new Promise((r) => setTimeout(r, 20));
      expect((await new PaymentsService(pool, psp, confirm).resume(1)).status).toBe("REFUNDED");
      slow.open();
      expect((await late).status).toBe("REFUNDED");
      expect(psp.refundsApplied).toBe(1);
      expect(await outbox()).toEqual(["payment.refunded"]);
    });

    it("the state is REFUNDING while the refund call is in flight, and pay() with the same key reports in-progress", async () => {
      const psp = new FakePsp();
      const hold = gate();
      const entered = gate(); // opens when the refund call is entered: the REFUNDING claim is committed by then
      const slowRefund: Psp = { charge: (k, a) => psp.charge(k, a), refund: async (c, k) => { entered.open(); await hold.p; return psp.refund(c, k); } };
      const svc = new PaymentsService(pool, slowRefund, async () => false);
      const running = svc.pay(req("inflight"));
      await entered.p;
      expect(await statusOf()).toBe("REFUNDING");
      const again = await svc.pay(req("inflight"));
      expect(again.kind).toBe("in-progress");
      expect(again.payment.status).toBe("REFUNDING");
      hold.open();
      expect((await running).payment.status).toBe("REFUNDED");
      expect((await svc.pay(req("inflight"))).kind).toBe("done");
    });

    it("sweeper resumes a REFUNDING saga left by a crash before the refund call", async () => {
      const psp = new FakePsp();
      const crash: FaultHook = (p) => { if (p === "before-refund") throw new Error("crash"); };
      await expect(new PaymentsService(pool, psp, async () => false, 2000, crash).pay(req("sw"))).rejects.toThrow("crash");
      expect(await statusOf()).toBe("REFUNDING");
      expect(psp.refundCalls).toBe(0);
      await pool.query("UPDATE payments.payments SET updated_at = now() - interval '10 seconds'");
      expect(await new PaymentsService(pool, psp, async () => false).sweep(3)).toBe(1);
      expect(await statusOf()).toBe("REFUNDED");
      expect(psp.refundsApplied).toBe(1);
      expect(await outbox()).toEqual(["payment.refunded"]);
    });

    it("two runners resuming one REFUNDING saga: one effective refund, one event", async () => {
      const psp = new FakePsp(10);
      const crash: FaultHook = (p) => { if (p === "before-refund") throw new Error("crash"); };
      await expect(new PaymentsService(pool, psp, async () => false, 2000, crash).pay(req("two"))).rejects.toThrow("crash");
      const svc = () => new PaymentsService(pool, psp, async () => false);
      const rs = await Promise.all([svc().resume(1), svc().resume(1), svc().resume(1)]);
      expect(rs.map((r) => r.status)).toEqual(["REFUNDED", "REFUNDED", "REFUNDED"]);
      expect(psp.refundsApplied).toBe(1);
      expect(await outbox()).toEqual(["payment.refunded"]);
    });

    it("never marks REFUNDED when the provider cannot find the charge: fails loudly and stays REFUNDING", async () => {
      const psp = new FakePsp();
      await toCharged(psp);
      const amnesiac: Psp = { charge: async () => ({ ok: false }), refund: (c, k) => psp.refund(c, k) };
      await expect(new PaymentsService(pool, amnesiac, async () => false).resume(1)).rejects.toThrow("cannot refund");
      expect(await statusOf()).toBe("REFUNDING");
      expect(await outbox()).toEqual([]);
      expect((await new PaymentsService(pool, psp, async () => false).resume(1)).status).toBe("REFUNDED"); // recovers once the provider answers
    });

    it("a refund call that times out leaves REFUNDING (unknown outcome), the sweeper finishes it with the same key", async () => {
      const psp = new FakePsp();
      let slow = true;
      const flaky: Psp = { charge: (k, a) => psp.charge(k, a), refund: async (c, k) => { if (slow) await new Promise((r) => setTimeout(r, 120)); return psp.refund(c, k); } };
      const svc = new PaymentsService(pool, flaky, async () => false, 40);
      const r = await svc.pay(req("rt"));
      expect(r.kind).toBe("in-progress");
      expect(r.payment.status).toBe("REFUNDING");
      slow = false;
      await new Promise((res) => setTimeout(res, 150)); // the timed-out call lands at the provider
      await pool.query("UPDATE payments.payments SET updated_at = now() - interval '10 seconds'");
      await svc.sweep(3);
      expect(await statusOf()).toBe("REFUNDED");
      expect(psp.refundsApplied).toBe(1);
    });
  });

  describe("confirm needs no claim: it is idempotent in inventory", () => {
    /** Inventory model with the real contract: confirming seats already sold to the same user is a success. */
    const inventory = () => {
      const sold = new Map<number, string>();
      let calls = 0;
      const confirm = async (_e: number, seats: number[], user: string) => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        if (seats.some((s) => sold.has(s) && sold.get(s) !== user)) return false;
        for (const s of seats) sold.set(s, user);
        return true;
      };
      return { sold, confirm, calls: () => calls };
    };

    it("three runners confirm the same payment concurrently: seats sold once, one CONFIRMED event, no refund", async () => {
      const psp = new FakePsp();
      await toCharged(psp);
      const inv = inventory();
      const mk = () => new PaymentsService(pool, psp, inv.confirm);
      const rs = await Promise.all([mk().resume(1), mk().resume(1), mk().resume(1)]);
      expect(rs.map((r) => r.status)).toEqual(["CONFIRMED", "CONFIRMED", "CONFIRMED"]);
      expect(inv.calls()).toBe(3); // every runner really did call confirm
      expect([...inv.sold.entries()]).toEqual([[1, "u1"], [2, "u1"]]);
      expect(psp.refundCalls).toBe(0);
      expect(await outbox()).toEqual(["payment.confirmed"]);
    });

    it("confirm succeeded, the runner crashed before recording it: the retry's confirm is a harmless repeat", async () => {
      const psp = new FakePsp();
      const inv = inventory();
      const crash: FaultHook = (p) => { if (p === "after-confirm") throw new Error("crash"); };
      await expect(new PaymentsService(pool, psp, inv.confirm, 2000, crash).pay(req("cc"))).rejects.toThrow("crash");
      expect((await new PaymentsService(pool, psp, inv.confirm).resume(1)).status).toBe("CONFIRMED");
      expect(inv.calls()).toBe(2);
      expect(inv.sold.size).toBe(2);
      expect(psp.refundCalls).toBe(0);
      expect(await outbox()).toEqual(["payment.confirmed"]);
    });
  });

  describe("crash at every boundary, for both confirm outcomes", () => {
    for (const confirmOk of [true, false]) {
      for (const point of FAULT_POINTS) {
        for (const nth of [1, 2, 3]) {
          it(`crash at ${point} #${nth}, confirm=${confirmOk}: one resume reaches exactly one terminal state with conserved money`, async () => {
            const psp = new FakePsp();
            const seen = new Map<string, number>();
            const crash: FaultHook = (p) => { const n = (seen.get(p) ?? 0) + 1; seen.set(p, n); if (p === point && n === nth) throw new Error(`crash ${p}#${n}`); };
            const svc = new PaymentsService(pool, psp, async () => confirmOk, 2000, crash);
            const first = await svc.pay(req("every")).then(() => "ok", () => "crashed");
            // keep resuming (as the sweeper would) until the saga is final
            for (let i = 0; i < 5 && !["CONFIRMED", "REFUNDED"].includes(await statusOf()); i++) await svc.resume(1).catch(() => undefined); // a later boundary may crash a resume too
            const want = confirmOk ? "CONFIRMED" : "REFUNDED";
            expect(await statusOf()).toBe(want);
            expect(await outbox()).toEqual([confirmOk ? "payment.confirmed" : "payment.refunded"]);
            expect(psp.charges.size).toBe(1);
            expect(psp.refundsApplied).toBe(confirmOk ? 0 : 1);
            const reachable = confirmOk ? !point.includes("refund") : true; // the refund boundaries exist only on the compensation path
            if (nth === 1 && reachable) expect(first, `boundary ${point} must be reached on this path`).toBe("crashed");
            expect(first === "crashed" || (seen.get(point) ?? 0) < nth).toBe(true); // crash fired iff the boundary was reached that often
          });
        }
      }
    }
  });
}
