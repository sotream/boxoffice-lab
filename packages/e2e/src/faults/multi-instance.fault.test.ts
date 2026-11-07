import { createServer, request, type Server } from "node:http";
import { freePort } from "@boxoffice/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mergeLoads, runLoad } from "../load";
import { signInternalRequest } from "@boxoffice/platform";
import { INTERNAL_TOKEN } from "../stack";
import { count, settleAndCheck, startWorld, stopWorld, type World } from "./world";

const SEATS = 100;
let w: World;
let proxy: Server;
const proxied = [0, 0];

/** A round-robin HTTP proxy in front of two inventory instances: the gateway's INVENTORY_URL and payments' INVENTORY_URL point at it. */
async function startProxy(targets: number[]): Promise<number> {
  let n = 0;
  proxy = createServer((req, res) => {
    const i = n++ % targets.length; proxied[i]++;
    const up = request({ host: "127.0.0.1", port: targets[i], method: req.method, path: req.url, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on("error", () => { res.statusCode = 502; res.end(); });
    req.pipe(up);
  });
  const port = await freePort();
  await new Promise<void>((r) => proxy.listen(port, "127.0.0.1", r));
  return port;
}

beforeAll(async () => {
  w = await startWorld("multi", { seats: SEATS, pspLatencyMs: 900, pspFailRate: 0.1, admitPerSecond: 200, seed: 4801,
    // the provider is slower than the step timeout at first: every payment answers 202 and stays PENDING. Then the provider "recovers" (admin hook) and the
    // sweepers of BOTH payments instances pick up the same sagas at the same time.
    env: { payments: { PSP_TIMEOUT_MS: "300", PSP_ADMIN: "1" } } });
}, 180_000);
afterAll(async () => { proxy?.close(); proxy?.closeAllConnections?.(); await stopWorld(w); }, 120_000);

describe("fault 7: several instances", () => {
  it("2 gateways, 2 payments (both sweeping) and 2 inventories behind a round-robin proxy on one database: invariants hold, concurrent sweepers never double-finish a payment", async () => {
    const s = w.stack;
    const inv2 = await s.startExtra("inventory", "inventory-2");
    const proxyPort = await startProxy([s.ports.inventory, Number(new URL(inv2.url).port)]);
    const inventoryViaProxy = `http://127.0.0.1:${proxyPort}`;
    // payments A is the stack's own (its INVENTORY_URL is restarted below to use the proxy); B is a second instance on its own port
    await s.kill("payments");
    await s.start("payments", { INVENTORY_URL: inventoryViaProxy });
    const payB = await s.startExtra("payments", "payments-2", { INVENTORY_URL: inventoryViaProxy });
    await s.kill("gateway");
    await s.start("gateway", { INVENTORY_URL: inventoryViaProxy });
    const gw2 = await s.startExtra("gateway", "gateway-2", { INVENTORY_URL: inventoryViaProxy, PAYMENTS_URL: payB.url });

    const a = runLoad({ seed: 4801, users: 120, seats: SEATS, gateway: s.urls.gateway, concurrency: 120, deadlineMs: 120_000 }, s.runId);
    const b = runLoad({ seed: 4802, users: 120, seats: SEATS, gateway: gw2.url, concurrency: 120, deadlineMs: 120_000, userOffset: 1000 }, s.runId);
    await s.waitUntil(async () => (await count(s, "payments.payments")) >= 40, 60_000, 50);
    const stuck = await count(s, "payments.payments WHERE status='PENDING'");
    const slowPsp = JSON.stringify({ latencyMs: 250 });
    for (const base of [s.urls.payments, payB.url]) {
      const r = await fetch(`${base}/admin/psp`, { method: "POST", headers: { "content-type": "application/json", "x-internal-auth": signInternalRequest(INTERNAL_TOKEN, "POST", "/admin/psp", slowPsp) }, body: slowPsp });
      expect(r.status, "the PSP latency change must be accepted, otherwise the scenario does not test what it says").toBe(201);
    }
    const [ra, rb] = await Promise.all([a, b]);
    const all = mergeLoads(ra, rb);
    const { report, quiet } = await settleAndCheck(w, all, { seats: SEATS, quiescentMs: 120_000 });

    const sweptA = (await s.counter(s.urls.payments, "payments_sweeper_resumed_total")) ?? 0;
    const sweptB = (await s.counter(payB.url, "payments_sweeper_resumed_total")) ?? 0;
    const inProgress = (await s.counter(s.urls.payments, "payments_in_progress_total") ?? 0) + (await s.counter(payB.url, "payments_in_progress_total") ?? 0);
    const viaA = await count(s, "payments.payments p WHERE p.id IS NOT NULL");
    console.log("multi-instance:", quiet, JSON.stringify({ stuck, sweptA, sweptB, inProgress, inventoryRequests: proxied, payments: viaA, ...report.summary }));

    expect(report.violations.join("\n")).toBe("");
    // both instances of each tier did real work
    expect(proxied[0]).toBeGreaterThan(20);
    expect(proxied[1]).toBeGreaterThan(20);
    expect(sweptA).toBeGreaterThan(0);
    expect(sweptB).toBeGreaterThan(0);
    expect(stuck, "sagas that were still PENDING when the provider recovered").toBeGreaterThan(10);
    expect(inProgress).toBeGreaterThan(20);
    expect((report.summary as Record<string, number>).confirmed).toBeGreaterThan(20);
    expect((report.summary as Record<string, number>).seatsSold).toBeLessThanOrEqual(SEATS);
  }, 280_000);
});
