import { describe, expect, it } from "vitest";
import { contextFromHeaders, currentContext, formatTraceparent, outgoingHeaders, parseTraceparent, runWithContext, traceFields } from "./context";

const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("trace context", () => {
  it("parses and formats a valid traceparent, rejects malformed ones", () => {
    expect(parseTraceparent(TP)).toEqual({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", flags: "01" });
    expect(formatTraceparent(parseTraceparent(TP)!)).toBe(TP);
    for (const bad of ["", "garbage", "00-" + "0".repeat(32) + "-00f067aa0ba902b7-01", "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", "00-4bf92f3577b34da6a3ce929d0e0e4736-" + "0".repeat(16) + "-01"]) {
      expect(parseTraceparent(bad)).toBeNull();
    }
  });

  it("generates a trace root when nothing is supplied", () => {
    const c = contextFromHeaders({});
    expect(c.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(c.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(c.parentSpanId).toBeUndefined();
    expect(c.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps the caller's request id and trace id, makes a child span", () => {
    const c = contextFromHeaders({ "x-request-id": "req-123", traceparent: TP });
    expect(c.requestId).toBe("req-123");
    expect(c.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(c.parentSpanId).toBe("00f067aa0ba902b7");
    expect(c.spanId).not.toBe("00f067aa0ba902b7");
  });

  it("does not trust a hostile request id (log injection, huge value)", () => {
    expect(contextFromHeaders({ "x-request-id": 'a"\nb' }).requestId).not.toContain("\n");
    expect(contextFromHeaders({ "x-request-id": "x".repeat(500) }).requestId).toHaveLength(36);
  });

  it("outgoingHeaders carry this hop's span as the parent of the next hop; empty outside a request", () => {
    expect(outgoingHeaders()).toEqual({});
    const c = contextFromHeaders({ "x-request-id": "r1", traceparent: TP });
    runWithContext(c, () => {
      expect(currentContext()).toBe(c);
      const h = outgoingHeaders();
      expect(h["x-request-id"]).toBe("r1");
      expect(parseTraceparent(h.traceparent)).toMatchObject({ traceId: c.traceId, spanId: c.spanId });
      expect(traceFields()).toEqual({ requestId: "r1", traceparent: h.traceparent });
    });
  });

  it("the context follows async continuations", async () => {
    const c = contextFromHeaders({});
    await runWithContext(c, async () => { await new Promise((r) => setTimeout(r, 5)); expect(currentContext()?.requestId).toBe(c.requestId); });
  });
});
