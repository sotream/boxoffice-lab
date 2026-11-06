import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, migrate } from "./db";
import { Channel, DeadLetter, InFlight, NotificationHandler, PaymentEvent, Sender } from "./handler";

const pool = createPool(10);
beforeAll(async () => { await migrate(pool); });
beforeEach(async () => { await pool.query("TRUNCATE notifications.deliveries"); });
afterAll(async () => { await pool.end(); });

const ev = (id: number, type = "payment.confirmed"): PaymentEvent => ({ outboxId: id, eventType: type, paymentId: id, userId: "u", seatIds: [1] });

describe("NotificationHandler", () => {
  it("fans out confirmed to email and push", async () => {
    const calls: Channel[] = [];
    const h = new NotificationHandler(pool, async (c) => { calls.push(c); });
    expect((await h.handle(ev(1))).sent).toEqual(["email", "push"]);
    expect(calls).toEqual(["email", "push"]);
  });

  it("dedup: 20 concurrent deliveries of one event send once per channel; the rest are told to retry later", async () => {
    let n = 0;
    const h = new NotificationHandler(pool, async () => { n++; await new Promise((r) => setTimeout(r, 30)); });
    const rs = await Promise.allSettled(Array.from({ length: 20 }, () => h.handle(ev(2))));
    expect(n).toBe(2); // email + push, exactly once
    // Workers may split the channels between them, so a call is either complete or told to retry later; never an error.
    expect(rs.every((r) => r.status === "fulfilled" || (r.status === "rejected" && r.reason instanceof InFlight))).toBe(true);
    const again = await h.handle(ev(2)); // the redelivery after the in-flight work finished
    expect(again.skipped).toEqual(["email", "push"]);
    expect(n).toBe(2);
  });

  it("a crashed worker's expired lease is taken over", async () => {
    await pool.query("INSERT INTO notifications.deliveries (outbox_id, channel, status, updated_at) VALUES (7,'email','SENDING', now() - interval '1 minute'), (7,'push','SENT', now())");
    const calls: Channel[] = [];
    const h = new NotificationHandler(pool, async (c) => { calls.push(c); }, { leaseMs: 30_000 });
    expect((await h.handle(ev(7))).sent).toEqual(["email"]);
    expect(calls).toEqual(["email"]);
  });

  it("serial duplicates are skipped", async () => {
    let n = 0;
    const h = new NotificationHandler(pool, async () => { n++; });
    await h.handle(ev(3));
    const r = await h.handle(ev(3));
    expect(r.skipped).toEqual(["email", "push"]);
    expect(n).toBe(2);
  });

  it("retries transient failures then succeeds", async () => {
    let tries = 0;
    const h = new NotificationHandler(pool, async (c) => { if (c === "email" && ++tries < 3) throw new Error("smtp 503"); }, { backoffMs: 1 });
    expect((await h.handle(ev(4))).sent).toEqual(["email", "push"]);
    expect(tries).toBe(3);
    expect((await pool.query("SELECT attempts FROM notifications.deliveries WHERE outbox_id=4 AND channel='email'")).rows[0].attempts).toBe(2);
  });

  it("exhausted retries dead-letter, and a retry of the message does not resend the channel that worked", async () => {
    const sends: Channel[] = [];
    let emailDown = true;
    const send: Sender = async (c) => { if (c === "email" && emailDown) throw new Error("smtp down"); sends.push(c); };
    const h = new NotificationHandler(pool, send, { maxAttempts: 2, backoffMs: 1 });
    await expect(h.handle(ev(5))).rejects.toBeInstanceOf(DeadLetter);
    expect(sends).toEqual(["push"]);
    emailDown = false;
    expect((await h.handle(ev(5))).sent).toEqual(["email"]); // push skipped, not resent
    expect(sends).toEqual(["push", "email"]);
  });

  it("failed payments only notify by push", async () => {
    const calls: Channel[] = [];
    await new NotificationHandler(pool, async (c) => { calls.push(c); }).handle(ev(6, "payment.failed"));
    expect(calls).toEqual(["push"]);
  });
});
