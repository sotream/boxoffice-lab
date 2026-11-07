import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runLoad } from "../load";
import { count, refundedNonCheaters, serverErrors, settleAndCheck, startWorld, stopWorld, type World } from "./world";

const SEATS = 80, USERS = 200, LOCK_MS = 10_000;
let w: World;
beforeAll(async () => { w = await startWorld("invlock", { seats: SEATS, pspLatencyMs: 150, pspFailRate: 0.1, admitPerSecond: 150, seed: 4901 }); }, 180_000);
afterAll(async () => { await stopWorld(w); }, 120_000);

describe("fault 9: only inventory's database access fails (the seats table is locked for 10 s), payments and everything else keep a working Postgres", () => {
  it("inventory answers 5xx after its 5 s statement timeout; payments reads that as unknown (no refund), the sweeper finishes the sagas afterwards, invariants hold", async () => {
    const s = w.stack;
    const grantsLive = new Map<number, string[]>();
    const load = runLoad({ seed: 4901, users: USERS, seats: SEATS, gateway: s.urls.gateway, concurrency: USERS, deadlineMs: 150_000, grantsLive }, s.runId);
    await s.waitUntil(async () => (await count(s, "payments.payments")) >= 15 && grantsLive.size >= 25, 60_000, 20);

    const refundsBefore = await count(s, "payments.payments WHERE status IN ('REFUNDING','REFUNDED')"); // cheaters legitimately get refunds before the lock
    // A lock that makes every statement of inventory on `seats` wait. Payments, notifications and the readiness checks do not touch that table.
    const locker = new Client({ connectionString: w.infra.pgUrl }); locker.on("error", () => undefined);
    await locker.connect();
    await locker.query("BEGIN");
    await locker.query("LOCK TABLE seats IN ACCESS EXCLUSIVE MODE");
    const lockedAt = Date.now();
    await new Promise((r) => setTimeout(r, LOCK_MS));
    // the dependent service is reported as ready (its own SELECT 1 works) but its work fails; nothing was refunded for it
    const invReady = (await fetch(`${s.urls.inventory}/readyz`)).status;
    const refundsDuring = await count(s, "payments.payments WHERE status IN ('REFUNDING','REFUNDED')");
    const chargedDuring = await count(s, "payments.payments WHERE status='CHARGED'");
    const alive = ["inventory", "payments", "gateway"].map((n) => [n, s.alive(n)] as const);
    await locker.query("COMMIT"); await locker.end();
    const lockMs = Date.now() - lockedAt;

    const result = await load;
    const { report, quiet } = await settleAndCheck(w, result, { seats: SEATS, quiescentMs: 120_000 });
    const wronglyRefunded = await refundedNonCheaters(s, result);
    const errors = serverErrors(result);
    console.log("inventory db lock:", quiet, JSON.stringify({ lockMs, invReady, refundsDuring, chargedDuring, errors, ...report.summary }));

    expect(alive.filter(([, up]) => !up)).toEqual([]);
    expect(refundsDuring, "refund caused by the outage").toBe(refundsBefore);
    expect(wronglyRefunded, "refund caused by the outage").toEqual([]);
    expect(errors.length, "clients must have felt the locked table").toBeGreaterThan(0);
    expect(chargedDuring, "sagas caught in CHARGED by the failing inventory").toBeGreaterThan(0);
    expect(invReady).toBe(200);
    expect(report.violations.join("\n")).toBe("");
    expect((report.summary as Record<string, number>).confirmed).toBeGreaterThan(10);
  }, 280_000);
});
