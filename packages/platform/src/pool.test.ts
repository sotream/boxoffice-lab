import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createPool, migrate } from "./pool";
import { POOL_IDLE, POOL_TOTAL, POOL_WAITING, register, registerPoolMetrics } from "./metrics";

const pools: ReturnType<typeof createPool>[] = [];
const mk = (o = {}) => { const p = createPool(o); pools.push(p); return p; };
afterAll(async () => { await Promise.all(pools.map((p) => p.end())); });

describe("createPool", () => {
  it("applies the options: statement timeout, application_name, max", async () => {
    const p = mk({ max: 3, statementTimeoutMs: 1234, applicationName: "platform-test" });
    const r = await p.query("SHOW statement_timeout; ");
    expect(r.rows[0].statement_timeout).toBe("1234ms");
    expect((await p.query("SHOW application_name")).rows[0].application_name).toBe("platform-test");
    expect(p.options.max).toBe(3);
  });

  it("defaults to a 5 s statement timeout and 0 disables it", async () => {
    expect((await mk().query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("5s");
    expect((await mk({ statementTimeoutMs: 0 }).query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("0");
  });

  it("an idle client error is handled and does not crash the process", async () => {
    const p = mk({ max: 1 });
    const client = await p.connect();
    client.release();
    const unhandled: unknown[] = [];
    const h = (e: unknown) => unhandled.push(e);
    process.on("uncaughtException", h);
    // Simulate the server dropping the idle connection: pg emits 'error' on the pool for idle clients.
    (client as any).emit("error", new Error("terminating connection"));
    await new Promise((r) => setTimeout(r, 20));
    process.off("uncaughtException", h);
    expect(unhandled).toHaveLength(0);
    expect(p.listenerCount("error")).toBeGreaterThan(0);
  });

  it("migrate runs files in name order with the statement timeout off, then restores it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(dir, "002_b.sql"), "INSERT INTO m_order SELECT 2, current_setting('statement_timeout');");
    writeFileSync(join(dir, "001_a.sql"), "CREATE TEMP TABLE m_order(n int, t text); INSERT INTO m_order SELECT 1, current_setting('statement_timeout');");
    writeFileSync(join(dir, "README.txt"), "ignored");
    const p = mk({ max: 1, statementTimeoutMs: 5000 });
    await migrate(p, dir);
    expect((await p.query("SELECT n, t FROM m_order ORDER BY n")).rows).toEqual([{ n: 1, t: "0" }, { n: 2, t: "0" }]);
    expect((await p.query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("5s");
  });
});

describe("registerPoolMetrics", () => {
  it("exposes total, idle and waiting per pool, bounded by pool name", async () => {
    const p = mk({ max: 2 });
    registerPoolMetrics(p, "unit");
    const a = await p.connect(), b = await p.connect();
    const waiting = p.connect();
    await new Promise((r) => setTimeout(r, 10));
    const get = async (n: string) => ((await register.getMetricsAsJSON()).find((m) => m.name === n) as any).values.find((v: any) => v.labels.pool === "unit").value;
    expect(await get(POOL_TOTAL)).toBe(2);
    expect(await get(POOL_IDLE)).toBe(0);
    expect(await get(POOL_WAITING)).toBe(1);
    a.release(); b.release(); (await waiting).release();
  });
});
