import { join } from "node:path";
import Redis from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureBuilt, freePort, RunningService, spawnService, waitHealthy } from "@boxoffice/platform";

const pkg = join(__dirname, "..");
const redis = new Redis("redis://localhost:56379");
const live: RunningService[] = [];
afterEach(() => { for (const s of live.splice(0)) s.child.kill("SIGKILL"); });
afterAll(() => redis.quit());
beforeAll(() => ensureBuilt(pkg), 60_000);

const start = async (env: Record<string, string> = {}) => {
  const port = await freePort();
  const svc = spawnService(pkg, { PORT: String(port), ...env });
  live.push(svc);
  const base = `http://127.0.0.1:${port}`;
  await waitHealthy(base);
  return { svc, base };
};
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("waiting-room process", () => {
  it("serves healthz/readyz/metrics, counts joins and admissions without user ids in labels", async () => {
    const { base } = await start({ ADMIT_PER_SECOND: "100" });
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect((await ready.json()).checks.redis.ok).toBe(true);

    const user = `ops-e2e-${Date.now()}`;
    expect((await post(`${base}/events/99001/queue/join`, { userId: user })).status).toBe(201); // event 99001 is not served by the tick
    expect((await post(`${base}/events/1/queue/join`, { userId: user })).status).toBe(201);    // event 1 is: admitted within a few ticks
    await new Promise((r) => setTimeout(r, 400));
    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toMatch(/waitingroom_joins_total\{result="queued",service="waiting-room"\} 2/);
    expect(text).toMatch(/waitingroom_admitted_total\{service="waiting-room"\} [1-9]/);
    expect(text).toContain("waitingroom_queue_length");
    expect(text).not.toContain(user);
    await redis.del("wr:99001:queue", "wr:99001:seq", `wr:1:admitted:${user}`);
  }, 30_000);

  it("SIGTERM stops the admission tick and the process exits 0", async () => {
    const { svc } = await start();
    svc.child.kill("SIGTERM");
    const exit = await svc.exited;
    expect(exit.code).toBe(0);
    expect(svc.output()).toContain('"step":"admission tick"');
  }, 30_000);

  it("refuses the development secret in production", async () => {
    const svc = spawnService(pkg, { NODE_ENV: "production", PORT: "x" });
    live.push(svc);
    expect((await svc.exited).code).toBe(78);
    expect(svc.output()).toMatch(/ADMISSION_SECRET must be set/);
  }, 30_000);
});
