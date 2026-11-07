import { mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createPool, DEFAULT_DATABASE_URL, migrate } from "./pool";
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

  it("a checked-out client whose backend is terminated does not crash the process", async () => {
    const admin = mk({ max: 1 });
    const p = mk({ max: 2 });
    const unhandled: unknown[] = [];
    const h = (e: unknown) => unhandled.push(e);
    process.on("uncaughtException", h);
    try {
      const client = await p.connect();
      await client.query("BEGIN");
      const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      await new Promise((r) => setTimeout(r, 300));
      await expect(client.query("SELECT 1")).rejects.toBeTruthy();
      client.release(true);
      expect(unhandled).toEqual([]);
      expect((await p.query("SELECT 1 AS ok")).rows[0].ok).toBe(1);
    } finally {
      process.off("uncaughtException", h);
    }
  });

  it("migrate runs files in name order with the statement timeout off, then restores it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(dir, "002_b.sql"), "INSERT INTO m_order SELECT 2, current_setting('statement_timeout');");
    writeFileSync(join(dir, "001_a.sql"), "CREATE TEMP TABLE m_order(n int, t text); INSERT INTO m_order SELECT 1, current_setting('statement_timeout');");
    writeFileSync(join(dir, "README.txt"), "ignored");
    const p = mk({ max: 1, statementTimeoutMs: 5000 });
    await migrate(p, dir, `unit-${Date.now()}-order`);
    expect((await p.query("SELECT n, t FROM m_order ORDER BY n")).rows).toEqual([{ n: 1, t: "0" }, { n: 2, t: "0" }]);
    expect((await p.query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("5s");
  });
});

describe("migrate tracking", () => {
  const dirWith = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    for (const [n, sql] of Object.entries(files)) writeFileSync(join(dir, n), sql);
    return dir;
  };

  it("applies each file once: a non-idempotent migration is not replayed on the next boot", async () => {
    const scope = `unit-${Date.now()}-once`;
    const table = `mig_once_${Date.now()}`;
    const dir = dirWith({ "001.sql": `CREATE TABLE public.${table}(n int); INSERT INTO public.${table} VALUES (1);` });
    const p = mk({ max: 2 });
    try {
      await migrate(p, dir, scope);
      await migrate(p, dir, scope); // plain CREATE TABLE would fail here if it ran again
      expect((await p.query(`SELECT count(*)::int c FROM public.${table}`)).rows[0].c).toBe(1);
    } finally { await p.query(`DROP TABLE IF EXISTS public.${table}`); await p.query("DELETE FROM public.schema_migrations WHERE scope=$1", [scope]); }
  });

  it("a failing file leaves no record and is retried", async () => {
    const scope = `unit-${Date.now()}-fail`;
    const dir = dirWith({ "001.sql": "SELECT 1/0;" });
    const p = mk({ max: 2 });
    await expect(migrate(p, dir, scope)).rejects.toThrow();
    expect((await p.query("SELECT count(*)::int c FROM public.schema_migrations WHERE scope=$1", [scope])).rows[0].c).toBe(0);
    writeFileSync(join(dir, "001.sql"), "SELECT 1;");
    await migrate(p, dir, scope);
    expect((await p.query("SELECT count(*)::int c FROM public.schema_migrations WHERE scope=$1", [scope])).rows[0].c).toBe(1);
    await p.query("DELETE FROM public.schema_migrations WHERE scope=$1", [scope]);
  });

  it("editing a file that was already applied is an error, and a record from before checksums is backfilled", async () => {
    const scope = `unit-${Date.now()}-sum`;
    const dir = dirWith({ "001.sql": "SELECT 1;" });
    const p = mk({ max: 2 });
    try {
      await migrate(p, dir, scope);
      await p.query("UPDATE public.schema_migrations SET checksum=NULL WHERE scope=$1", [scope]); // what an earlier version of migrate left behind
      await migrate(p, dir, scope);
      expect((await p.query("SELECT checksum FROM public.schema_migrations WHERE scope=$1", [scope])).rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
      writeFileSync(join(dir, "001.sql"), "SELECT 2;");
      await expect(migrate(p, dir, scope)).rejects.toThrow(/changed after it was applied/);
    } finally { await p.query("DELETE FROM public.schema_migrations WHERE scope=$1", [scope]); }
  });

  it("a connection whose advisory lock could not be released is destroyed, not returned to the pool", async () => {
    const released: unknown[] = [];
    const client = {
      query: async (sql: string) => { if (/pg_advisory_unlock/.test(sql)) throw new Error("connection lost"); return { rows: [], rowCount: 0 }; },
      release: (err?: unknown) => { released.push(err); }
    };
    await migrate({ connect: async () => client } as never, dirWith({}), "unit-unlock");
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
  });

  it("instances booting at the same time do not race (advisory lock)", async () => {
    const scope = `unit-${Date.now()}-race`;
    const table = `mig_race_${Date.now()}`;
    const dir = dirWith({ "001.sql": `CREATE TABLE public.${table}(n int); INSERT INTO public.${table} VALUES (1);` });
    const pools = Array.from({ length: 6 }, () => mk({ max: 1 }));
    try {
      await Promise.all(pools.map((p) => migrate(p, dir, scope)));
      expect((await pools[0].query(`SELECT count(*)::int c FROM public.${table}`)).rows[0].c).toBe(1);
    } finally { await pools[0].query(`DROP TABLE IF EXISTS public.${table}`); await pools[0].query("DELETE FROM public.schema_migrations WHERE scope=$1", [scope]); }
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

/** A TCP relay to Postgres that can go silent: from then on it swallows both directions and closes nothing (a partition without RST/FIN). */
async function silentRelay(): Promise<{ url: string; silence(): void; heal(): void; open(): number; close(): Promise<void> }> {
  const target = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  let silent = false;
  const socks = new Set<net.Socket>();
  const server = net.createServer((c) => {
    const up = net.connect(Number(target.port), target.hostname);
    socks.add(c); socks.add(up);
    const drop = () => { c.destroy(); up.destroy(); socks.delete(c); socks.delete(up); };
    c.on("error", drop); up.on("error", drop); c.on("close", drop); up.on("close", drop);
    c.on("data", (d) => { if (!silent) up.write(d); });
    up.on("data", (d) => { if (!silent) c.write(d); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  const u = new URL(target.toString());
  u.hostname = "127.0.0.1"; u.port = String(port);
  return {
    url: u.toString(),
    silence: () => { silent = true; },
    heal: () => { silent = false; },
    open: () => [...socks].filter((s) => !s.destroyed).length / 2,
    close: async () => { for (const s of socks) s.destroy(); await new Promise<void>((r) => server.close(() => r())); }
  };
}

describe("client-side query timeout on a silent connection", () => {
  it("defaults to the statement timeout plus 1 s and is off when the statement timeout is off", () => {
    expect((mk().options as { query_timeout?: number }).query_timeout).toBe(6000);
    expect((mk({ statementTimeoutMs: 0 }).options as { query_timeout?: number }).query_timeout).toBeUndefined();
    expect((mk({ statementTimeoutMs: 100, queryTimeoutMs: 250 }).options as { query_timeout?: number }).query_timeout).toBe(250);
  });

  it("pool.query rejects after about the timeout, the broken connection is gone and the next query works", async () => {
    const relay = await silentRelay();
    try {
      const p = mk({ max: 1, statementTimeoutMs: 400, queryTimeoutMs: 700, connectionString: relay.url });
      expect((await p.query("SELECT 1 AS ok")).rows[0].ok).toBe(1);
      expect(p.totalCount).toBe(1);
      relay.silence();
      const t0 = Date.now();
      await expect(p.query("SELECT 2")).rejects.toThrow(/Query read timeout/);
      const ms = Date.now() - t0;
      expect(ms).toBeGreaterThanOrEqual(650);
      expect(ms).toBeLessThan(1500);
      await new Promise((r) => setTimeout(r, 100));
      expect(p.totalCount, "the timed-out connection must have been removed").toBe(0);
      expect(relay.open(), "its socket must be closed, not left open").toBe(0);
      relay.heal();
      expect((await p.query("SELECT 3 AS ok")).rows[0].ok).toBe(3);
      expect(p.totalCount).toBe(1);
    } finally { await relay.close(); }
  });

  it("a client from pool.connect() whose query timed out is discarded even when the caller releases it without an error", async () => {
    const relay = await silentRelay();
    try {
      const p = mk({ max: 1, statementTimeoutMs: 400, queryTimeoutMs: 700, connectionString: relay.url });
      const c = await p.connect();
      await c.query("BEGIN");
      relay.silence();
      await expect(c.query("UPDATE pg_class SET relname=relname WHERE false")).rejects.toThrow(/Query read timeout/);
      // what the services do on a failed transaction: ROLLBACK (fails too), then release() with no argument
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
      relay.heal();
      const t0 = Date.now();
      expect((await p.query("SELECT 4 AS ok")).rows[0].ok).toBe(4);
      expect(Date.now() - t0, "the next query must not wait behind the hung connection").toBeLessThan(500);
      expect(p.totalCount).toBe(1);
    } finally { await relay.close(); }
  });

  it("a caller waiting for the only connection gets a fresh one as soon as the hung one is discarded", async () => {
    const relay = await silentRelay();
    try {
      const p = mk({ max: 1, statementTimeoutMs: 400, queryTimeoutMs: 700, connectionTimeoutMs: 5000, connectionString: relay.url });
      await p.query("SELECT 1");
      relay.silence();
      const hung = p.query("SELECT 2").catch((e) => e as Error);
      await new Promise((r) => setTimeout(r, 50));
      relay.heal(); // new connections work again; the old socket's data is lost
      const t0 = Date.now();
      const next = await p.query("SELECT 5 AS ok");
      expect(next.rows[0].ok).toBe(5);
      expect((await hung).message).toMatch(/Query read timeout/);
      expect(Date.now() - t0).toBeLessThan(1800);
    } finally { await relay.close(); }
  });
});
