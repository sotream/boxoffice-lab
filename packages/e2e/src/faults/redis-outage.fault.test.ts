import { signAdmission } from "@boxoffice/admission";
import Redis from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { EVENT, runLoad } from "../load";
import { SECRET, INTERNAL_TOKEN } from "../stack";
import { count, ReadySampler, settleAndCheck, startWorld, stopWorld, type World } from "./world";

const SEATS = 300, USERS = 120, OUTAGE_MS = 10_000;
let w: World | undefined;
afterEach(async () => { await stopWorld(w); w = undefined; }, 120_000);

const timed = async (url: string, init?: RequestInit) => {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    const text = await r.text();
    return { status: r.status, retryAfter: r.headers.get("retry-after"), ms: Date.now() - t0, body: text };
  } catch { return { status: 0, retryAfter: null, ms: Date.now() - t0, body: "" }; }
};

/**
 * Redis is a container of this scenario. It serves the waiting room (queue, admission keys) and the gateway (rate limiter buckets).
 *  - stop/start: Redis comes back EMPTY (started without persistence, the harsher case): queue, admission keys and buckets are gone.
 *  - pause: commands hang, nothing is lost.
 */
async function run(mode: "pause" | "stop", seed: number) {
  // a slow admission keeps people waiting in the queue when the fault hits
  w = await startWorld(`redis${mode}`, { seats: SEATS, pspLatencyMs: 100, pspFailRate: 0.1, admitPerSecond: 20, seed });
  const s = w.stack, rd = w.infra.redis;
  const admin = new Redis(w.infra.redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true }); admin.on("error", () => undefined);
  await admin.connect();
  const sampler = new ReadySampler({ "waiting-room": s.urls["waiting-room"], gateway: s.opsOf("gateway") });
  sampler.start();
  const load = runLoad({ seed, users: USERS, seats: SEATS, gateway: s.urls.gateway, concurrency: USERS, deadlineMs: 150_000 }, s.runId);

  await s.waitUntil(async () => (await admin.zcard(`wr:${EVENT}:queue`)) >= 20 && (await count(s, "payments.payments")) >= 8, 60_000, 50);
  const queuedBefore = await admin.zcard(`wr:${EVENT}:queue`);
  const admittedKeysBefore = (await admin.keys(`wr:${EVENT}:admitted:*`)).length;
  const bucketsBefore = (await admin.keys("rl:*")).length;
  const seatsBefore = await s.q(`SELECT seat_id, status, held_by FROM seats ORDER BY seat_id`);
  const paymentsBefore = await count(s, "payments.payments");
  const t0 = Date.now();
  if (mode === "pause") await rd.pause(); else await rd.stop();
  await new Promise((r) => setTimeout(r, 2500)); // the gateway's connection notices

  // ---- probes while Redis is away (a forged but correctly signed admission token for a user the load does not know) ----
  const probeUser = `${s.userPrefix}probe`;
  const token = signAdmission(probeUser, EVENT, 60, SECRET);
  const hdr = { "content-type": "application/json", "x-admission": token, "idempotency-key": "probe-key" };
  const probes = {
    availability: await timed(`${s.urls.gateway}/events/${EVENT}/availability`),
    hold: await timed(`${s.urls.gateway}/events/${EVENT}/holds`, { method: "POST", headers: hdr, body: JSON.stringify({ seatIds: [SEATS], userId: probeUser }) }),
    pay: await timed(`${s.urls.gateway}/events/${EVENT}/pay`, { method: "POST", headers: hdr, body: JSON.stringify({ eventId: EVENT, userId: probeUser, seatIds: [SEATS], amountCents: 2500 }) }),
    join: await timed(`${s.urls.gateway}/events/${EVENT}/queue/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: probeUser }) }),
    queueDirect: await timed(`${s.urls["waiting-room"]}/events/${EVENT}/queue/status?userId=${probeUser}`)
  };
  const seatsDuring = await s.q(`SELECT seat_id, status, held_by FROM seats WHERE seat_id = ${SEATS}`);
  const probeSeat = seatsDuring[0] as { status: string; held_by: string | null };
  const probePayments = await count(s, "payments.payments WHERE user_id=$1", [probeUser]);
  // asserted here, while Redis is still away (a failing assertion must name the policy that broke, not a later symptom)
  {
    const p = probes;
    // fail closed on anything that spends scarce things, fast and with Retry-After
    for (const k of ["hold", "pay", "join"] as const) {
      expect(p[k].status, `${k} while Redis is away`).toBe(503);
      expect(p[k].retryAfter, `${k} Retry-After`).toBe("1");
      expect(p[k].ms, `${k} must fail fast (the limiter times out after 200 ms)`).toBeLessThan(2500);
    }
    // fail open on the public read, also fast
    expect(p.availability.status).toBe(200);
    expect(p.availability.ms).toBeLessThan(2500);
    // the refused hold and pay changed nothing
    expect(probeSeat.status).not.toBe("sold");
    expect(probeSeat.held_by === null || !probeSeat.held_by.endsWith("-probe")).toBe(true);
    expect(probePayments).toBe(0);
  }
  await new Promise((r) => setTimeout(r, Math.max(0, OUTAGE_MS - (Date.now() - t0))));
  const aliveDuring = ["gateway", "waiting-room", "inventory", "payments"].map((n) => [n, s.alive(n)] as const);
  const t1 = Date.now();
  const gwReadyBody = await (await fetch(`${s.opsOf("gateway")}/readyz`)).json() as { status: string; checks: Record<string, { ok: boolean }> };
  if (mode === "pause") await rd.unpause(); else await rd.start();
  const restored = Date.now();
  const queueAfterRestart = await admin.zcard(`wr:${EVENT}:queue`).catch(() => -1);
  const keysAfterRestart = mode === "stop" ? (await admin.keys(`wr:${EVENT}:admitted:*`)).length : -1;

  const result = await load;
  // a fresh purchase after recovery, from a user who never took part: join, wait to be admitted, hold, pay
  const fresh = await runLoad({ seed: seed + 1, users: 6, seats: SEATS, gateway: s.urls.gateway, concurrency: 6, deadlineMs: 60_000, userOffset: 5000, mix: { abandoner: 0, cheater: 0, doubleSubmit: 0, impostor: 0 } }, s.runId);
  const { mergeLoads } = await import("../load");
  const all = mergeLoads(result, fresh);
  const { report, quiet } = await settleAndCheck(w, all, { seats: SEATS, quiescentMs: 120_000 });
  sampler.stop();
  await admin.quit().catch(() => undefined);
  const rejoins = result.stats.get("queue:unknown-rejoin") ?? 0;
  console.log(`redis ${mode}:`, quiet, JSON.stringify({ queuedBefore, admittedKeysBefore, bucketsBefore, paymentsBefore, queueAfterRestart, keysAfterRestart, rejoins, probes: Object.fromEntries(Object.entries(probes).map(([k, v]) => [k, `${v.status}/${v.retryAfter}/${v.ms}ms`])), ...report.summary }));
  return { report, result, fresh, probes, probeSeat, probePayments, seatsBefore, aliveDuring, sampler, t0, t1, restored, queuedBefore, queueAfterRestart, keysAfterRestart, admittedKeysBefore, rejoins, gwReadyBody, s };
}

describe("fault 4: Redis away for 10 s in the middle of the sale", () => {
  for (const [mode, seed] of [["stop", 4401], ["pause", 4402]] as const) {
    it(`${mode}: ${mode === "stop" ? "comes back EMPTY" : "commands hang, nothing is lost"}: holds and pay fail closed (503 + Retry-After), reads fail open, nothing is oversold, the sale completes after recovery`, async () => {
      const r = await run(mode, seed);
      const p = r.probes;
      // the waiting room says it is not ready; the gateway stays ready but reports redis as down (soft dependency)
      expect(r.sampler.between("waiting-room", r.t0 + 4000, r.t1).filter((x) => x === 200)).toEqual([]);
      expect(r.sampler.between("waiting-room", r.t0 + 4000, r.t1).some((x) => x === 503)).toBe(true);
      expect(new Set(r.sampler.between("gateway", r.t0 + 4000, r.t1))).toEqual(new Set([200]));
      expect(r.gwReadyBody.checks.redis?.ok).toBe(false);
      // processes survived, readiness recovered without a restart
      expect(r.aliveDuring.filter(([, up]) => !up)).toEqual([]);
      expect(new Set(r.sampler.after("waiting-room", r.restored + 6000))).toEqual(new Set([200]));
      expect(new Set(r.sampler.after("gateway", r.restored + 6000))).toEqual(new Set([200]));

      if (mode === "stop") {
        // documented policy (waiting-room ADR 001): without persistence a Redis restart loses the queue and the admission keys.
        expect(r.queuedBefore).toBeGreaterThan(0);
        // (the queue itself cannot be read empty reliably: waiting clients re-join within milliseconds of the restart; the clients' own answers prove the loss)
        expect(r.keysAfterRestart).toBe(0);
        // ... and the users who were waiting find out ("unknown"), re-join (at the end of the new queue) and still complete: order is lost, not money
        expect(r.rejoins, "every user who was waiting found out and re-joined").toBeGreaterThanOrEqual(r.queuedBefore);
      } else {
        // paused: the same connections resume and nothing is lost
        expect(r.queueAfterRestart).toBeGreaterThan(0);
        // the queue is intact; at most a handful of users can still fall into the ZPOPMIN-then-SET window (waiting-room ADR 001), which the stall widens
        expect(r.rejoins).toBeLessThan(10);
      }
      // admission tokens are signed, not stored: users admitted before the outage still hold valid tokens afterwards (every client finished: see the invariants)
      expect(r.report.violations.join("\n")).toBe("");
      // new purchases work after recovery
      expect(r.fresh.records.filter((x) => x.error)).toEqual([]);
      expect(r.fresh.records.filter((x) => x.payStatus !== undefined).length, "fresh purchases after recovery").toBeGreaterThanOrEqual(4);
      expect((r.report.summary as Record<string, number>).confirmed).toBeGreaterThan(10);
      void INTERNAL_TOKEN;
    }, 280_000);
  }
});
