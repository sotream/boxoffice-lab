import fc from "fast-check";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, migrate } from "./db";
import { Channel, DeadLetter, InFlight, NotificationHandler, PaymentEvent, Sender } from "./handler";

/**
 * Dedup / retry / DLQ properties of the real handler against the real Postgres, with an injected (fake) sender, and of the
 * real consumer.ts with a fake kafkajs (no broker needed). outbox ids 9_000_000..9_099_999 are ours: only those rows are
 * ever deleted (never TRUNCATE), so other suites and load runs are untouched.
 * Re-run a failure with: FC_SEED=<seed> pnpm --filter @boxoffice/notifications test
 */
const SEED = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;
const BASE = 9_000_000;
const pool = createPool(20);
const clean = () => pool.query("DELETE FROM notifications.deliveries WHERE outbox_id >= $1 AND outbox_id < $2", [BASE, BASE + 100_000]);
beforeAll(async () => { await migrate(pool); await clean(); });
beforeEach(clean);
afterAll(async () => { await clean(); await pool.end(); });

const TYPES = ["payment.confirmed", "payment.refunded", "payment.failed", "payment.unknown"] as const;
const CHANNELS_OF: Record<string, Channel[]> = {
  "payment.confirmed": ["email", "push"], "payment.refunded": ["email", "push"], "payment.failed": ["push"], "payment.unknown": []
};
const ev = (i: number, type: string): PaymentEvent => ({ outboxId: BASE + i, eventType: type, paymentId: i, userId: `u${i}`, seatIds: [i] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake provider: records every call; the first `failures[key]` calls for a key throw (Infinity = poison). */
function provider(failures: Map<string, number>, jitterMs = 0) {
  const calls = new Map<string, number>();
  const ok = new Map<string, number>();
  const send: Sender = async (_c, _to, _text, dedupKey) => {
    calls.set(dedupKey, (calls.get(dedupKey) ?? 0) + 1);
    if (jitterMs) await sleep(Math.random() * jitterMs);
    if (calls.get(dedupKey)! <= (failures.get(dedupKey) ?? 0)) throw new Error(`provider down for ${dedupKey}`);
    ok.set(dedupKey, (ok.get(dedupKey) ?? 0) + 1);
  };
  return { send, calls, ok };
}

const eventsArb = fc.array(fc.record({ id: fc.integer({ min: 0, max: 5 }), type: fc.constantFrom(...TYPES) }), { minLength: 1, maxLength: 14 })
  .map((es) => { const seen = new Map<number, string>(); return es.map((e) => ({ id: e.id, type: seen.get(e.id) ?? (seen.set(e.id, e.type), e.type) })); }); // one type per outbox id
const failuresArb = fc.array(fc.oneof({ weight: 5, arbitrary: fc.constant(0) }, { weight: 3, arbitrary: fc.integer({ min: 1, max: 5 }) }, { weight: 1, arbitrary: fc.constant(Infinity) }), { minLength: 12, maxLength: 12 });

const uniqueKeys = (events: { id: number; type: string }[]) =>
  new Set(events.flatMap((e) => CHANNELS_OF[e.type].map((c) => `${BASE + e.id}:${c}`)));

describe("handler: dedup, retries and dead letters (sequential redeliveries)", () => {
  it("for random messages with duplicates, redeliveries and failures: delivered effects == unique dedup keys, none twice, poison is dead-lettered", async () => {
    await fc.assert(
      fc.asyncProperty(eventsArb, failuresArb, fc.integer({ min: 1, max: 4 }), async (events, failArr, maxAttempts) => {
        await clean();
        const failures = new Map<string, number>();
        const keys = [...uniqueKeys(events)];
        keys.forEach((k, i) => failures.set(k, failArr[i % failArr.length]));
        const p = provider(failures);
        const h = new NotificationHandler(pool, p.send, { maxAttempts, backoffMs: 0 });
        const poison = new Set(keys.filter((k) => failures.get(k) === Infinity));

        let deadLetters = 0;
        // at-least-once pipeline: the whole log is redelivered (in a shuffled-by-duplication order) until everything settles
        const stream = [...events, ...events]; // each message is delivered at least twice per round
        for (let round = 0; round < 3; round++) {
          for (const e of stream) {
            try {
              const r = await h.handle(ev(e.id, e.type));
              expect([...r.sent, ...r.skipped].sort()).toEqual([...CHANNELS_OF[e.type]].sort());
            } catch (err) {
              expect(err, "only a DeadLetter may escape the handler in the sequential case").toBeInstanceOf(DeadLetter);
              deadLetters++;
              for (const ch of (err as DeadLetter).failedChannels) expect(CHANNELS_OF[e.type]).toContain(ch);
            }
          }
        }
        // 1. delivered keys == unique keys minus poison; 2. none delivered twice
        expect(new Set(p.ok.keys())).toEqual(new Set(keys.filter((k) => !poison.has(k))));
        for (const [k, n] of p.ok) expect(n, `${k} delivered ${n} times`).toBe(1);
        // 3. a poison key stays FAILED, was retried exactly maxAttempts per delivery, and never succeeded
        for (const k of poison) {
          const [outbox, channel] = k.split(":");
          const row = (await pool.query("SELECT status, attempts FROM notifications.deliveries WHERE outbox_id=$1 AND channel=$2", [outbox, channel])).rows[0];
          expect(row.status).toBe("FAILED");
          expect(p.calls.get(k)).toBe(row.attempts); // attempts counts exactly the failed sends
          expect(p.ok.has(k)).toBe(false);
        }
        if (poison.size) expect(deadLetters).toBeGreaterThan(0);
        // 4. the delivery table holds exactly one row per unique key; everything non-poison is SENT
        const rows = (await pool.query("SELECT outbox_id, channel, status FROM notifications.deliveries WHERE outbox_id >= $1 AND outbox_id < $2", [BASE, BASE + 100_000])).rows;
        expect(rows).toHaveLength(keys.length);
        for (const r of rows) {
          const k = `${r.outbox_id}:${r.channel}`;
          expect(r.status).toBe(poison.has(k) ? "FAILED" : "SENT");
        }
      }),
      { numRuns: 40, seed: SEED }
    );
  }, 60_000);

  it("the documented retry budget: a poison channel is attempted exactly maxAttempts (default 4) times per delivery, then dead-lettered", async () => {
    const p = provider(new Map([[`${BASE + 1}:email`, Infinity]]));
    const h = new NotificationHandler(pool, p.send, { backoffMs: 0 }); // default maxAttempts
    await expect(h.handle(ev(1, "payment.confirmed"))).rejects.toMatchObject({ failedChannels: ["email"] });
    expect(p.calls.get(`${BASE + 1}:email`)).toBe(4);
    expect(p.ok.get(`${BASE + 1}:push`)).toBe(1); // the healthy channel was still delivered
    await expect(h.handle(ev(1, "payment.confirmed"))).rejects.toBeInstanceOf(DeadLetter);
    expect(p.calls.get(`${BASE + 1}:email`)).toBe(8);
    expect(p.calls.get(`${BASE + 1}:push`)).toBe(1); // push is not re-sent on redelivery
  });

  it("a poison message does not affect the delivery of any other message handled around it", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 6 }), fc.integer({ min: 1, max: 8 }), async (poisonAt, n) => {
        await clean();
        const poisonId = poisonAt % n;
        const p = provider(new Map([[`${BASE + poisonId}:push`, Infinity], [`${BASE + poisonId}:email`, Infinity]]));
        const h = new NotificationHandler(pool, p.send, { maxAttempts: 2, backoffMs: 0 });
        const outcomes: string[] = [];
        for (let i = 0; i < n; i++) outcomes.push(await h.handle(ev(i, "payment.confirmed")).then(() => "ok", (e) => (e instanceof DeadLetter ? "dlq" : "error")));
        expect(outcomes.filter((o) => o === "error")).toEqual([]);
        expect(outcomes.filter((o) => o === "dlq")).toHaveLength(1);
        expect(outcomes[poisonId]).toBe("dlq");
        expect(p.ok.size).toBe((n - 1) * 2);
      }),
      { numRuns: 25, seed: SEED }
    );
  });

  it("unknown event types have no channels: nothing is sent and nothing is recorded", async () => {
    const p = provider(new Map());
    const h = new NotificationHandler(pool, p.send, { backoffMs: 0 });
    expect(await h.handle(ev(3, "payment.unknown"))).toEqual({ sent: [], skipped: [] });
    expect(await h.handle(ev(3, "totally.different"))).toEqual({ sent: [], skipped: [] });
    expect(p.calls.size).toBe(0);
    expect((await pool.query("SELECT 1 FROM notifications.deliveries WHERE outbox_id=$1", [BASE + 3])).rowCount).toBe(0);
  });

  it("the provider receives the stable idempotency key outboxId:channel on every attempt", async () => {
    const seen: string[] = [];
    const h = new NotificationHandler(pool, async (_c, _to, _t, key) => { seen.push(key); if (seen.length < 3) throw new Error("x"); }, { maxAttempts: 4, backoffMs: 0 });
    await h.handle(ev(4, "payment.failed"));
    expect(seen).toEqual([`${BASE + 4}:push`, `${BASE + 4}:push`, `${BASE + 4}:push`]);
  });
});

describe("handler: concurrent duplicates", () => {
  it("random batches of simultaneous deliveries, with duplicates and flaky providers, never send a key twice", async () => {
    await fc.assert(
      fc.asyncProperty(eventsArb, failuresArb, fc.integer({ min: 1, max: 4 }), async (events, failArr, copies) => {
        await clean();
        const keys = [...uniqueKeys(events)];
        const failures = new Map<string, number>();
        keys.forEach((k, i) => failures.set(k, failArr[i % failArr.length] === Infinity ? 2 : Math.min(failArr[i % failArr.length], 2)));
        const p = provider(failures, 4);
        const h = new NotificationHandler(pool, p.send, { maxAttempts: 2, backoffMs: 0 });
        const batch = events.flatMap((e) => Array.from({ length: copies }, () => e));
        for (let round = 0; round < 6; round++) {
          const rs = await Promise.allSettled(batch.map((e) => h.handle(ev(e.id, e.type))));
          for (const r of rs) if (r.status === "rejected") expect(r.reason instanceof DeadLetter || r.reason instanceof InFlight, String(r.reason)).toBe(true);
        }
        // every key has at most 2 failures and 2 attempts per handle, so 6 rounds of redelivery always succeed
        expect(new Set(p.ok.keys())).toEqual(new Set(keys));
        for (const [k, n] of p.ok) expect(n, `${k} delivered ${n} times`).toBe(1);
      }),
      { numRuns: 20, seed: SEED }
    );
  }, 90_000);

  it("a fresh lease blocks every other worker; an expired lease is taken over exactly once", async () => {
    await pool.query("INSERT INTO notifications.deliveries (outbox_id, channel, status, updated_at) VALUES ($1,'push','SENDING', now() - interval '5 minutes')", [BASE + 9]);
    const p = provider(new Map(), 5);
    const h = new NotificationHandler(pool, p.send, { leaseMs: 30_000 });
    const rs = await Promise.allSettled(Array.from({ length: 15 }, () => h.handle(ev(9, "payment.failed"))));
    expect(p.ok.get(`${BASE + 9}:push`)).toBe(1);
    for (const r of rs) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(InFlight);
    // a fresh lease from a live worker is respected
    await pool.query("INSERT INTO notifications.deliveries (outbox_id, channel, status) VALUES ($1,'push','SENDING')", [BASE + 10]);
    await expect(h.handle(ev(10, "payment.failed"))).rejects.toBeInstanceOf(InFlight);
    expect(p.calls.has(`${BASE + 10}:push`)).toBe(false);
  });
});

// ---------------- consumer.ts with a fake kafkajs ----------------
const fake = vi.hoisted(() => ({ failSend: false, committed: [] as { partition: number; offset: string }[], ends: [] as { partition: number; offset: string; low: string }[], adminCalls: 0, failAdmin: false, failAdminConnect: false, eachBatch: undefined as undefined | ((a: unknown) => Promise<void>), dlq: [] as { topic: string; messages: { key: unknown; value: string; headers: Record<string, string> }[] }[] }));
vi.mock("kafkajs", () => ({
  Kafka: class {
    consumer() {
      return {
        connect: async () => undefined, disconnect: async () => undefined, subscribe: async () => undefined,
        run: async (cfg: { eachBatch: (a: unknown) => Promise<void> }) => { fake.eachBatch = cfg.eachBatch; }
      };
    }
    admin() {
      return {
        connect: async () => { if (fake.failAdminConnect) throw new Error("admin unreachable"); }, disconnect: async () => { if (fake.failAdminConnect) throw new Error("admin gone"); },
        fetchOffsets: async () => { fake.adminCalls++; if (fake.failAdmin) throw new Error("admin down"); return [{ topic: "payments", partitions: fake.committed }]; },
        fetchTopicOffsets: async () => fake.ends
      };
    }
    producer() { return { connect: async () => undefined, disconnect: async () => undefined, send: async (m: never) => { if (fake.failSend) throw new Error("broker down"); fake.dlq.push(m); } }; }
  }
}));

describe("consumer: dead-letter routing and partition progress (real consumer.ts, fake broker)", () => {
  async function drive(send: Sender, msgs: (string | PaymentEvent)[], opts: { conc?: number } = {}) {
    const { runConsumer } = await import("./consumer");
    fake.dlq.length = 0;
    const h = new NotificationHandler(pool, send, { maxAttempts: 2, backoffMs: 0 });
    const c = await runConsumer(h, { broker: "fake:1", topic: "payments", groupId: "g", concurrency: opts.conc });
    const resolved: string[] = [];
    let commits = 0, beats = 0;
    const messages = msgs.map((m, i) => ({ key: Buffer.from(String(i)), value: Buffer.from(typeof m === "string" ? m : JSON.stringify(m)), offset: String(i) }));
    let error: unknown;
    try {
      await fake.eachBatch!({ batch: { messages }, resolveOffset: (o: string) => resolved.push(o), heartbeat: async () => { beats++; }, commitOffsetsIfNecessary: async () => { commits++; } });
    } catch (e) { error = e; }
    await c.stop();
    return { resolved, commits, beats, error, dlq: fake.dlq.flatMap((d) => d.messages.map((m) => ({ topic: d.topic, value: m.value, key: String(m.key) }))) };
  }

  it("a poison message is published to payments.dlq, every offset is still resolved, and the others are delivered", async () => {
    const p = provider(new Map([[`${BASE + 2}:email`, Infinity]]));
    const msgs = [ev(1, "payment.confirmed"), ev(2, "payment.confirmed"), ev(3, "payment.confirmed")];
    const r = await drive(p.send, msgs);
    expect(r.error).toBeUndefined();
    expect(r.resolved).toEqual(["0", "1", "2"]); // the partition moves past the poison message
    expect(r.dlq).toHaveLength(1);
    expect(r.dlq[0]).toMatchObject({ topic: "payments.dlq", key: "1" });
    expect(JSON.parse(r.dlq[0].value).outboxId).toBe(BASE + 2);
    expect(p.calls.get(`${BASE + 2}:email`)).toBe(2); // maxAttempts, then dead-lettered
    expect(p.ok.size).toBe(5); // 3 x push + 2 x email, the poison email missing
  });

  it("malformed JSON goes to the DLQ verbatim and does not stop the batch", async () => {
    const p = provider(new Map());
    const r = await drive(p.send, ["{not json", ev(5, "payment.failed"), "", "null"]);
    expect(r.resolved).toEqual(["0", "1", "2", "3"]);
    expect(r.dlq.map((d) => d.value)).toContain("{not json");
    expect(p.ok.get(`${BASE + 5}:push`)).toBe(1);
  });

  it("the DLQ counter counts messages that were published, not attempts: a failed publish is redelivered and counted once", async () => {
    const { dlq: counter } = await import("./metrics");
    const value = async () => ((await counter.get()).values[0]?.value ?? 0);
    const before = await value();
    const p = provider(new Map());
    fake.failSend = true;
    try {
      const r1 = await drive(p.send, ["{not json"]);
      expect(r1.error).toBeInstanceOf(Error); // the batch fails and Kafka will redeliver it
      const r2 = await drive(p.send, ["{not json"]);
      expect(r2.error).toBeInstanceOf(Error);
      expect(await value()).toBe(before); // nothing was published, nothing counted
    } finally { fake.failSend = false; }
    await drive(p.send, ["{not json"]);
    expect(await value()).toBe(before + 1);
  });

  it("consumer lag is sampled from the broker on a timer, so it grows while no batch is processed", async () => {
    const { runConsumer } = await import("./consumer");
    const { consumerLag } = await import("./metrics");
    const lagOf = async (partition: string) => (await consumerLag.get()).values.find((v) => v.labels.partition === partition)?.value;
    const h = new NotificationHandler(pool, provider(new Map()).send, { maxAttempts: 2, backoffMs: 0 });
    fake.committed = [{ partition: 7, offset: "100" }];
    fake.ends = [{ partition: 7, offset: "130", low: "0" }];
    const c = await runConsumer(h, { broker: "fake:1", topic: "payments", groupId: "lag", lagSampleMs: 20 });
    try {
      await vi.waitFor(async () => expect(await lagOf("7")).toBe(30));
      fake.ends = [{ partition: 7, offset: "500", low: "0" }]; // the consumer is stalled: no batch arrives, the broker moves on
      await vi.waitFor(async () => expect(await lagOf("7")).toBe(400));
      fake.failAdmin = true; // a failing sample must not stop the consumer or throw
      const calls = fake.adminCalls;
      await vi.waitFor(() => expect(fake.adminCalls).toBeGreaterThan(calls + 1));
    } finally { fake.failAdmin = false; await c.stop(); }
    const after = fake.adminCalls;
    await new Promise((r) => setTimeout(r, 80));
    expect(fake.adminCalls).toBe(after); // stop() ends the sampling
  });

  it("an unreachable admin client does not stop the consumer: it still delivers and stops cleanly", async () => {
    fake.failAdminConnect = true;
    try {
      const p = provider(new Map());
      const r = await drive(p.send, [ev(60, "payment.confirmed")]);
      expect(r.error).toBeUndefined();
      expect(p.ok.get(`${BASE + 60}:push`)).toBe(1);
    } finally { fake.failAdminConnect = false; }
  });

  it("regression: valid JSON that is not a payment event (null, numbers, missing fields) is dead-lettered, not an endless batch failure", async () => {
    const shapes = ["null", "5", "\"s\"", "[]", "{}", "{\"eventType\":\"payment.confirmed\"}", JSON.stringify({ outboxId: BASE + 7, eventType: "payment.confirmed", userId: "u" }), JSON.stringify({ outboxId: "x", eventType: "payment.failed", userId: "u", seatIds: [] })];
    const p = provider(new Map());
    const r = await drive(p.send, [...shapes, ev(8, "payment.failed")]);
    expect(r.error).toBeUndefined();
    expect(r.resolved).toEqual(Array.from({ length: shapes.length + 1 }, (_, i) => String(i)));
    expect(r.dlq.map((d) => d.value)).toEqual(shapes);
    expect(p.ok.get(`${BASE + 8}:push`)).toBe(1);
    expect(p.calls.size).toBe(1);
  });

  it("random batches: DLQ == poison + malformed, delivered == unique non-poison keys, no duplicate effects, all offsets resolved in order", async () => {
    const msgArb = fc.oneof(
      { weight: 6, arbitrary: fc.record({ id: fc.integer({ min: 0, max: 7 }) }).map((x) => ({ kind: "event" as const, id: x.id })) },
      { weight: 1, arbitrary: fc.constantFrom("{", "oops", "[1,", "{\"a\":").map((raw) => ({ kind: "raw" as const, raw })) }
    );
    await fc.assert(
      fc.asyncProperty(fc.array(msgArb, { minLength: 1, maxLength: 16 }), fc.uniqueArray(fc.integer({ min: 0, max: 7 }), { maxLength: 3 }), fc.integer({ min: 1, max: 6 }), async (items, poisonIds, conc) => {
        await clean();
        const poison = new Set(poisonIds);
        const failures = new Map<string, number>();
        for (const id of poison) failures.set(`${BASE + id}:email`, Infinity);
        const p = provider(failures);
        const msgs = items.map((m) => (m.kind === "raw" ? m.raw : ev(m.id, "payment.confirmed")));
        const r = await drive(p.send, msgs, { conc });
        expect(r.error).toBeUndefined();
        expect(r.resolved).toEqual(items.map((_, i) => String(i)));
        expect(r.commits).toBeGreaterThanOrEqual(Math.ceil(items.length / conc));
        const eventIds = new Set(items.flatMap((m) => (m.kind === "event" ? [m.id] : [])));
        for (const id of eventIds) {
          expect(p.ok.get(`${BASE + id}:push`), `push ${id}`).toBe(1);
          expect(p.ok.get(`${BASE + id}:email`), `email ${id}`).toBe(poison.has(id) ? undefined : 1);
        }
        for (const [k, n] of p.ok) expect(n, k).toBe(1);
        const raws = items.filter((m) => m.kind === "raw").length;
        const poisonMsgs = items.filter((m) => m.kind === "event" && poison.has(m.id)).length;
        // every copy of a poison message is dead-lettered (the handler is re-entered for each redelivered copy); raw junk always
        expect(r.dlq.length).toBe(raws + poisonMsgs);
      }),
      { numRuns: 20, seed: SEED }
    );
  }, 120_000);

  it("an infrastructure error (not a DeadLetter) fails the batch so Kafka redelivers it, and no offset is resolved for that chunk", async () => {
    const p = provider(new Map());
    const { runConsumer } = await import("./consumer");
    const broken = new NotificationHandler({ query: async () => { throw new Error("db down"); } } as never, p.send);
    const c = await runConsumer(broken, { broker: "x:1", topic: "payments", groupId: "g" });
    const resolved: string[] = [];
    await expect(fake.eachBatch!({
      batch: { messages: [{ key: null, value: Buffer.from(JSON.stringify(ev(1, "payment.confirmed"))), offset: "0" }] },
      resolveOffset: (o: string) => resolved.push(o), heartbeat: async () => undefined, commitOffsetsIfNecessary: async () => undefined
    })).rejects.toThrow("db down");
    expect(resolved).toEqual([]);
    await c.stop();
  });
});

import { partitionLag } from "./consumer";
describe("partitionLag", () => {
  it("is end offset minus committed offset, never negative, and counts from the low watermark when nothing is committed", () => {
    const lag = partitionLag(
      [{ partition: 0, offset: "7" }, { partition: 1, offset: "-1" }, { partition: 3, offset: "50" }],
      [{ partition: 0, offset: "10", low: "0" }, { partition: 1, offset: "20", low: "5" }, { partition: 2, offset: "4", low: "0" }, { partition: 3, offset: "40", low: "0" }]
    );
    expect(Object.fromEntries(lag)).toEqual({ 0: 3, 1: 15, 2: 4, 3: 0 });
  });
});
