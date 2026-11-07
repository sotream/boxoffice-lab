import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startInfra } from "../docker";
import { runLoad } from "../load";
import { NetProxy } from "../netproxy";
import { Stack } from "../stack";
import { count, refundedNonCheaters, serverErrors, settleAndCheck, stopWorld, type World } from "./world";

const SEATS = 80, USERS = 200, PARTITION_MS = 25_000;
let w: World;
let proxy: NetProxy;

beforeAll(async () => {
  const infra = await startInfra();
  try {
    // Only inventory reaches Postgres through the proxy; payments, notifications and the checks use the direct address.
    proxy = await NetProxy.start("127.0.0.1", Number(new URL(infra.pgUrl).port));
    const viaProxy = `postgres://lab:lab@127.0.0.1:${proxy.port}/lab`;
    w = { infra, stack: await Stack.start({ tag: "netlong", infra, seats: SEATS, pspLatencyMs: 100, pspFailRate: 0.05, admitPerSecond: 150, seed: 5002, env: { inventory: { DATABASE_URL: viaProxy } } }) };
  } catch (e) { await proxy?.stop(); await infra.stop(); throw e; }
}, 180_000);
afterAll(async () => { try { await stopWorld(w); } finally { await proxy?.stop(); } }, 120_000);

/**
 * F10 with a partition that outlasts the gateway's 8 s upstream timeout (and the pool's 6 s client-side query timeout several times
 * over). Without a client-side query timeout every connection that was mid-query stays stuck in the pool until the path heals;
 * with it they time out, are destroyed and replaced, so the service is usable again within seconds of the heal.
 */
describe("fault 12: the network between inventory and Postgres silently drops everything for 25 s, longer than the gateway's upstream timeout (both ends stay up)", () => {
  it("clients get an answer or a bounded error, payments reads it as unknown (no wrong refund), and after the partition heals the sale completes with all invariants", async () => {
    const s = w.stack;
    const grantsLive = new Map<number, string[]>();
    const load = runLoad({ seed: 5002, users: USERS, seats: SEATS, gateway: s.urls.gateway, concurrency: USERS, deadlineMs: 170_000, grantsLive }, s.runId);
    await s.waitUntil(async () => (await count(s, "payments.payments")) >= 15 && grantsLive.size >= 25, 60_000, 20);
    const refundsBefore = await count(s, "payments.payments WHERE status IN ('REFUNDING','REFUNDED')");

    proxy.set({ kind: "blackhole" });
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 1_000));
    const closedAtStart = proxy.closedEstablished;
    const refundsAtStart = await count(s, "payments.payments WHERE status IN ('REFUNDING','REFUNDED')");
    // what a client sees: one availability call per second through the gateway, with its duration
    const probes: { status: number; ms: number }[] = [];
    while (Date.now() - t0 < PARTITION_MS) {
      const p0 = Date.now();
      const r = await fetch(`${s.urls.gateway}/events/1/availability`, { signal: AbortSignal.timeout(20_000) }).then((x) => x.status).catch(() => 0);
      probes.push({ status: r, ms: Date.now() - p0 });
      await new Promise((r2) => setTimeout(r2, 1_000));
    }
    const refundsDuring = await count(s, "payments.payments WHERE status IN ('REFUNDING','REFUNDED')");
    const chargedDuring = await count(s, "payments.payments WHERE status='CHARGED'");
    const alive = ["inventory", "payments", "gateway"].map((n) => [n, s.alive(n)] as const);
    const closedDuring = proxy.closedEstablished - closedAtStart;
    proxy.set({ kind: "pass" });
    const healedAt = Date.now();
    // no stuck pool: inventory answers on availability within a few seconds of the heal (the first answers may still be errors while
    // connections that were mid-query time out; they must not stay stuck)
    let afterHeal = 0;
    const h0 = Date.now();
    while (Date.now() - h0 < 5_000) {
      afterHeal = await fetch(`${s.urls.gateway}/events/1/availability`, { signal: AbortSignal.timeout(10_000) }).then((x) => x.status).catch(() => 0);
      if (afterHeal === 200) break;
      await new Promise((r2) => setTimeout(r2, 250));
    }
    const healMs = Date.now() - h0;

    const result = await load;
    const { report, quiet } = await settleAndCheck(w, result, { seats: SEATS, quiescentMs: 120_000 });
    const wronglyRefunded = await refundedNonCheaters(s, result);
    const errors = serverErrors(result);
    const slowest = Math.max(...probes.map((p) => p.ms));
    console.log("net db long partition:", quiet, JSON.stringify({ partitionMs: healedAt - t0, probes: probes.map((p) => `${p.status}/${p.ms}`), slowest, refundsBefore, refundsAtStart, refundsDuring, chargedDuring, errors: errors.length, closedDuring, afterHeal, healMs, ...report.summary }));

    expect(alive.filter(([, up]) => !up)).toEqual([]);
    expect(wronglyRefunded, "refund caused by the partition").toEqual([]);
    expect(refundsDuring, "refund caused by the partition").toBe(refundsAtStart);
    // the clients felt it, and they felt it as a bounded error, not as an endless wait (gateway upstream timeout is 8 s)
    expect(errors.length, "clients must have felt the partition").toBeGreaterThan(0);
    expect(slowest, "an availability call took longer than the gateway's upstream timeout plus margin").toBeLessThan(12_000);
    // the client side noticed: connections that were mid-query gave up on their own (query timeout) instead of staying stuck until the heal
    expect(closedDuring, "no established connection was dropped during the partition: stuck connections stay in the pool").toBeGreaterThan(0);
    expect(afterHeal, "availability did not recover within 5 s of the heal (stuck pool)").toBe(200);
    expect(healMs).toBeLessThan(5_000);
    expect(report.violations.join("\n")).toBe("");
    expect((report.summary as Record<string, number>).confirmed).toBeGreaterThan(10);
  }, 290_000);
});
