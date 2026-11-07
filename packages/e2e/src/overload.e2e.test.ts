import { signAdmission } from "@boxoffice/admission";
import { freePort } from "@boxoffice/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkInvariants, waitQuiescent } from "./invariants";
import { EVENT, runLoad } from "./load";
import { SECRET, Stack } from "./stack";

const SEATS = 60;
const USERS = 40;
const STORM = 25;                 // concurrent hold attempts per user
const USER_RATE = 2, USER_BURST = 3, IP_RATE = 10, IP_BURST = 30;
let stack: Stack;
let overloaded: string;           // gateway with tiny limits, used for holds and availability

beforeAll(async () => {
  stack = await Stack.start({ tag: "overload", seats: SEATS, pspLatencyMs: 40, pspFailRate: 0.1, seed: 3001 });
  overloaded = await stack.startGateway("overloaded", { USER_RATE: String(USER_RATE), USER_BURST: String(USER_BURST), IP_RATE: String(IP_RATE), IP_BURST: String(IP_BURST) });
}, 90_000);
afterAll(async () => { await stack?.stop(); }, 60_000);

describe("scenario 3: more concurrent holds than the gateway limiter allows", () => {
  it("429 carries Retry-After, nothing answers 5xx, the per-user limit bounds admitted holds, and the invariants still hold", async () => {
    const load = await runLoad({
      seed: 3001, users: USERS, seats: SEATS, gateway: stack.urls.gateway, holdGateway: overloaded,
      concurrency: USERS, holdStorm: STORM, mix: { abandoner: 0.1, cheater: 0.05, doubleSubmit: 0.1 }
    }, stack.runId);
    const st = (k: string) => load.stats.get(k) ?? 0;

    // backpressure: the limiter said no, and said when to come back
    expect(st("hold:429")).toBeGreaterThan(USERS * STORM * 0.5);
    expect(load.retryAfterMissing).toBe(0);
    expect([...load.stats].filter(([k]) => /:(5\d\d|neterr)$/.test(k))).toEqual([]);
    // the limit is real, per user: admitted (non-429) requests <= burst + rate x elapsed (+1 for the Redis millisecond clock)
    for (const [user, attempts] of load.holdAttemptsByUser) {
      const elapsed = (Math.max(...attempts.map((a) => a.end)) - Math.min(...attempts.map((a) => a.start))) / 1000;
      const admitted = attempts.filter((a) => a.status !== 429).length;
      expect(admitted, `${user}: ${admitted} admitted holds in ${elapsed.toFixed(2)} s`).toBeLessThanOrEqual(USER_BURST + USER_RATE * elapsed + 1);
    }

    // the same for the per-IP limit on a public read: every answer is 200 or 429+Retry-After, never 5xx
    const t0 = Date.now();
    const flood = await Promise.all(Array.from({ length: 300 }, () => fetch(`${overloaded}/events/${EVENT}/availability`).then((r) => ({ status: r.status, ra: r.headers.get("retry-after") }))));
    const floodSecs = (Date.now() - t0) / 1000;
    expect(flood.filter((r) => r.status !== 200 && r.status !== 429)).toEqual([]);
    expect(flood.filter((r) => r.status === 429).length).toBeGreaterThan(100);
    expect(flood.filter((r) => r.status === 429 && !(Number(r.ra) >= 1))).toEqual([]);
    expect(flood.filter((r) => r.status === 200).length).toBeLessThanOrEqual(IP_BURST + IP_RATE * floodSecs + 2);

    // and the system behind it is still exactly right
    const paid = load.records.filter((r) => r.payStatus !== undefined).length;
    const quiet = await waitQuiescent(stack, paid, 60_000);
    await stack.waitUntil(async () => stack.bridge.pending === 0, 15_000);
    await new Promise((r) => setTimeout(r, 1500));
    const sends = await stack.counter(stack.opsUrl, "notifications_delivered_total");
    const report = await checkInvariants(stack, load, { seats: SEATS, notificationSends: sends });
    console.log("overload:", quiet, JSON.stringify(report.summary));
    expect(report.violations.join("\n")).toBe("");
    expect((report.summary as Record<string, number>).confirmed).toBeGreaterThan(10);
  }, 150_000);

  it("limiter store down (a gateway whose Redis is unreachable): holds fail closed with 503 + Retry-After and change nothing; reads fail open", async () => {
    const dead = await freePort(); // nothing listens there
    const gw = await stack.startGateway("no-redis", { REDIS_URL: `redis://127.0.0.1:${dead}/0` });
    const before = await stack.q(`SELECT seat_id, status, held_by FROM seats WHERE event_id=$1 ORDER BY seat_id`, [EVENT]);
    const token = signAdmission("u-forged-for-limiter-test", EVENT, 60, SECRET);
    const res = await fetch(`${gw}/events/${EVENT}/holds`, { method: "POST", headers: { "content-type": "application/json", "x-admission": token }, body: JSON.stringify({ seatIds: [1], userId: "u-forged-for-limiter-test" }) });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect((await fetch(`${gw}/events/${EVENT}/availability`)).status).toBe(200);
    const after = await stack.q(`SELECT seat_id, status, held_by FROM seats WHERE event_id=$1 ORDER BY seat_id`, [EVENT]);
    expect(after).toEqual(before);
  }, 60_000);
});
