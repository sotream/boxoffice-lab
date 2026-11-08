import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startInfra } from "../docker";
import { EVENT, runLoad } from "../load";
import { NetProxy } from "../netproxy";
import { Stack } from "../stack";
import { count, refundedNonCheaters, serverErrors, settleAndCheck, stopWorld, type World } from "./world";

const SEATS = 80, USERS = 200, PARTITION_MS = 15_000;
let w: World;
let proxy: NetProxy;

beforeAll(async () => {
  const infra = await startInfra();
  try {
    // Only the waiting room (queue commands, the admission tick and its readiness ping share one client) reaches Redis through the proxy;
    // the gateway's limiter, the other services and the test's own checks use the direct address.
    proxy = await NetProxy.start("127.0.0.1", Number(new URL(infra.redisUrl).port));
    w = { infra, stack: await Stack.start({ tag: "netredisq", infra, seats: SEATS, pspLatencyMs: 100, pspFailRate: 0.05, admitPerSecond: 60, seed: 5004, env: { "waiting-room": { REDIS_URL: `redis://127.0.0.1:${proxy.port}/0` } } }) };
  } catch (e) { await proxy?.stop(); await infra.stop(); throw e; }
}, 180_000);
afterAll(async () => { try { await stopWorld(w); } finally { await proxy?.stop(); } }, 120_000);

type Timed = { status: number; retryAfter: string | null; ms: number; body: string };
const timed = async (url: string, init?: RequestInit): Promise<Timed> => {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    const body = await r.text();
    return { status: r.status, retryAfter: r.headers.get("retry-after"), ms: Date.now() - t0, body };
  } catch { return { status: 0, retryAfter: null, ms: Date.now() - t0, body: "" }; }
};
/** A scrape of /metrics reads the queue length from Redis (a gauge collected at scrape time), so it is a Redis call too. NaN when the scrape failed or timed out. */
const scrape = async (url: string, name: string): Promise<{ value: number; ms: number }> => {
  const t0 = Date.now();
  try {
    const t = await (await fetch(`${url}/metrics`, { signal: AbortSignal.timeout(20_000) })).text();
    return { value: Number(new RegExp(`^${name}(?:\\{[^}]*\\})? (\\S+)$`, "m").exec(t)?.[1] ?? NaN), ms: Date.now() - t0 };
  } catch { return { value: NaN, ms: Date.now() - t0 }; }
};
const metric = async (url: string, name: string) => (await scrape(url, name)).value;
const redisOk = (body: string): boolean | undefined => { try { return JSON.parse(body).checks?.redis?.ok; } catch { return undefined; } };

/**
 * F13 covers the gateway's limiter (commandTimeout 200 ms). The waiting room's own client sits behind the gateway's upstream timeout (8 s):
 * in a silent partition (socket established, packets stop) a queue join or status call must still end with a bounded, documented answer, the
 * process must stay responsive, and the admission tick must neither die nor pile up.
 */
describe("fault 14: the network between the waiting room and Redis silently drops everything for 15 s (both ends stay up)", () => {
  it("queue join and status answer with a bounded 503 instead of hanging to the gateway's timeout, the waiting room stays live and recovers after the heal, the sale completes with all invariants", async () => {
    const s = w.stack;
    const wr = s.urls["waiting-room"];
    const grantsLive = new Map<number, string[]>();
    const load = runLoad({ seed: 5004, users: USERS, seats: SEATS, gateway: s.urls.gateway, concurrency: USERS, deadlineMs: 170_000, grantsLive }, s.runId);
    await s.waitUntil(async () => (await count(s, "payments.payments")) >= 10 && grantsLive.size >= 15, 90_000, 20);

    const probeUser = `${s.userPrefix}wrprobe`;
    const json = { "content-type": "application/json" };
    const join = () => timed(`${s.urls.gateway}/events/${EVENT}/queue/join`, { method: "POST", headers: json, body: JSON.stringify({ userId: probeUser }) });
    const status = () => timed(`${s.urls.gateway}/events/${EVENT}/queue/status?userId=${probeUser}`);
    const baseline = { join: await join(), status: await status() };
    const admittedBefore = await metric(wr, "waitingroom_admitted_total");

    proxy.set({ kind: "blackhole" });
    const t0 = Date.now();
    // probes are fired every second and not awaited one by one: a hanging call must not hide the next ones
    const pending: Promise<{ kind: "join" | "status"; r: Timed }>[] = [];
    const wrHealth: Timed[] = [], wrReady: Timed[] = [];
    // one scrape of /metrics at about 10 s, not awaited either
    let scrapeP: ReturnType<typeof scrape> | undefined;
    while (Date.now() - t0 < PARTITION_MS) {
      if (!scrapeP && Date.now() - t0 > 10_000) scrapeP = scrape(wr, "waitingroom_admission_errors_total");
      pending.push(join().then((r) => ({ kind: "join" as const, r })), status().then((r) => ({ kind: "status" as const, r })));
      wrHealth.push(await timed(`${wr}/healthz`));
      wrReady.push(await timed(`${wr}/readyz`));
      await new Promise((r) => setTimeout(r, 1_000));
    }
    const alive = ["gateway", "waiting-room", "inventory", "payments"].map((n) => [n, s.alive(n)] as const);
    proxy.set({ kind: "pass" });
    const healedAt = Date.now();

    let recoveredMs = -1; let after = { join: await join(), status: await status() };
    while (Date.now() - healedAt < 20_000) {
      after = { join: await join(), status: await status() };
      if ([after.join, after.status].every((x) => x.status === 200 || x.status === 201)) { recoveredMs = Date.now() - healedAt; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    const readyAgain = await s.waitUntil(async () => redisOk(await (await fetch(`${wr}/readyz`)).text()) === true, 10_000, 100).then(() => Date.now() - healedAt, () => -1);
    const probes = await Promise.all(pending);
    const scrapeDuring = (await scrapeP)!;
    const errorsDuring = scrapeDuring.value;
    const admittedAfter = await metric(wr, "waitingroom_admitted_total");
    const errorsAfter = await metric(wr, "waitingroom_admission_errors_total");

    const result = await load;
    const { report, quiet } = await settleAndCheck(w, result, { seats: SEATS, quiescentMs: 120_000 });
    const wronglyRefunded = await refundedNonCheaters(s, result);
    const errors = serverErrors(result);
    const of = (k: "join" | "status") => probes.filter((p) => p.kind === k).map((p) => p.r);
    const slowest = (k: "join" | "status") => Math.max(...of(k).map((x) => x.ms));
    const fmt = (x: Timed) => `${x.status}/${x.retryAfter}/${x.ms}`;
    console.log("net redis waiting room partition:", quiet, JSON.stringify({
      partitionMs: healedAt - t0, probes: probes.length, recoveredMs, readyAgain, bytesUp: proxy.bytesUp, errors: errors.length, admittedBefore, admittedAfter, admissionErrorsDuring: errorsDuring, scrapeDuringMs: scrapeDuring.ms, admissionErrorsAfter: errorsAfter,
      baseline: { join: fmt(baseline.join), status: fmt(baseline.status) },
      durings: { join: of("join").map(fmt), status: of("status").map(fmt) },
      healthz: wrHealth.map(fmt), readyz: wrReady.map((x) => `${x.status}/${x.ms}/${redisOk(x.body)}`),
      afterHeal: { join: fmt(after.join), status: fmt(after.status) }, ...report.summary
    }));

    expect(proxy.bytesUp, "the waiting room's Redis traffic went through the proxy").toBeGreaterThan(0);
    expect([baseline.join.status, baseline.status.status].every((x) => x === 200 || x === 201), "before the partition the queue answers").toBe(true);
    expect(probes.length).toBeGreaterThan(10);
    // the answer is bounded by the waiting room's own command timeout, well below the gateway's 8 s upstream timeout, and is the documented 503 + Retry-After
    for (const k of ["join", "status"] as const) {
      for (const x of of(k)) {
        expect(x.status, `${k} during a silent Redis partition behind the waiting room: ${fmt(x)}`).toBe(503);
        expect(x.retryAfter, `${k} Retry-After`).toBe("1");
      }
      expect(slowest(k), `${k} must be bounded by the waiting room's command timeout, not by the gateway's 8 s upstream timeout`).toBeLessThan(4_000);
    }
    // the process stays responsive, and says that redis is down
    for (const x of wrHealth) { expect(x.status).toBe(200); expect(x.ms).toBeLessThan(2_000); }
    for (const x of wrReady) { expect(x.status, "readyz during the partition").toBe(503); expect(x.ms).toBeLessThan(4_000); expect(redisOk(x.body)).toBe(false); }
    expect(alive.filter(([, up]) => !up)).toEqual([]);
    expect(scrapeDuring.ms, "a metrics scrape must not hang on Redis").toBeLessThan(4_000);
    // the admission tick saw the errors and did not die: it admits again after the heal
    expect(errorsDuring, "admission tick errors during the partition").toBeGreaterThan(0);
    // recovery without a restart
    expect(recoveredMs, "the waiting room did not recover after the heal").toBeGreaterThanOrEqual(0);
    expect(recoveredMs).toBeLessThan(10_000);
    expect(readyAgain, "readiness did not see Redis again").toBeGreaterThanOrEqual(0);
    expect(admittedAfter, "the admission tick must resume").toBeGreaterThan(admittedBefore);
    expect(wronglyRefunded, "refund caused by the partition").toEqual([]);
    expect(report.violations.join("\n")).toBe("");
    expect((report.summary as Record<string, number>).confirmed).toBeGreaterThan(10);
  }, 290_000);
});
