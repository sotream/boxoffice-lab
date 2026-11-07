import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startInfra } from "../docker";
import { runLoad } from "../load";
import { NetProxy } from "../netproxy";
import { Stack } from "../stack";
import { count, refundedNonCheaters, serverErrors, settleAndCheck, stopWorld, type World } from "./world";

const SEATS = 80, USERS = 200;
let w: World;
let proxy: NetProxy | undefined;

beforeAll(async () => {
  const infra = await startInfra();
  try {
    w = { infra, stack: await Stack.start({
      tag: "netinv", infra, seats: SEATS, pspLatencyMs: 100, pspFailRate: 0.05, admitPerSecond: 150, seed: 5002,
      // payments reaches inventory (the pre-charge check and the confirm) through the proxy; clients and the gateway do not
      inventoryUrlForPayments: async (real) => { proxy = await NetProxy.start("127.0.0.1", Number(new URL(real).port)); return `http://127.0.0.1:${proxy.port}`; }
    }) };
  } catch (e) { await proxy?.stop(); await infra.stop(); throw e; }
}, 180_000);
afterAll(async () => { try { await stopWorld(w); } finally { await proxy?.stop(); } }, 120_000);

/**
 * The call payments makes to inventory is slow, then silent. Every step of the saga is bounded at 2 s, and a slow answer is "unknown",
 * never "seats lost": no refund may come out of it, the saga waits and the sweeper finishes it.
 */
describe("fault 11: the network between payments and inventory is slow (1 s each way), then drops everything for 8 s", () => {
  it("sagas wait instead of refunding, nothing is refunded by the network, and after it heals every saga reaches a final state with all invariants", async () => {
    const s = w.stack;
    const p = proxy!;
    // no cheaters: every refund in this run would be caused by the network
    const load = runLoad({ seed: 5002, users: USERS, seats: SEATS, gateway: s.urls.gateway, concurrency: USERS, deadlineMs: 170_000, mix: { abandoner: 0.1, cheater: 0, doubleSubmit: 0.1, impostor: 0 } }, s.runId);
    await s.waitUntil(async () => (await count(s, "payments.payments")) >= 15, 60_000, 20);
    const confirmedBefore = await count(s, "payments.payments WHERE status='CONFIRMED'");

    // phase 1: 1 s each way = 2 s per round trip, right at the 2 s step timeout: some answers arrive, some do not
    p.set({ kind: "latency", ms: 1_000 });
    await new Promise((r) => setTimeout(r, 8_000));
    const pendingSlow = await count(s, "payments.payments WHERE status IN ('PENDING','CHARGED')");
    // phase 2: a silent partition
    p.set({ kind: "blackhole" });
    await new Promise((r) => setTimeout(r, 8_000));
    const chargedDuring = await count(s, "payments.payments WHERE status='CHARGED'");
    const refundsDuring = await count(s, "payments.payments WHERE status IN ('REFUNDING','REFUNDED')");
    const alive = ["inventory", "payments", "gateway"].map((n) => [n, s.alive(n)] as const);
    p.set({ kind: "pass" });

    const result = await load;
    const { report, quiet } = await settleAndCheck(w, result, { seats: SEATS, quiescentMs: 120_000 });
    const wronglyRefunded = await refundedNonCheaters(s, result);
    const errors = serverErrors(result);
    const summary = report.summary as Record<string, number>;
    console.log("net inventory latency:", quiet, JSON.stringify({ confirmedBefore, pendingSlow, chargedDuring, refundsDuring, errors: errors.length, bytesUp: p.bytesUp, ...summary }));

    expect(alive.filter(([, up]) => !up)).toEqual([]);
    expect(p.bytesUp, "traffic really went through the proxy").toBeGreaterThan(0);
    expect(refundsDuring, "refund caused by the slow or silent network").toBe(0);
    expect(wronglyRefunded, "refund caused by the slow or silent network").toEqual([]);
    expect(chargedDuring + pendingSlow, "sagas must have been caught mid-flight by the network").toBeGreaterThan(0);
    expect(report.violations.join("\n")).toBe("");
    expect(summary.confirmed).toBeGreaterThan(10);
  }, 290_000);
});
