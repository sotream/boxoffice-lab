import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureBuilt, freePort, RunningService, spawnService, waitHealthy } from "@boxoffice/platform";
import { createPool } from "./db";

const pkg = join(__dirname, "..");
const EVENT = 987001; // own event id: this test never touches the seats other tests use
const pool = createPool(3);
const live: RunningService[] = [];
afterEach(() => { for (const s of live.splice(0)) s.child.kill("SIGKILL"); });
afterAll(async () => { await pool.query("DELETE FROM seats WHERE event_id=$1", [EVENT]); await pool.end(); });
beforeAll(async () => {
  ensureBuilt(pkg);
  const { migrate } = await import("./db");
  await migrate(pool);
  await pool.query("DELETE FROM seats WHERE event_id=$1", [EVENT]);
  await pool.query("INSERT INTO seats (event_id, seat_id) SELECT $1, g FROM generate_series(1, 20) g", [EVENT]);
}, 60_000);

const start = async (env: Record<string, string> = {}) => {
  const port = await freePort();
  const svc = spawnService(pkg, { PORT: String(port), ...env });
  live.push(svc);
  const base = `http://127.0.0.1:${port}`;
  await waitHealthy(base);
  return { svc, base };
};
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("inventory process: ops endpoints", () => {
  it("/healthz, /readyz and /metrics; hold results are counted by strategy and result", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect((await ready.json()).checks.postgres.ok).toBe(true);

    const rid = "e2e-inventory-1";
    const ok = await fetch(`${base}/events/${EVENT}/holds`, { method: "POST", headers: { "content-type": "application/json", "x-request-id": rid }, body: JSON.stringify({ seatIds: [1], userId: "u1" }) });
    expect(ok.status).toBe(201);
    expect(ok.headers.get("x-request-id")).toBe(rid);
    expect((await post(`${base}/events/${EVENT}/holds`, { seatIds: [1], userId: "u2" })).status).toBe(409);
    expect((await post(`${base}/events/${EVENT}/holds?strategy=for-update`, { seatIds: [2], userId: "u3" })).status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));

    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toContain('inventory_holds_total{strategy="atomic-update",result="ok",service="inventory"} 1');
    expect(text).toContain('inventory_holds_total{strategy="atomic-update",result="conflict",service="inventory"} 1');
    expect(text).toContain('inventory_holds_total{strategy="for-update",result="ok",service="inventory"} 1');
    expect(text).toMatch(/http_requests_total\{method="POST",route="\/events\/:eventId\/holds",status_class="2xx",service="inventory"\} 2/);
    expect(text).toMatch(/pg_pool_total_connections\{pool="main",service="inventory"\}/);
    expect(text).not.toContain(`/events/${EVENT}`);
    expect(text).not.toContain("u1");
  }, 30_000);

  it("an unreachable database at boot makes the process exit non-zero instead of serving", async () => {
    const bad = spawnService(pkg, { PORT: String(await freePort()), DATABASE_URL: "postgres://lab:lab@localhost:1/lab" });
    live.push(bad);
    expect((await bad.exited).code).not.toBe(0);
  }, 30_000);

  it("SIGTERM while a hold is blocked on a row lock: the request completes, the process exits 0", async () => {
    const { svc, base } = await start();
    const locker = await pool.connect();
    await locker.query("BEGIN");
    await locker.query("SELECT 1 FROM seats WHERE event_id=$1 AND seat_id=10 FOR UPDATE", [EVENT]);
    const inflight = post(`${base}/events/${EVENT}/holds`, { seatIds: [10], userId: "u-drain" }); // blocks on the lock
    await new Promise((r) => setTimeout(r, 300));
    svc.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    await locker.query("ROLLBACK"); locker.release();
    const res = await inflight;
    expect(res.status).toBe(201);
    const exit = await svc.exited;
    expect(svc.output(), "process output").toContain("shutdown complete");
    expect(exit.code).toBe(0);
    expect(svc.output()).toContain("shutdown complete");
  }, 40_000);
});
