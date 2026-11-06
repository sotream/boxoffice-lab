import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureBuilt, freePort, RunningService, spawnService, waitHealthy } from "@boxoffice/platform";

const pkg = join(__dirname, "..");
const live: RunningService[] = [];
afterEach(() => { for (const s of live.splice(0)) s.child.kill("SIGKILL"); });
beforeAll(() => ensureBuilt(pkg), 60_000);

describe("gateway process", () => {
  it("SIGTERM during an in-flight request: the request completes, readiness flips, the process exits 0", async () => {
    let upstreamHits = 0;
    const upstream = createServer((_req, res) => { upstreamHits++; setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end('{"free":1}'), 800); });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const port = await freePort();
    const opsPort = await freePort();
    const svc = spawnService(pkg, { PORT: String(port), OPS_PORT: String(opsPort), INVENTORY_URL: `http://127.0.0.1:${(upstream.address() as any).port}`, UPSTREAM_TIMEOUT_MS: "5000", IP_RATE: "1000", IP_BURST: "1000", SHUTDOWN_DEADLINE_MS: "8000" });
    live.push(svc);
    const base = `http://127.0.0.1:${port}`;
    const ops = `http://127.0.0.1:${opsPort}`;
    try {
      await waitHealthy(ops);
      expect((await fetch(`${ops}/readyz`)).status).toBe(200);
      expect((await (await fetch(`${ops}/metrics`)).text())).toContain("http_requests_in_flight");
      for (const p of ["/healthz", "/readyz", "/metrics"]) expect((await fetch(`${base}${p}`)).status, `public ${p}`).toBe(404);

      const inflight = fetch(`${base}/events/1/availability`, { headers: { connection: "close" } });
      await new Promise((r) => setTimeout(r, 200));
      expect(upstreamHits).toBe(1);
      svc.child.kill("SIGTERM");
      const res = await inflight;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ free: 1 });
      const exit = await svc.exited;
      expect(exit.code).toBe(0);
      expect(svc.output()).toContain("shutdown complete");
      await expect(fetch(`${base}/events/1/availability`)).rejects.toBeTruthy(); // no longer accepting
      await expect(fetch(`${ops}/healthz`)).rejects.toBeTruthy(); // the ops server closed with the rest
    } finally { upstream.close(); }
  }, 30_000);

  it("a second signal forces exit while a request is still draining", async () => {
    const upstream = createServer(() => undefined); // never answers
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const port = await freePort();
    const opsPort = await freePort();
    const svc = spawnService(pkg, { PORT: String(port), OPS_PORT: String(opsPort), INVENTORY_URL: `http://127.0.0.1:${(upstream.address() as any).port}`, UPSTREAM_TIMEOUT_MS: "20000", SHUTDOWN_DEADLINE_MS: "20000" });
    live.push(svc);
    const base = `http://127.0.0.1:${port}`;
    try {
      await waitHealthy(`http://127.0.0.1:${opsPort}`);
      fetch(`${base}/events/1/availability`, { headers: { connection: "close" } }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
      svc.child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      svc.child.kill("SIGINT");
      const exit = await svc.exited;
      expect(exit.code).toBe(1);
    } finally { upstream.close(); upstream.closeAllConnections(); }
  }, 30_000);

  it("refuses to boot with the default secret in production and reports every bad variable", async () => {
    const svc = spawnService(pkg, { NODE_ENV: "production", PORT: "abc", IP_RATE: "fast" });
    live.push(svc);
    const exit = await svc.exited;
    expect(exit.code).toBe(78);
    expect(svc.output()).toMatch(/PORT must be an integer/);
    expect(svc.output()).toMatch(/IP_RATE must be a number/);
    expect(svc.output()).toMatch(/ADMISSION_SECRET must be set when NODE_ENV=production/);
  }, 30_000);
});
