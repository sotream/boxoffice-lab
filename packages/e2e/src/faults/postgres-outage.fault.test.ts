import { afterEach, describe, expect, it } from "vitest";
import { runLoad } from "../load";
import { count, dumpLogs, ReadySampler, serverErrors, readyz, refundedNonCheaters, settleAndCheck, startWorld, stopWorld, type World } from "./world";

const SEATS = 80, USERS = 200, OUTAGE_MS = 12_000;
let w: World | undefined;
afterEach(async () => { await stopWorld(w); w = undefined; }, 120_000);

/**
 * Postgres is a container of this scenario only. Two shapes of outage:
 *  - pause: the kernel keeps every connection open and nobody answers (connections hang, queries never return);
 *  - stop/start: connections are reset and refused, then the server comes back from its own disk.
 * The services that use Postgres are inventory, payments (saga, sweeper, relay) and notifications; the gateway and the waiting room do not.
 */
async function run(mode: "pause" | "stop", seed: number) {
  w = await startWorld(`pg${mode}`, { seats: SEATS, pspLatencyMs: 150, pspFailRate: 0.1, admitPerSecond: 150, seed });
  const s = w.stack, pg = w.infra.pg;
  const sampler = new ReadySampler({ inventory: s.urls.inventory, payments: s.urls.payments, notifications: s.opsUrl, gateway: s.opsOf("gateway"), "waiting-room": s.urls["waiting-room"] });
  sampler.start();
  const load = runLoad({ seed, users: USERS, seats: SEATS, gateway: s.urls.gateway, concurrency: USERS, deadlineMs: 150_000 }, s.runId);

  await s.waitUntil(async () => (await count(s, "payments.payments")) >= 15, 60_000, 20);
  const before = { payments: await count(s, "payments.payments"), held: await count(s, "seats WHERE status <> 'free'") };
  const t0 = Date.now();
  if (mode === "pause") await pg.pause(); else await pg.stop();
  await new Promise((r) => setTimeout(r, OUTAGE_MS));   // the outage is a duration, not a condition: the services must simply ride it out
  const aliveDuring = ["inventory", "payments", "notifications", "gateway", "waiting-room"].map((n) => [n, s.alive(n)] as const);
  const t1 = Date.now();
  if (mode === "pause") await pg.unpause(); else await pg.start();
  const restored = Date.now();

  const stage = (m: string) => console.log(`[pg ${mode}] +${Math.round((Date.now() - t0) / 1000)}s ${m}`);
  stage("restored; waiting for the load");
  const result = await Promise.race([load, new Promise<never>((_, rej) => setTimeout(() => { dumpLogs(s); rej(new Error("load did not finish within 100 s of the restore")); }, 100_000))]);
  stage("load finished");
  const { report, quiet } = await settleAndCheck(w, result, { seats: SEATS, quiescentMs: 90_000 }).catch((e) => { dumpLogs(s); throw e; });
  stage("quiescent");
  // readiness must come back by itself (no restart): poll with a deadline
  const readyAgain = async () => (await Promise.all(["inventory", "payments", "notifications"].map((n) => readyz(n === "notifications" ? s.opsUrl : s.urls[n as "inventory" | "payments"])))).every((c) => c === 200);
  await s.waitUntil(readyAgain, 20_000, 300);
  sampler.stop();
  const during = (n: string) => sampler.between(n, t0 + 3000, t1);
  const afterwards = (n: string) => sampler.after(n, restored + 6000);
  const alive = Object.fromEntries(["inventory", "payments", "notifications", "gateway", "waiting-room"].map((n) => [n, s.alive(n)]));
  console.log(`postgres ${mode}:`, quiet, JSON.stringify({ before, outageMs: t1 - t0, readyDuring: Object.fromEntries(["inventory", "payments", "notifications", "gateway", "waiting-room"].map((n) => [n, [...new Set(during(n))]])), errors: serverErrors(result), ...report.summary }));
  const timeline = (n: string) => sampler.history.get(n)!.filter((h, i, a) => i === 0 || h.status !== a[i - 1].status).map((h) => `${((h.at - t0) / 1000).toFixed(1)}s:${h.status}`).join(" ");
  console.log(`[pg ${mode}] readiness transitions (t0 = outage start, outage end at ${((t1 - t0) / 1000).toFixed(1)}s): inventory ${timeline("inventory")} | payments ${timeline("payments")} | notifications ${timeline("notifications")}`);
  const wronglyRefunded = await refundedNonCheaters(s, result);
  return { wronglyRefunded, report, result, during, afterwards, alive, aliveDuring, before, sampler, s };
}

for (const [mode, seed] of [["pause", 4101], ["stop", 4102]] as const) {
  describe(`fault 2 (${mode}): Postgres ${mode === "pause" ? "paused (connections hang)" : "stopped and started (connections reset)"} for ${OUTAGE_MS / 1000} s in the middle of the sale`, () => {
    it("services survive, readiness goes 503 and recovers, no wrong success, every saga ends terminal, invariants hold", async () => {
      const r = await run(mode, seed);
      // nothing crashed, during or after
      expect(r.aliveDuring.filter(([, up]) => !up)).toEqual([]);
      expect(Object.entries(r.alive).filter(([, up]) => !up)).toEqual([]);
      // the services that need Postgres said so; the ones that do not stayed ready
      for (const n of ["inventory", "payments", "notifications"]) {
        const seen = r.during(n);
        expect(seen.length, `${n} readiness samples`).toBeGreaterThan(5);
        expect(seen.filter((x) => x === 200), `${n} readyz during the outage: ${[...new Set(seen)]}`).toEqual([]);   // never ready without a database (null = the probe itself got no answer)
        expect(seen.some((x) => x === 503), `${n} must answer 503, got ${[...new Set(seen)]}`).toBe(true);
      }
      for (const n of ["gateway", "waiting-room"]) expect(new Set(r.during(n)), `${n} does not depend on Postgres`).toEqual(new Set([200]));
      // clients felt it (5xx or timeouts) ...
      expect(serverErrors(r.result).length).toBeGreaterThan(0);
      // a database outage is "unknown", never "seats lost": nobody but cheaters was refunded
      expect(r.wronglyRefunded, "refund caused by the outage").toEqual([]);
      // ... and nothing wrong was reported as success (invariants include: the client's answer equals the stored row, seat model, money)
      expect(r.report.violations.join("\n")).toBe("");
      expect((r.report.summary as Record<string, number>).confirmed).toBeGreaterThan(10);
      expect(r.before.payments).toBeGreaterThanOrEqual(15);
    }, 280_000);
  });
}
