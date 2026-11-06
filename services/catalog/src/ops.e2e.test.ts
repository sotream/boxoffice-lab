import { join } from "node:path";
import Redis from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureBuilt, freePort, RunningService, spawnService, waitHealthy } from "@boxoffice/platform";

const pkg = join(__dirname, "..");
const redis = new Redis("redis://localhost:56379");
const live: RunningService[] = [];
afterEach(() => { for (const s of live.splice(0)) s.child.kill("SIGKILL"); });
afterAll(async () => { const k = await redis.keys("search:fts::opse2e*"); if (k.length) await redis.del(...k); await redis.quit(); });
beforeAll(() => ensureBuilt(pkg), 60_000);

describe("catalog process", () => {
  it("serves healthz/readyz/metrics and counts cache results and query time", async () => {
    const port = await freePort();
    const svc = spawnService(pkg, { PORT: String(port) });
    live.push(svc);
    const base = `http://127.0.0.1:${port}`;
    await waitHealthy(base);
    const ready = await (await fetch(`${base}/readyz`)).json();
    expect(ready.status).toBe("ready");
    expect(Object.keys(ready.checks).sort()).toEqual(["postgres", "redis"]);

    const q = `opse2e${Date.now()}`;
    expect((await fetch(`${base}/search?q=${q}`)).status).toBe(200); // miss -> Postgres
    expect((await fetch(`${base}/search?q=${q}`)).status).toBe(200); // hit
    await new Promise((r) => setTimeout(r, 50));
    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toContain('catalog_cache_requests_total{result="miss",service="catalog"} 1');
    expect(text).toContain('catalog_cache_requests_total{result="hit",service="catalog"} 1');
    expect(text).toMatch(/catalog_db_query_duration_seconds_count\{service="catalog",op="search_fts"\} 1/);
    expect(text).toContain('route="/search"');
    expect(text).not.toContain(q);
  }, 30_000);

  it("SIGTERM: process exits 0 after closing server, pools and redis", async () => {
    const port = await freePort();
    const svc = spawnService(pkg, { PORT: String(port) });
    live.push(svc);
    await waitHealthy(`http://127.0.0.1:${port}`);
    svc.child.kill("SIGTERM");
    expect((await svc.exited).code).toBe(0);
    expect(svc.output()).toContain('"step":"redis"');
  }, 30_000);
});
