import { describe, expect, it } from "vitest";
import { Readiness, register } from "@boxoffice/platform";
import { signAdmission } from "@boxoffice/admission";
import { buildApp } from "./app";
import { GatewayService } from "./gateway.service";
import { RateLimiter } from "./rate-limiter";

const secret = "s";
const limiter = (allowed: boolean | "throw") => ({ take: async () => { if (allowed === "throw") throw new Error("redis down"); return { allowed, remaining: 0 }; } }) as unknown as RateLimiter;
const make = (ip: RateLimiter, user: RateLimiter, calls: { url: string; headers: Record<string, string> }[] = [], fail?: Error) =>
  new GatewayService({ inventoryUrl: "http://inv", queueUrl: "http://q", secret }, ip, user, async (url, init) => { calls.push({ url, headers: init.headers }); if (fail) throw fail; return { status: 200, body: "{}" }; });
const counterValue = async (name: string, labels: Record<string, string>) => {
  const m = (await register.getMetricsAsJSON()).find((x) => x.name === name) as any;
  return m?.values.filter((v: any) => Object.entries(labels).every(([k, x]) => v.labels[k] === x)).reduce((s: number, v: any) => s + v.value, 0) ?? 0;
};

describe("gateway ops endpoints", () => {
  const app = buildApp(make(limiter(true), limiter(true)));
  it("/healthz is 200", async () => { expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200); });
  it("/readyz is 200 with no critical dependency down, 503 when one is", async () => {
    expect((await app.inject({ url: "/readyz" })).statusCode).toBe(200);
    const bad = buildApp(make(limiter(true), limiter(true)), [], { readiness: new Readiness([{ name: "redis", run: async () => { throw new Error("down"); } }]) });
    const res = await bad.inject({ url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.redis.ok).toBe(false);
  });
  it("/metrics exposes RED metrics with the route pattern, not the raw path", async () => {
    await app.inject({ url: "/events/42/availability" });
    await new Promise((r) => setTimeout(r, 20));
    const text = (await app.inject({ url: "/metrics" })).body;
    expect(text).toContain('http_requests_total{method="GET",route="/events/:eventId/availability",status_class="2xx"');
    expect(text).not.toContain("/events/42");
  });
  it("the fast path is unaffected: ops routes do not shadow journey routes and unknown paths still 404 as 'unmatched'", async () => {
    expect((await app.inject({ url: "/events/1/availability" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/admin" })).statusCode).toBe(404);
  });
});

describe("gateway correlation headers", () => {
  it("propagates request id and traceparent upstream with the gateway's own span, and creates a trace when absent", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const app = buildApp(make(limiter(true), limiter(true), calls));
    await app.inject({ url: "/events/1/availability", headers: { "x-request-id": "rid-7", traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" } });
    const h = calls[0].headers;
    expect(h["x-request-id"]).toBe("rid-7");
    expect(h.traceparent).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
    expect(h.traceparent).not.toContain("00f067aa0ba902b7"); // the gateway's own span, not the caller's

    await app.inject({ url: "/events/1/availability" });
    expect(calls[1].headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1].headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});

describe("x-forwarded-for towards upstream", () => {
  const send = async (trusted: string[], headers: Record<string, string>) => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    await buildApp(make(limiter(true), limiter(true), calls), trusted).inject({ url: "/events/1/availability", remoteAddress: "10.0.0.9", headers });
    return calls[0].headers["x-forwarded-for"];
  };
  it("untrusted peer: the client-supplied chain is dropped, the socket address is sent", async () => {
    expect(await send([], { "x-forwarded-for": "6.6.6.6, 7.7.7.7" })).toBe("10.0.0.9");
    expect(await send(["192.168.0.0/16"], { "x-forwarded-for": "6.6.6.6" })).toBe("10.0.0.9");
  });
  it("trusted peer: the chain is kept and the peer is appended, not overwritten", async () => {
    expect(await send(["10.0.0.0/8"], { "x-forwarded-for": "6.6.6.6" })).toBe("6.6.6.6, 10.0.0.9");
    expect(await send(["10.0.0.0/8"], { "x-forwarded-for": "6.6.6.6, 10.1.1.1" })).toBe("6.6.6.6, 10.1.1.1, 10.0.0.9");
  });
  it("trusted peer without a chain: just the peer", async () => {
    expect(await send(["10.0.0.0/8"], {})).toBe("10.0.0.9");
  });
});

describe("gateway business metrics", () => {
  it("counts limiter decisions: allowed, limited, fail_open, fail_closed", async () => {
    const t = signAdmission("u", 1, 60, secret);
    const d = (limiter: string, decision: string) => counterValue("gateway_limiter_decisions_total", { limiter, decision });
    const before = { a: await d("ip", "allowed"), l: await d("ip", "limited"), fo: await d("ip", "fail_open"), fc: await d("user", "fail_closed") };
    await make(limiter(true), limiter(true)).handle("GET", "/events/1/availability", "", undefined, "i");
    await make(limiter(false), limiter(true)).handle("GET", "/events/1/availability", "", undefined, "i");
    await make(limiter("throw"), limiter(true)).handle("GET", "/events/1/availability", "", undefined, "i");
    await make(limiter(true), limiter("throw")).handle("POST", "/events/1/holds", "", "{}", "i", t);
    expect(await d("ip", "allowed")).toBe(before.a + 1);
    expect(await d("ip", "limited")).toBe(before.l + 1);
    expect(await d("ip", "fail_open")).toBe(before.fo + 1);
    expect(await d("user", "fail_closed")).toBe(before.fc + 1);
  });

  it("counts upstream timeouts separately from unreachable upstreams", async () => {
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    const before = await counterValue("gateway_upstream_errors_total", { upstream: "inventory", reason: "timeout" });
    expect((await make(limiter(true), limiter(true), [], timeout).handle("GET", "/events/1/availability", "", undefined, "i")).status).toBe(504);
    expect(await counterValue("gateway_upstream_errors_total", { upstream: "inventory", reason: "timeout" })).toBe(before + 1);
    const b2 = await counterValue("gateway_upstream_errors_total", { upstream: "queue", reason: "unreachable" });
    await make(limiter(true), limiter(true), [], new Error("ECONNREFUSED")).handle("POST", "/events/1/queue/join", "", "{}", "i");
    expect(await counterValue("gateway_upstream_errors_total", { upstream: "queue", reason: "unreachable" })).toBe(b2 + 1);
  });

  it("admission rejections are counted", async () => {
    const before = await counterValue("gateway_admission_rejected_total", {});
    await make(limiter(true), limiter(true)).handle("POST", "/events/1/holds", "", "{}", "i");
    expect(await counterValue("gateway_admission_rejected_total", {})).toBe(before + 1);
  });
});
