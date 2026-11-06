import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { Readiness, tcpCheck } from "./health";

describe("Readiness", () => {
  it("is ready when all checks pass, with per-dependency detail", async () => {
    const r = new Readiness([{ name: "postgres", run: async () => 1 }, { name: "redis", run: async () => 1 }]);
    const res = await r.evaluate();
    expect(res.ok).toBe(true);
    expect(res.body.status).toBe("ready");
    expect(Object.keys(res.body.checks)).toEqual(["postgres", "redis"]);
  });

  it("a failing critical dependency makes it not ready and names the culprit", async () => {
    const r = new Readiness([{ name: "postgres", run: async () => { throw new Error("ECONNREFUSED"); } }, { name: "redis", run: async () => 1 }]);
    const res = await r.evaluate();
    expect(res.ok).toBe(false);
    expect(res.body.checks.postgres).toMatchObject({ ok: false, error: "ECONNREFUSED" });
    expect(res.body.checks.redis.ok).toBe(true);
  });

  it("a failing non-critical dependency is reported but the service stays ready", async () => {
    const r = new Readiness([{ name: "redis", critical: false, run: async () => { throw new Error("down"); } }]);
    const res = await r.evaluate();
    expect(res.ok).toBe(true);
    expect(res.body.checks.redis.ok).toBe(false);
  });

  it("a hanging dependency times out instead of hanging the probe", async () => {
    const r = new Readiness([{ name: "kafka", run: () => new Promise(() => undefined) }], { timeoutMs: 50 });
    const t0 = Date.now();
    const res = await r.evaluate();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(res.ok).toBe(false);
    expect(res.body.checks.kafka.error).toMatch(/timed out/);
  });

  it("draining makes it not ready without calling dependencies", async () => {
    let calls = 0;
    const r = new Readiness([{ name: "p", run: async () => { calls++; } }]);
    r.setDraining();
    const res = await r.evaluate();
    expect(res).toMatchObject({ ok: false, body: { status: "shutting_down" } });
    expect(calls).toBe(0);
  });

  it("caches the result for cacheMs", async () => {
    let calls = 0;
    const r = new Readiness([{ name: "p", run: async () => { calls++; } }], { cacheMs: 1000 });
    await r.evaluate(); await r.evaluate();
    expect(calls).toBe(1);
  });

  it("tcpCheck: a blackholed address fails after the timeout instead of hanging", async () => {
    const t0 = Date.now();
    await expect(tcpCheck("10.255.255.1:9", "k", true, 150).run()).rejects.toThrow(/timed out|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED/);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("tcpCheck: open port passes, closed port fails", async () => {
    const srv = createServer((s) => s.destroy());
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as any).port;
    await expect(tcpCheck(`127.0.0.1:${port}`, "k").run()).resolves.toBeUndefined();
    await new Promise((r) => srv.close(r));
    await expect(tcpCheck(`127.0.0.1:${port}`, "k").run()).rejects.toBeTruthy();
  });
});
