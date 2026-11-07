import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mergeLoads, runLoad } from "../load";
import { settleAndCheck, startWorld, stopWorld, type World } from "./world";

const SEATS = 40, HOLD = 4;

/**
 * Two worlds, same load. With the pre-charge ownership check on (the default, ADR 007) a payment after the expiry is stopped before the
 * card is touched (FAILED). With it off (`VERIFY_HOLDS=0`, refused in production) the same payments are charged, confirm answers 409 and
 * they are refunded: that is the compensation path, which stays the answer for a hold that expires between the check and the confirm.
 */
for (const verify of [true, false]) {
  let w: World;
  describe(`fault 6: holds expire (HOLD_SECONDS=4), pre-charge check ${verify ? "on" : "off"}`, () => {
    // This scenario does not need an outage, but it shares the private-world helpers (and a private Postgres keeps the short expiry away from other suites).
    beforeAll(async () => { w = await startWorld(verify ? "expiry" : "expiryoff", { seats: SEATS, holdSeconds: HOLD, pspLatencyMs: 100, pspFailRate: 0.05, admitPerSecond: 200, seed: 4701, env: verify ? undefined : { payments: { VERIFY_HOLDS: "0" } } }); }, 180_000);
    afterAll(async () => { await stopWorld(w); }, 120_000);
    it(verify ? "a payment after the hold expired is stopped before the charge, freed seats are taken by others, and a seat re-held by B is never sold to A's late payment" : "a payment after the hold expired is charged and refunded, freed seats are taken by others, and a seat re-held by B is never sold to A's late payment", async () => {
      const s = w.stack;
      // wave A: 70 users for 40 seats. A third of the buyers wait longer than the hold lasts before paying; abandoners never pay.
      const waveA = runLoad({
        seed: 4701, users: 70, seats: SEATS, gateway: s.urls.gateway, concurrency: 70, deadlineMs: 90_000,
        mix: { abandoner: 0.25, cheater: 0, doubleSubmit: 0.1, impostor: 0 },
        payDelayMs: ({ index, kind }) => (kind === "buyer" && index % 3 === 0 ? 9000 : 0)
      }, s.runId);
      // wave B starts once the first holds have run out (HOLD + margin after A's first holds) and takes what was freed, before the late payers wake up
      await new Promise((r) => setTimeout(r, 6500));
      const waveB = runLoad({
        seed: 4702, users: 10, seats: SEATS, gateway: s.urls.gateway, concurrency: 10, deadlineMs: 90_000, userOffset: 1000,
        mix: { abandoner: 0, cheater: 0, doubleSubmit: 0, impostor: 0 }
      }, s.runId);
      const [a, b] = await Promise.all([waveA, waveB]);
      const all = mergeLoads(a, b);
      const { report, quiet } = await settleAndCheck(w, all, { seats: SEATS, holdSeconds: HOLD });

      const late = a.records.filter((r) => r.kind === "buyer" && r.index % 3 === 0 && r.payStatus !== undefined);
      const lateConfirmed = late.filter((r) => r.payStatus === "CONFIRMED");
      // late payers whose seat another user was granted afterwards
      const retaken = late.filter((r) => r.seats.some((seat) => {
        const gl = all.grantsTimed.get(seat) ?? [];
        const own = gl.findIndex((g) => g.user === r.userId);
        return own >= 0 && gl.slice(own + 1).some((g) => g.user !== r.userId);   // somebody else was granted the seat after A's hold
      }));
      const sold = new Map((await s.q<{ seat_id: number; held_by: string; status: string }>(`SELECT seat_id, held_by, status FROM seats`)).map((x) => [x.seat_id, x]));
      const soldToLatePayerAfterRetake = retaken.filter((r) => r.seats.some((seat) => sold.get(seat)?.status === "sold" && sold.get(seat)?.held_by === r.userId));
      const summary = report.summary as Record<string, number>;
      console.log("hold expiry:", quiet, JSON.stringify({ late: late.length, lateStatuses: Object.fromEntries([...new Set(late.map((r) => r.payStatus))].map((st) => [st, late.filter((r) => r.payStatus === st).length])), retaken: retaken.length, ...summary }));

      expect(report.violations.join("\n")).toBe("");
      expect(late.length).toBeGreaterThanOrEqual(5);
      // the hold was over when they paid: never CONFIRMED
      expect(lateConfirmed.map((r) => r.userId), "late payment confirmed after the hold expired").toEqual([]);
      if (verify) {
        // stopped by the ownership check: FAILED with the card untouched, so nobody is refunded in this run
        expect(late.filter((r) => r.payStatus === "FAILED").length).toBeGreaterThanOrEqual(3);
        expect(late.filter((r) => r.payStatus === "REFUNDED"), "refund although the check was on").toEqual([]);
      } else {
        // charged, confirm answered 409, refunded (or the card was declined first)
        expect(late.filter((r) => r.payStatus === "REFUNDED").length).toBeGreaterThanOrEqual(3);
      }
      // other users really got seats that had been held by wave A: the freed seats were reused
      expect(summary.regrants, "freed seats were reused").toBeGreaterThan(0);
      // the race that matters: B held the seat A's hold had covered, A paid late: A's payment was refunded and the seat stays B's
      expect(retaken.length).toBeGreaterThan(0);
      // ... and some late payers' seats were NOT taken by anybody: for them only the expiry check says no
      expect(late.length, "late payers whose seat stayed free").toBeGreaterThan(retaken.length);
      expect(retaken.filter((r) => r.payStatus !== "REFUNDED" && r.payStatus !== "FAILED")).toEqual([]);
      expect(soldToLatePayerAfterRetake).toEqual([]);
      expect(summary.confirmed).toBeGreaterThan(10);
    }, 230_000);
  });
}
