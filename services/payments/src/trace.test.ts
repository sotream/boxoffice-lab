import { contextFromHeaders, createPool as createSharedPool, createScratchDatabase, runWithContext } from "@boxoffice/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./db";
import { PaymentsService } from "./payments.service";
import { FakePsp } from "./psp";
import { stateLabel } from "./metrics";
import { traceHeaders } from "./outbox-relay";

// Private database: the shared outbox is drained by other tests' relays.
let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let pool: ReturnType<typeof createSharedPool>;
beforeAll(async () => { scratch = await createScratchDatabase("ops_trace"); pool = createSharedPool({ connectionString: scratch.url, max: 5 }); await migrate(pool); });
afterAll(async () => { await pool.end(); await scratch.drop(); });

const outboxPayloads = async () => (await pool.query("SELECT payload FROM payments.outbox ORDER BY id")).rows.map((r) => r.payload);
const req = (key: string) => ({ idempotencyKey: key, eventId: 1, userId: "u", seatIds: [1], amountCents: 100 });

describe("outbox trace carry-over", () => {
  it("the event carries the trace of the request that created the payment", async () => {
    const ctx = contextFromHeaders({ "x-request-id": "rid-outbox" });
    const svc = new PaymentsService(pool, new FakePsp(), async () => true);
    await runWithContext(ctx, () => svc.pay(req("trace-1")));
    const [p] = await outboxPayloads();
    expect(p.trace.requestId).toBe("rid-outbox");
    expect(p.trace.traceparent).toContain(ctx.traceId);
  });

  it("a saga finished later by the sweeper (after a 202, outside any request) keeps the original trace", async () => {
    await pool.query("TRUNCATE payments.payments, payments.outbox RESTART IDENTITY");
    const psp = new FakePsp(300);
    const svc = new PaymentsService(pool, psp, async () => true, 50);
    const ctx = contextFromHeaders({ "x-request-id": "rid-slow" });
    const r = await runWithContext(ctx, () => svc.pay(req("trace-2")));
    expect(r.kind).toBe("in-progress");
    psp.latencyMs = 0;
    await pool.query("UPDATE payments.payments SET updated_at = now() - interval '10 seconds'");
    await svc.sweep(3); // no request context here
    const [p] = await outboxPayloads();
    expect(p.eventType).toBe("payment.confirmed");
    expect(p.trace.requestId).toBe("rid-slow");
  });

  it("without any context no trace key is written", async () => {
    await pool.query("TRUNCATE payments.payments, payments.outbox RESTART IDENTITY");
    await new PaymentsService(pool, new FakePsp(), async () => true).pay(req("trace-3"));
    expect((await outboxPayloads())[0].trace).toBeUndefined();
  });

  it("traceHeaders maps the payload trace to Kafka headers and ignores payloads without it", () => {
    expect(traceHeaders({ trace: { requestId: "r", traceparent: "00-a-b-01" } })).toEqual({ "x-request-id": "r", traceparent: "00-a-b-01" });
    expect(traceHeaders({ eventType: "x" })).toBeUndefined();
    expect(traceHeaders({ trace: { requestId: 5 } })).toBeUndefined();
    expect(traceHeaders(null)).toBeUndefined();
  });

  it("saga state label is bounded", () => {
    expect(stateLabel("CONFIRMED")).toBe("CONFIRMED");
    expect(stateLabel("REFUNDING")).toBe("REFUNDING");
    expect(stateLabel("whatever-123")).toBe("other");
  });
});
