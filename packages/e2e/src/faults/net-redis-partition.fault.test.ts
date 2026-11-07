import { signAdmission } from "@boxoffice/admission";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startInfra } from "../docker";
import { EVENT, runLoad } from "../load";
import { NetProxy } from "../netproxy";
import { SECRET, Stack } from "../stack";
import { count, refundedNonCheaters, serverErrors, settleAndCheck, stopWorld, type World } from "./world";

const SEATS = 80, USERS = 200, PARTITION_MS = 15_000;
let w: World;
let proxy: NetProxy;

beforeAll(async () => {
  const infra = await startInfra();
  try {
    // Only the gateway's limiter reaches Redis through the proxy; the waiting room, the admission loop and the test's own checks use the direct address.
    proxy = await NetProxy.start("127.0.0.1", Number(new URL(infra.redisUrl).port));
    w = { infra, stack: await Stack.start({ tag: "netredis", infra, seats: SEATS, pspLatencyMs: 100, pspFailRate: 0.05, admitPerSecond: 60, seed: 5003, env: { gateway: { REDIS_URL: `redis://127.0.0.1:${proxy.port}/0` } } }) };
  } catch (e) { await proxy?.stop(); await infra.stop(); throw e; }
}, 180_000);
afterAll(async () => { try { await stopWorld(w); } finally { await proxy?.stop(); } }, 120_000);

const timed = async (url: string, init?: RequestInit) => {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    await r.text();
    return { status: r.status, retryAfter: r.headers.get("retry-after"), ms: Date.now() - t0 };
  } catch { return { status: 0, retryAfter: null, ms: Date.now() - t0 }; }
};

/**
 * F4 pauses or stops the Redis container: the gateway's socket is either dead or its commands are answered by nothing, both clean. Here the TCP
 * connection stays established and packets just stop (no RST, no FIN): ioredis sees a healthy socket with a command in flight that is never
 * answered. Only its `commandTimeout` (200 ms) can end that wait; `enableOfflineQueue: false` and the reconnect strategy never come into play,
 * because nothing tells the client the connection is gone. The policy must be the same as for an error: fail closed, fail open.
 */
describe("fault 13: the network between the gateway and Redis silently drops everything for 15 s (both ends stay up)", () => {
  it("holds, pay and queue join fail closed (503 + Retry-After) within the command timeout, availability fails open, nothing dies, the gateway recovers after the heal and the sale completes with all invariants", async () => {
    const s = w.stack;
    const grantsLive = new Map<number, string[]>();
    const load = runLoad({ seed: 5003, users: USERS, seats: SEATS, gateway: s.urls.gateway, concurrency: USERS, deadlineMs: 170_000, grantsLive }, s.runId);
    await s.waitUntil(async () => (await count(s, "payments.payments")) >= 10 && grantsLive.size >= 15, 90_000, 20);
    const paymentsBefore = await count(s, "payments.payments");

    // a correctly signed token of a user the load does not know. A hold of a seat that does not exist and a pay whose body user is not the token's user
    // both pass the limiter and are then refused by their own checks, so they never change anything, but they are 503 when the limiter cannot decide.
    const probeUser = `${s.userPrefix}probe`;
    const hdr = { "content-type": "application/json", "x-admission": signAdmission(probeUser, EVENT, 60, SECRET), "idempotency-key": "probe-key" };
    const json = { "content-type": "application/json" };
    const probe = () => Promise.all([
      timed(`${s.urls.gateway}/events/${EVENT}/availability`),
      timed(`${s.urls.gateway}/events/${EVENT}/holds`, { method: "POST", headers: hdr, body: JSON.stringify({ seatIds: [999_999], userId: probeUser }) }),
      timed(`${s.urls.gateway}/events/${EVENT}/pay`, { method: "POST", headers: hdr, body: JSON.stringify({ eventId: EVENT, userId: `${probeUser}-other`, seatIds: [999_999], amountCents: 2500 }) }),
      timed(`${s.urls.gateway}/events/${EVENT}/queue/join`, { method: "POST", headers: json, body: JSON.stringify({ userId: probeUser }) })
    ]).then(([availability, hold, pay, join]) => ({ availability, hold, pay, join }));
    const baseline = await probe();

    proxy.set({ kind: "blackhole" });
    const t0 = Date.now();
    const during: Awaited<ReturnType<typeof probe>>[] = [];
    while (Date.now() - t0 < PARTITION_MS) {
      during.push(await probe());
      await new Promise((r) => setTimeout(r, 1_000));
    }
    const alive = ["gateway", "waiting-room", "inventory", "payments"].map((n) => [n, s.alive(n)] as const);
    const gwReady = await (await fetch(`${s.opsOf("gateway")}/readyz`)).json() as { checks: Record<string, { ok: boolean }> };
    const probePaymentsDuring = await count(s, "payments.payments WHERE user_id=$1", [probeUser]);
    proxy.set({ kind: "pass" });
    const healedAt = Date.now();

    // how long until the limiter answers normally again (a hold of the unknown seat is not 503 any more)
    let recoveredMs = -1; let afterHeal = await probe();
    while (Date.now() - healedAt < 20_000) {
      afterHeal = await probe();
      if ([afterHeal.hold, afterHeal.pay, afterHeal.join].every((x) => x.status !== 503 && x.status !== 0)) { recoveredMs = Date.now() - healedAt; break; }
      await new Promise((r) => setTimeout(r, 250));
    }

    const result = await load;
    const { report, quiet } = await settleAndCheck(w, result, { seats: SEATS, quiescentMs: 120_000 });
    const wronglyRefunded = await refundedNonCheaters(s, result);
    const errors = serverErrors(result);
    const probePaymentsEnd = await count(s, "payments.payments WHERE user_id=$1", [probeUser]);
    const probeSeats = await s.q(`SELECT seat_id FROM seats WHERE held_by=$1`, [probeUser]);
    type K = "availability" | "hold" | "pay" | "join";
    const KEYS: K[] = ["availability", "hold", "pay", "join"];
    const flat = (k: K) => during.map((d) => d[k]);
    const slowest = (k: K) => Math.max(...flat(k).map((x) => x.ms));
    console.log("net redis partition:", quiet, JSON.stringify({
      partitionMs: healedAt - t0, probesDuring: during.length, recoveredMs, bytesUp: proxy.bytesUp, paymentsBefore, errors: errors.length,
      baseline: Object.fromEntries(KEYS.map((k) => [k, `${baseline[k].status}/${baseline[k].retryAfter}/${baseline[k].ms}`])),
      durings: Object.fromEntries(KEYS.map((k) => [k, flat(k).map((x) => `${x.status}/${x.retryAfter}/${x.ms}`)])),
      afterHeal: Object.fromEntries(KEYS.map((k) => [k, `${afterHeal[k].status}/${afterHeal[k].ms}`])), ...report.summary
    }));

    // the proxy really carried the gateway's Redis traffic
    expect(proxy.bytesUp, "the gateway's limiter traffic went through the proxy").toBeGreaterThan(0);
    expect(baseline.hold.status, "before the partition the limiter lets the probe through").not.toBe(503);
    expect(during.length).toBeGreaterThan(5);
    // fail closed on anything that spends scarce things: 503 with Retry-After, bounded by the command timeout (200 ms) plus slack, never a hang
    for (const k of ["hold", "pay", "join"] as const) {
      for (const x of flat(k)) {
        expect(x.status, `${k} during a silent Redis partition`).toBe(503);
        expect(x.retryAfter, `${k} Retry-After`).toBe("1");
      }
      expect(slowest(k), `${k} must be bounded by the limiter's command timeout, not by the gateway's upstream timeout`).toBeLessThan(3_000);
    }
    // fail open on the public read, bounded too
    for (const x of flat("availability")) expect(x.status, "availability must fail open").toBe(200);
    expect(slowest("availability")).toBeLessThan(3_000);
    // the refused probes changed nothing
    expect(probePaymentsDuring).toBe(0);
    expect(probePaymentsEnd).toBe(0);
    expect(probeSeats).toEqual([]);
    // the gateway reports redis as down but stays ready (soft dependency); no process died
    expect(gwReady.checks.redis?.ok).toBe(false);
    expect(alive.filter(([, up]) => !up)).toEqual([]);
    // the clients were refused, and nobody was refunded because of it
    expect([...result.stats].filter(([k]) => /:503$/.test(k)).length, "clients must have felt the partition").toBeGreaterThan(0);
    expect(wronglyRefunded, "refund caused by the partition").toEqual([]);
    // after the heal the limiter answers again without a restart, within a few seconds
    expect(recoveredMs, "the gateway did not recover after the heal").toBeGreaterThanOrEqual(0);
    expect(recoveredMs).toBeLessThan(8_000);
    // and its readiness sees Redis again
    await s.waitUntil(async () => ((await (await fetch(`${s.opsOf("gateway")}/readyz`)).json()) as { checks: Record<string, { ok: boolean }> }).checks.redis?.ok === true, 8_000, 100);
    expect(report.violations.join("\n")).toBe("");
    expect((report.summary as Record<string, number>).confirmed).toBeGreaterThan(10);
  }, 290_000);
});
