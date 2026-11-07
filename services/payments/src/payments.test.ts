import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, migrate } from "./db";
import { OutboxRelay } from "./outbox-relay";
import { FaultHook, FaultPoint, IdempotencyKeyReused, PaymentsService, PaymentRequest, StepTimeout, scopedKey } from "./payments.service";
import { FakePsp } from "./psp";
import { registerRaceTests } from "./saga.races";
import { registerPropertyTests } from "./saga.property";
import { SWEEP_MARGIN_MS, sweepMarginProblem } from "./sweep-margin";

const pool = createPool(30);
beforeAll(async () => { await migrate(pool); });
beforeEach(async () => { await pool.query("TRUNCATE payments.payments, payments.outbox RESTART IDENTITY"); });
afterAll(async () => { await pool.end(); });

const req = (key: string, over: Partial<PaymentRequest> = {}): PaymentRequest =>
  ({ idempotencyKey: key, eventId: 1, userId: "u1", seatIds: [1, 2], amountCents: 5000, ...over });
/** One-shot crash: throws the first time `point` is reached (optionally only for a given transition target). */
const crashOnce = (point: FaultPoint, to?: string): FaultHook => {
  let fired = false;
  return (p, info) => { if (!fired && p === point && (to === undefined || info.to === to)) { fired = true; throw new Error(`crash at ${point}`); } };
};
const statusOf = async (id = 1) => (await pool.query("SELECT status FROM payments.payments WHERE id=$1", [id])).rows[0].status as string;
const outbox = async () => (await pool.query("SELECT payload->>'eventType' AS t FROM payments.outbox ORDER BY id")).rows.map((r) => r.t);

describe("payments saga", () => {
  it("happy path: charge, confirm seats, one outbox event", async () => {
    const psp = new FakePsp();
    const svc = new PaymentsService(pool, psp, async () => true);
    expect((await svc.pay(req("k1"))).payment.status).toBe("CONFIRMED");
    expect(await outbox()).toEqual(["payment.confirmed"]);
  });

  it("compensates: hold expired -> refund, not a stuck charge", async () => {
    const psp = new FakePsp();
    const svc = new PaymentsService(pool, psp, async () => false);
    expect((await svc.pay(req("k2"))).payment.status).toBe("REFUNDED");
    expect(psp.refunds.size).toBe(1);
    expect(await outbox()).toEqual(["payment.refunded"]);
  });

  it("failed charge ends FAILED and never touches inventory", async () => {
    let confirms = 0;
    const svc = new PaymentsService(pool, new FakePsp(0, 1), async () => { confirms++; return true; });
    expect((await svc.pay(req("k3"))).payment.status).toBe("FAILED");
    expect(confirms).toBe(0);
  });

  it("idempotency: 50 concurrent requests with one key charge exactly once", async () => {
    const psp = new FakePsp(20);
    const svc = new PaymentsService(pool, psp, async () => true);
    const rs = await Promise.all(Array.from({ length: 50 }, () => svc.pay(req("same"))));
    expect(psp.chargeCalls).toBe(1);
    expect((await pool.query("SELECT count(*)::int c FROM payments.payments")).rows[0].c).toBe(1);
    expect(rs.filter((r) => r.kind === "done" && r.payment.status === "CONFIRMED").length).toBeGreaterThanOrEqual(1);
    // a retry after completion returns the stored result without charging
    expect((await svc.pay(req("same"))).payment.status).toBe("CONFIRMED");
    expect(psp.chargeCalls).toBe(1);
  });

  it("crash after charge: resume finishes the saga and does not double charge", async () => {
    const psp = new FakePsp();
    const svc = new PaymentsService(pool, psp, async () => true, 2000, crashOnce("after-charge"));
    await expect(svc.pay(req("k5"))).rejects.toThrow("crash");
    expect(await statusOf()).toBe("PENDING"); // money taken, state not yet recorded
    expect((await svc.resume(1)).status).toBe("CONFIRMED");
    expect(psp.charges.size).toBe(1); // the retry hit the same key
    expect(psp.chargeCalls).toBe(2);
  });

  it("crash after confirm: resume does not duplicate the event", async () => {
    const svc = new PaymentsService(pool, new FakePsp(), async () => true, 2000, crashOnce("after-confirm"));
    await expect(svc.pay(req("k6"))).rejects.toThrow("crash");
    await svc.resume(1); await svc.resume(1);
    expect(await outbox()).toEqual(["payment.confirmed"]);
  });
});

describe("idempotency key scoping", () => {
  const rows = async () => (await pool.query("SELECT user_id, event_id, seat_ids, status FROM payments.payments ORDER BY id")).rows;

  it("the same key with the same request returns the stored result, as before", async () => {
    const psp = new FakePsp();
    const svc = new PaymentsService(pool, psp, async () => true);
    const first = await svc.pay(req("same-req"));
    const again = await svc.pay(req("same-req"));
    expect(again).toEqual(first);
    expect(again.payment.status).toBe("CONFIRMED");
    expect(psp.chargeCalls).toBe(1);
  });

  it("the same seats in another order are the same request", async () => {
    const svc = new PaymentsService(pool, new FakePsp(), async () => true);
    const first = await svc.pay(req("order", { seatIds: [1, 2, 3] }));
    expect(await svc.pay(req("order", { seatIds: [3, 1, 2] }))).toEqual(first);
  });

  it("two users with the same client key get two independent payments, and neither sees the other's id or status", async () => {
    const psp = new FakePsp();
    const svc = new PaymentsService(pool, psp, async () => true);
    const a = await svc.pay(req("shared-key", { userId: "alice" }));
    const m = await svc.pay(req("shared-key", { userId: "mallory", seatIds: [7] }));
    expect(a.payment.id).not.toBe(m.payment.id);
    expect(psp.chargeCalls).toBe(2);
    expect((await rows()).map((r) => r.user_id)).toEqual(["alice", "mallory"]);
    // each replay returns the caller's own payment
    expect(await svc.pay(req("shared-key", { userId: "alice" }))).toEqual(a);
    expect(await svc.pay(req("shared-key", { userId: "mallory", seatIds: [7] }))).toEqual(m);
    expect(psp.chargeCalls).toBe(2);
  });

  it("a user cannot block another user's key: the victim's request still succeeds after the attacker used the key first", async () => {
    const psp = new FakePsp();
    const svc = new PaymentsService(pool, psp, async () => true);
    await svc.pay(req("pay-victim-1", { userId: "mallory", eventId: 9, seatIds: [99] })); // squats the predictable key
    const victim = await svc.pay(req("pay-victim-1", { userId: "victim" }));
    expect(victim.kind).toBe("done");
    expect(victim.payment.status).toBe("CONFIRMED");
    expect((await rows()).find((r) => r.user_id === "victim")).toMatchObject({ event_id: 1, seat_ids: [1, 2] });
  });

  it("a colliding-looking user/key pair is independent: user 'a:b' + key 'c' vs user 'a' + key 'b:c'", async () => {
    expect(scopedKey("a:b", "c")).not.toBe(scopedKey("a", "b:c"));
    const psp = new FakePsp();
    const svc = new PaymentsService(pool, psp, async () => true);
    const x = await svc.pay(req("c", { userId: "a:b" }));
    const y = await svc.pay(req("b:c", { userId: "a", seatIds: [3] }));
    expect(x.payment.id).not.toBe(y.payment.id);
    expect(psp.chargeCalls).toBe(2);
    expect((await rows()).map((r) => r.user_id)).toEqual(["a:b", "a"]);
  });

  it("the scoped key is what the PSP is charged and refunded with", async () => {
    const charges: string[] = [];
    const refunds: string[] = [];
    const inner = new FakePsp();
    const psp = { charge: (k: string, a: number) => { charges.push(k); return inner.charge(k, a); }, refund: (c: string, k: string) => { refunds.push(k); return inner.refund(c, k); } };
    const svc = new PaymentsService(pool, psp, async () => false);
    await svc.pay(req("kk", { userId: "u1" }));
    expect(new Set(charges)).toEqual(new Set([scopedKey("u1", "kk")]));
    expect(refunds).toEqual([`refund:${scopedKey("u1", "kk")}`]);
  });

  it("a different event or a different seat set under the same key (same user) is refused too, also while the saga is in progress", async () => {
    const svc = new PaymentsService(pool, new FakePsp(), async () => true, 2000, crashOnce("after-charge"));
    await expect(svc.pay(req("k-open"))).rejects.toThrow("crash"); // row exists, still PENDING
    for (const over of [{ eventId: 2 }, { seatIds: [1, 3] }, { seatIds: [1] }, { seatIds: [1, 2, 3] }]) {
      await expect(svc.pay(req("k-open", over)), JSON.stringify(over)).rejects.toBeInstanceOf(IdempotencyKeyReused);
    }
    expect((await rows())[0].status).toBe("PENDING");
  });
});

describe("compensation and compare-and-set", () => {
  it("crash after refund: resume retries with the same key, one effective refund, one event", async () => {
    const psp = new FakePsp();
    const svc = new PaymentsService(pool, psp, async () => false, 2000, crashOnce("after-refund"));
    await expect(svc.pay(req("k7"))).rejects.toThrow("crash");
    expect(await statusOf()).toBe("REFUNDING"); // claimed, refund issued, outcome not yet recorded
    expect((await svc.resume(1)).status).toBe("REFUNDED");
    expect(psp.refundCalls).toBe(2); // the retry did call the provider...
    expect(psp.refundsApplied).toBe(1); // ...but the key made it a no-op
    expect(await outbox()).toEqual(["payment.refunded"]);
  });

  it("a lost compare-and-set reports the stored state and writes no event", async () => {
    const svc = new PaymentsService(pool, new FakePsp(), async () => true);
    await svc.pay(req("k8"));
    const row = (await pool.query("SELECT * FROM payments.payments WHERE id=1")).rows[0];
    const lost = await (svc as any).transition(1, "CHARGED", "REFUNDED", "payment.refunded", row);
    expect(lost.status).toBe("CONFIRMED");
    expect(await outbox()).toEqual(["payment.confirmed"]);
  });
});

describe("stale view", () => {
  it("a runner that loses PENDING -> CHARGED stops and does not confirm or refund", async () => {
    const psp = new FakePsp(100);
    let confirms = 0;
    const svc = new PaymentsService(pool, psp, async () => { confirms++; return false; });
    const running = svc.pay(req("k9"));
    await new Promise((r) => setTimeout(r, 30)); // the charge is in flight
    await pool.query("UPDATE payments.payments SET status='CONFIRMED' WHERE id=1"); // another runner finished the saga
    expect((await running).payment.status).toBe("CONFIRMED");
    expect(confirms).toBe(0);
    expect(psp.refundCalls).toBe(0);
  });
});

describe("timeouts", () => {
  it("slow PSP: caller gets in-progress quickly, sweeper finishes it, one charge", async () => {
    const psp = new FakePsp(300);
    const svc = new PaymentsService(pool, psp, async () => true, 50);
    const r = await svc.pay(req("slow1"));
    expect(r.kind).toBe("in-progress");
    expect(r.payment.status).toBe("PENDING");
    psp.latencyMs = 0;
    await pool.query("UPDATE payments.payments SET updated_at = now() - interval '10 seconds'");
    expect(await svc.sweep(3)).toBe(1);
    expect((await pool.query("SELECT status FROM payments.payments")).rows[0].status).toBe("CONFIRMED");
    expect(psp.charges.size).toBe(1);
  });

  it("confirm timeout does NOT refund: the outcome is unknown, the saga waits in CHARGED", async () => {
    const psp = new FakePsp();
    let calls = 0;
    const svc = new PaymentsService(pool, psp, async () => { if (calls++ === 0) throw new StepTimeout("inventory slow"); return true; }, 50);
    const r = await svc.pay(req("slow2"));
    expect(r.kind).toBe("in-progress");
    expect(r.payment.status).toBe("CHARGED");
    expect(psp.refunds.size).toBe(0);
    await pool.query("UPDATE payments.payments SET updated_at = now() - interval '10 seconds'");
    await svc.sweep(3);
    expect((await pool.query("SELECT status FROM payments.payments")).rows[0].status).toBe("CONFIRMED");
    expect(psp.refunds.size).toBe(0);
  });
});

describe("sweeper reports what it could not advance", () => {
  it("a saga that fails on every sweep is reported, not swallowed", async () => {
    const svc = new PaymentsService(pool, new FakePsp(), async () => { throw new Error("inventory rejected the confirm request with 400"); });
    await svc.pay(req("sweep-err")).catch(() => undefined); // charged, confirm threw: stays CHARGED
    await pool.query("UPDATE payments.payments SET updated_at = now() - interval '10 seconds'");
    const seen: Array<{ id: number; message: string }> = [];
    svc.onSweepError = (id, err) => seen.push({ id, message: String((err as Error).message) });
    expect(await svc.sweep(3)).toBe(0);
    expect(seen).toEqual([{ id: 1, message: "inventory rejected the confirm request with 400" }]);
    expect((await pool.query("SELECT status FROM payments.payments")).rows[0].status).toBe("CHARGED");
  });
});

describe("outbox relay", () => {
  it("publishes each row once per successful drain and marks it", async () => {
    const svc = new PaymentsService(pool, new FakePsp(), async () => true);
    for (let i = 0; i < 5; i++) await svc.pay(req(`r${i}`));
    const sent: string[] = [];
    const relay = new OutboxRelay(pool, async (_t, m) => { sent.push(...m.map((x) => JSON.parse(x.value).outboxId)); });
    expect(await relay.drainOnce()).toBe(5);
    expect(await relay.drainOnce()).toBe(0);
    expect(sent).toHaveLength(5);
  });

  it("publishes outboxId as a JSON number: pg returns bigserial as a string and the notifications consumer dead-letters anything but a safe integer", async () => {
    const svc = new PaymentsService(pool, new FakePsp(), async () => true);
    await svc.pay(req("num1"));
    const values: string[] = [];
    await new OutboxRelay(pool, async (_t, m) => { values.push(...m.map((x) => x.value)); }).drainOnce();
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) { expect(typeof JSON.parse(v).outboxId).toBe("number"); expect(v).toMatch(/"outboxId":\d+,/); }
  });

  it("a broker failure keeps rows unpublished (at-least-once, retry later)", async () => {
    const svc = new PaymentsService(pool, new FakePsp(), async () => true);
    await svc.pay(req("f1"));
    const bad = new OutboxRelay(pool, async () => { throw new Error("broker down"); });
    await expect(bad.drainOnce()).rejects.toThrow("broker down");
    const ok = new OutboxRelay(pool, async () => undefined);
    expect(await ok.drainOnce()).toBe(1);
  });

  it("two relays at once never publish the same row (SKIP LOCKED)", async () => {
    const svc = new PaymentsService(pool, new FakePsp(), async () => true);
    for (let i = 0; i < 40; i++) await svc.pay(req(`c${i}`));
    const sent: number[] = [];
    const mk = () => new OutboxRelay(pool, async (_t, m) => { await new Promise((r) => setTimeout(r, 30)); sent.push(...m.map((x) => JSON.parse(x.value).outboxId)); }, 10);
    const [a, b] = await Promise.all([mk().drainOnce(), mk().drainOnce()]);
    expect(a + b).toBe(20);
    expect(new Set(sent).size).toBe(sent.length);
  });
});

// Same file, same pool: these suites share the payments tables, so they must not run in parallel workers.
registerRaceTests(pool);
registerPropertyTests(pool);

describe("pre-charge ownership check (ADR 007)", () => {
  const svcWith = (psp: FakePsp, verify: (e: number, s: number[], u: string) => Promise<boolean>, confirm: () => Promise<boolean> = async () => true, stepMs = 2000) =>
    new PaymentsService(pool, psp, confirm, stepMs, undefined, verify);

  it("seats not held by the payer: FAILED, nothing charged, inventory never asked to confirm, one payment.failed event", async () => {
    const psp = new FakePsp();
    let confirms = 0;
    const svc = svcWith(psp, async () => false, async () => { confirms++; return true; });
    const r = await svc.pay(req("own1"));
    expect(r).toMatchObject({ kind: "done", payment: { status: "FAILED" } });
    expect(psp.chargeCalls).toBe(0);
    expect(psp.charges.size).toBe(0);
    expect(confirms).toBe(0);
    expect(await outbox()).toEqual(["payment.failed"]);
  });

  it("seats held by the payer: the saga goes on as before and the question carries event, seats and user", async () => {
    const asked: unknown[] = [];
    const psp = new FakePsp();
    const svc = svcWith(psp, async (e, s, u) => { asked.push([e, s, u]); return true; });
    expect((await svc.pay(req("own2", { eventId: 9, seatIds: [4, 5], userId: "zed" }))).payment.status).toBe("CONFIRMED");
    expect(asked).toEqual([[9, [4, 5], "zed"]]);
    expect(psp.charges.size).toBe(1);
  });

  it("an unknown answer (timeout) does not fail the payment: it stays PENDING uncharged and the sweeper completes it without asking again", async () => {
    const psp = new FakePsp();
    let asked = 0;
    const svc = svcWith(psp, async () => { asked++; throw new StepTimeout("inventory slow"); });
    const r = await svc.pay(req("own3"));
    expect(r).toMatchObject({ kind: "in-progress", payment: { status: "PENDING" } });
    expect(psp.chargeCalls).toBe(0);
    await pool.query("UPDATE payments.payments SET updated_at = now() - interval '10 seconds'");
    expect(await svc.sweep(3)).toBe(1);
    expect(await statusOf()).toBe("CONFIRMED");
    expect(asked).toBe(1);
  });

  describe("sweeper threshold versus the slow check (ADR 007)", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    /** A pay() whose check answers "not held" after `verifyMs`, while a sweeper with the given threshold polls every 25 ms. */
    const payWithSweeper = async (stepMs: number, verifyMs: number, thresholdSeconds: number, key: string) => {
      const psp = new FakePsp();
      const svc = svcWith(psp, async () => { await sleep(verifyMs); return false; }, async () => true, stepMs);
      let stop = false;
      const sweeper = (async () => { while (!stop) { await svc.sweep(thresholdSeconds); await sleep(25); } })();
      try { return { psp, outcome: await svc.pay(req(key)) }; } finally { stop = true; await sweeper; }
    };

    it("valid configuration: a check that takes nearly the whole step timeout still fails the payment and the sweeper never charges it", async () => {
      const stepMs = 400, thresholdMs = stepMs + SWEEP_MARGIN_MS;
      expect(sweepMarginProblem({ sweepMinAgeMs: thresholdMs, confirmTimeoutMs: stepMs, pspTimeoutMs: stepMs, verifyHolds: true })).toBeUndefined();
      const { psp, outcome } = await payWithSweeper(stepMs, 350, thresholdMs / 1000, "sw1");
      expect(outcome).toMatchObject({ kind: "done", payment: { status: "FAILED" } });
      expect(psp.chargeCalls).toBe(0);
      expect(await outbox()).toEqual(["payment.failed"]);
    });

    it("the dangerous configuration is refused at startup, and it is dangerous: the sweeper charges a payment the request path then fails as not held", async () => {
      const stepMs = 400, thresholdMs = 100;
      expect(sweepMarginProblem({ sweepMinAgeMs: thresholdMs, confirmTimeoutMs: stepMs, pspTimeoutMs: stepMs, verifyHolds: true })).toMatch(/SWEEP_MIN_AGE_MS \(100\) must be at least 900/);
      const { psp } = await payWithSweeper(stepMs, 350, thresholdMs / 1000, "sw2");
      expect(psp.chargeCalls).toBe(1); // charged although the check said "not held": exactly what the startup validation exists to prevent
    });
  });

  it("a contract error from the check propagates, and the payment is neither charged nor failed", async () => {
    const psp = new FakePsp();
    const svc = svcWith(psp, async () => { throw new Error("inventory rejected the holds/verify request with 400"); });
    await expect(svc.pay(req("own4"))).rejects.toThrow(/holds\/verify/);
    expect(psp.chargeCalls).toBe(0);
    expect(await statusOf()).toBe("PENDING");
  });

  it("a repeated request with the same key returns the stored result and does not ask again", async () => {
    const psp = new FakePsp();
    let asked = 0;
    const svc = svcWith(psp, async () => { asked++; return false; });
    expect((await svc.pay(req("own5"))).payment.status).toBe("FAILED");
    expect((await svc.pay(req("own5"))).payment.status).toBe("FAILED");
    expect(asked).toBe(1);
  });

  it("a payment that was already charged is never failed by a later answer: resume of a charged-then-crashed saga does not ask", async () => {
    const psp = new FakePsp();
    let asked = 0;
    const svc = new PaymentsService(pool, psp, async () => true, 2000, crashOnce("after-charge"), async () => { asked++; return true; });
    await expect(svc.pay(req("own6"))).rejects.toThrow(/crash at after-charge/);
    expect(asked).toBe(1);
    expect((await svc.resume(1)).status).toBe("CONFIRMED");
    expect(asked).toBe(1); // resume goes straight on from PENDING with the existing charge
    expect(psp.charges.size).toBe(1);
  });
});
