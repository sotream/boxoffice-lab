import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureBuilt, freePort, RunningService, signInternalRequest, spawnService, waitHealthy } from "@boxoffice/platform";
import { createPool } from "./db";

const pkg = join(__dirname, "..");
const TOKEN = "ops-e2e-inventory-token";
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
  const svc = spawnService(pkg, { PORT: String(port), INVENTORY_INTERNAL_TOKEN: TOKEN, ...env });
  live.push(svc);
  const base = `http://127.0.0.1:${port}`;
  await waitHealthy(base);
  return { svc, base };
};
/** Every inventory route needs a signed request: the signature covers the path without the query and the exact body. */
const sign = (url: string, body: string, key = TOKEN) => ({ "x-internal-auth": signInternalRequest(key, "POST", new URL(url).pathname, body) });
const post = (url: string, body: unknown, key = TOKEN) => {
  const payload = JSON.stringify(body);
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", ...sign(url, payload, key) }, body: payload });
};

describe("inventory process: ops endpoints", () => {
  it("/healthz, /readyz and /metrics; hold results are counted by strategy and result", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect((await ready.json()).checks.postgres.ok).toBe(true);

    const rid = "e2e-inventory-1";
    const ok = await fetch(`${base}/events/${EVENT}/holds`, { method: "POST", headers: { "content-type": "application/json", "x-request-id": rid, ...sign(`${base}/events/${EVENT}/holds`, '{"seatIds":[1],"userId":"u1"}') }, body: '{"seatIds":[1],"userId":"u1"}' });
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

  it("the running process refuses unsigned and wrongly signed requests with 401 (counted, with a request id) and holds nothing", async () => {
    const { base } = await start();
    const url = `${base}/events/${EVENT}/holds`;
    const body = JSON.stringify({ seatIds: [15], userId: "intruder" });
    const unsigned = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-request-id": "e2e-inv-401" }, body });
    expect(unsigned.status).toBe(401);
    expect(unsigned.headers.get("x-request-id")).toBe("e2e-inv-401");
    expect((await post(url, { seatIds: [15], userId: "intruder" }, "some-other-key")).status).toBe(401);
    expect((await fetch(`${base}/events/${EVENT}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body })).status).toBe(401);
    expect((await fetch(`${base}/events/${EVENT}/availability`)).status).toBe(401);
    expect((await pool.query("SELECT status FROM seats WHERE event_id=$1 AND seat_id=15", [EVENT])).rows[0].status).toBe("free");
    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toContain(`http_requests_total{method="POST",route="/events/:eventId/holds",status_class="4xx",service="inventory"} 2`);
    expect(text).toContain(`http_requests_total{method="GET",route="/events/:eventId/availability",status_class="4xx",service="inventory"} 1`);
  }, 30_000);

  it("refuses to boot with the development key in production, or without a key", async () => {
    for (const env of [{ NODE_ENV: "production" }, { NODE_ENV: "production", INVENTORY_INTERNAL_TOKEN: "dev-inventory-internal-token" }]) {
      const svc = spawnService(pkg, { PORT: String(await freePort()), ...env, INVENTORY_INTERNAL_TOKEN: (env as Record<string, string>).INVENTORY_INTERNAL_TOKEN ?? "" });
      live.push(svc);
      expect((await svc.exited).code).toBe(78);
      expect(svc.output()).toMatch(/INVENTORY_INTERNAL_TOKEN (must be set when NODE_ENV=production|is set to a known development value)/);
    }
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
