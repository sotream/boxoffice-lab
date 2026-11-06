import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, migrate } from "./db";
import { OutboxRelay } from "./outbox-relay";
import { PaymentsService, PaymentRequest, StepTimeout } from "./payments.service";
import { FakePsp } from "./psp";

const pool = createPool(30);
beforeAll(async () => { await migrate(pool); });
beforeEach(async () => { await pool.query("TRUNCATE payments.payments, payments.outbox RESTART IDENTITY"); });
afterAll(async () => { await pool.end(); });

const req = (key: string, over: Partial<PaymentRequest> = {}): PaymentRequest =>
  ({ idempotencyKey: key, eventId: 1, userId: "u1", seatIds: [1, 2], amountCents: 5000, ...over });
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
    const svc = new PaymentsService(pool, psp, async () => true);
    svc.crashAt = "after-charge";
    await expect(svc.pay(req("k5"))).rejects.toThrow("crash");
    expect((await pool.query("SELECT status FROM payments.payments")).rows[0].status).toBe("CHARGED");
    svc.crashAt = undefined;
    expect((await svc.resume(1)).status).toBe("CONFIRMED");
    expect(psp.charges.size).toBe(1);
  });

  it("crash after confirm: resume does not duplicate the event", async () => {
    const svc = new PaymentsService(pool, new FakePsp(), async () => true);
    svc.crashAt = "after-confirm";
    await expect(svc.pay(req("k6"))).rejects.toThrow("crash");
    svc.crashAt = undefined;
    await svc.resume(1); await svc.resume(1);
    expect(await outbox()).toEqual(["payment.confirmed"]);
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
