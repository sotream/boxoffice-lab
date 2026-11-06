import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { currentContext } from "./context";
import { Readiness } from "./health";
import { instrumentFastify, registerOpsRoutes } from "./http";
import { register } from "./metrics";

const build = (ready = new Readiness([])) => {
  const app = Fastify();
  instrumentFastify(app);
  registerOpsRoutes(app, { readiness: ready });
  app.get("/events/:id/availability", async (req) => ({ id: (req.params as any).id, ctx: currentContext() }));
  app.get("/boom", async () => { throw new Error("boom"); });
  app.get("/slow", async () => { await new Promise((r) => setTimeout(r, 30)); return {}; });
  return app;
};
const val = async (name: string, labels: Record<string, string>) => {
  const m = (await register.getMetricsAsJSON()).find((x) => name === x.name || name.startsWith(x.name + "_")) as any;
  return m?.values.filter((v: any) => (v.metricName ?? m.name) === name && Object.entries(labels).every(([k, x]) => v.labels[k] === x)).reduce((s: number, v: any) => s + v.value, 0) ?? 0;
};
const closed = () => new Promise((r) => setTimeout(r, 20)); // 'close' on the raw response fires just after inject resolves

describe("instrumentFastify", () => {
  it("generates a request id and a trace root, exposes them to the handler and echoes the request id", async () => {
    const app = build();
    const res = await app.inject({ url: "/events/1/availability" });
    const ctx = res.json().ctx;
    expect(res.headers["x-request-id"]).toBe(ctx.requestId);
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("continues the caller's request id and trace and creates a child span", async () => {
    const app = build();
    const res = await app.inject({ url: "/events/1/availability", headers: { "x-request-id": "abc-1", traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" } });
    expect(res.headers["x-request-id"]).toBe("abc-1");
    const ctx = res.json().ctx;
    expect(ctx).toMatchObject({ requestId: "abc-1", traceId: "4bf92f3577b34da6a3ce929d0e0e4736", parentSpanId: "00f067aa0ba902b7" });
    expect(ctx.spanId).not.toBe("00f067aa0ba902b7");
  });

  it("counts by route pattern (not raw path), status class, and observes duration", async () => {
    const app = build();
    const before = await val("http_requests_total", { route: "/events/:id/availability", status_class: "2xx" });
    await app.inject({ url: "/events/1/availability" });
    await app.inject({ url: "/events/2/availability" });
    await app.inject({ url: "/boom" });
    await app.inject({ url: "/nope/123456" });
    await closed();
    expect(await val("http_requests_total", { route: "/events/:id/availability", status_class: "2xx" })).toBe(before + 2);
    expect(await val("http_requests_total", { route: "/boom", status_class: "5xx" })).toBeGreaterThanOrEqual(1);
    expect(await val("http_requests_total", { route: "unmatched", status_class: "4xx" })).toBeGreaterThanOrEqual(1);
    const text = await register.metrics();
    expect(text).not.toContain("/events/1/");
    expect(text).not.toContain("123456");
    expect(await val("http_request_duration_seconds_count", { route: "/events/:id/availability" })).toBeGreaterThanOrEqual(2);
  });

  it("in-flight gauge rises during a request and returns to zero", async () => {
    const app = build();
    const p = app.inject({ url: "/slow" });
    await new Promise((r) => setTimeout(r, 10));
    expect(await val("http_requests_in_flight", {})).toBe(1);
    await p; await closed();
    expect(await val("http_requests_in_flight", {})).toBe(0);
  });

  it("probe endpoints are not counted as traffic", async () => {
    const app = build();
    await app.inject({ url: "/healthz" }); await app.inject({ url: "/readyz" }); await app.inject({ url: "/metrics" });
    await closed();
    expect(await val("http_requests_total", { route: "/healthz" })).toBe(0);
    expect(await val("http_requests_total", { route: "/metrics" })).toBe(0);
  });
});

describe("registerOpsRoutes", () => {
  it("/healthz is 200 and calls no dependency", async () => {
    let calls = 0;
    const app = build(new Readiness([{ name: "p", run: async () => { calls++; } }]));
    const res = await app.inject({ url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(calls).toBe(0);
  });

  it("/readyz is 200 when ready and 503 with a per-dependency body when not", async () => {
    let up = true;
    const app = build(new Readiness([{ name: "postgres", run: async () => { if (!up) throw new Error("down"); } }]));
    expect((await app.inject({ url: "/readyz" })).statusCode).toBe(200);
    up = false;
    const res = await app.inject({ url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "not_ready", checks: { postgres: { ok: false, error: "down" } } });
  });

  it("/metrics serves Prometheus text including the service default label", async () => {
    const { initMetrics } = await import("./metrics");
    initMetrics("platform-test");
    const res = await build().inject({ url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("# TYPE http_request_duration_seconds histogram");
    expect(res.body).toContain('service="platform-test"');
  });
});
