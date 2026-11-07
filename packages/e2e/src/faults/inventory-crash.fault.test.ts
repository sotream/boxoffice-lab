import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runLoad } from "../load";
import { Stack } from "../stack";
import { count, settleAndCheck, startWorld, stopWorld, type World } from "./world";

const SEATS = 80, USERS = 200;
let w: World;
beforeAll(async () => { w = await startWorld("invcrash", { seats: SEATS, pspLatencyMs: 150, pspFailRate: 0.1, admitPerSecond: 150, seed: 4001 }); }, 180_000);
afterAll(async () => { await stopWorld(w); }, 120_000);

const states = async (s: Stack) => Object.fromEntries((await s.q<{ status: string; n: string }>(`SELECT status, count(*) n FROM payments.payments GROUP BY status`)).map((r) => [r.status, Number(r.n)]));

describe("fault 1: kill -9 of inventory in the middle of the sale", () => {
  it("holds survive in Postgres, confirms that hit the dead inventory are finished by the sweeper (never refunded), invariants hold", async () => {
    const s = w.stack;
    const grantsLive = new Map<number, string[]>();
    const load = runLoad({ seed: 4001, users: USERS, seats: SEATS, gateway: s.urls.gateway, concurrency: USERS, deadlineMs: 120_000, grantsLive }, s.runId);

    // crash when payments are in flight and a good part of the seats is held
    await s.waitUntil(async () => (await count(s, "payments.payments")) >= 15 && grantsLive.size >= 25, 60_000, 20);
    const promised = new Map([...grantsLive].map(([seat, users]) => [seat, users[0]]));   // every seat answered 200 before the crash
    const refundsBefore = await count(s, "payments.payments WHERE status IN ('REFUNDING','REFUNDED')");
    await s.kill("inventory");
    expect((await s.procs.get("inventory")!.exited).signal).toBe("SIGKILL");
    const killedAt = Date.now();

    // the outage: new confirms cannot reach inventory. Wait (deadline) until payments pile up charged-but-unconfirmed, and at least 6 s
    await s.waitUntil(async () => (await count(s, "payments.payments WHERE status='CHARGED'")) >= 3 && Date.now() - killedAt > 6000, 40_000, 200).catch(() => undefined); // asserted below, after the refund checks, so a wrong refund is reported as such
    const midOutage = await states(s);
    // the holds answered 201 are still in the database while inventory is dead
    const rows = await s.q<{ seat_id: number; status: string; held_by: string }>(`SELECT seat_id, status, held_by FROM seats WHERE seat_id = ANY($1)`, [[...promised.keys()]]);
    const lostDuringOutage = rows.filter((r) => r.held_by !== promised.get(r.seat_id) || !["held", "sold"].includes(r.status));
    const refundsDuringOutage = await count(s, "payments.payments WHERE status IN ('REFUNDING','REFUNDED')");
    const chargedAtRestart = await count(s, "payments.payments WHERE status='CHARGED'");

    await s.start("inventory", { SEED_SEATS: "0" }); // same port; seeding again would delete the seats
    const resumedBefore = (await s.counter(s.urls.payments, "payments_sweeper_resumed_total")) ?? 0;

    const result = await load;
    const { report, quiet } = await settleAndCheck(w, result, { seats: SEATS });
    const resumed = ((await s.counter(s.urls.payments, "payments_sweeper_resumed_total")) ?? 0) - resumedBefore;
    // after the restart: all promised holds are still the same users' (held or sold)
    const after = await s.q<{ seat_id: number; status: string; held_by: string }>(`SELECT seat_id, status, held_by FROM seats WHERE seat_id = ANY($1)`, [[...promised.keys()]]);
    const lostAfter = after.filter((r) => r.held_by !== promised.get(r.seat_id) || !["held", "sold"].includes(r.status));
    // who was refunded: only users who paid for seats that were not theirs
    const kindOf = new Map(result.records.map((r) => [r.userId, r.kind]));
    const refundedPayments = await s.q<{ user_id: string }>(`SELECT user_id FROM payments.payments WHERE status='REFUNDED'`);
    const refundedNonCheaters = refundedPayments.filter((r) => kindOf.get(r.user_id) !== "cheater").map((r) => r.user_id);
    console.log("inventory crash:", quiet, JSON.stringify({ promisedSeats: promised.size, midOutage, chargedAtRestart, refundsBefore, refundsDuringOutage, sweeperResumed: resumed, ...report.summary }));

    expect(report.violations.join("\n")).toBe("");
    expect(promised.size).toBeGreaterThanOrEqual(25);
    expect(lostDuringOutage).toEqual([]);
    expect(lostAfter).toEqual([]);
    // an unreachable inventory is "unknown", never "seats lost": nothing was refunded because of the outage ...
    expect(refundsDuringOutage, "refund caused by the outage").toBe(refundsBefore);
    // ... and in the whole run only cheaters (who paid for seats held by someone else) were refunded
    expect(refundedNonCheaters, "refund caused by the outage").toEqual([]);
    // the outage really caught sagas in the middle: charged, confirm unreachable, no verdict
    expect(chargedAtRestart).toBeGreaterThanOrEqual(3);
    // the sweeper (not a client retry alone) finished the stuck sagas
    expect(resumed, "sweeper resumed nothing").toBeGreaterThan(0);
    expect((report.summary as Record<string, number>).confirmed).toBeGreaterThan(10);
  }, 230_000);
});
