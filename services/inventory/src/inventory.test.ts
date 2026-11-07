import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, migrate, seed } from "./db";
import { HOLD_SECONDS, InventoryService, Strategy } from "./inventory.service";

const pool = createPool(50);
const svc = new InventoryService(pool);
const EVENT = 900;

beforeAll(async () => { await migrate(pool); });
beforeEach(async () => { await seed(pool, EVENT, 20); });
afterAll(async () => { await pool.end(); });

for (const strategy of ["atomic-update", "for-update"] as Strategy[]) {
  describe(strategy, () => {
    it("never double-books one seat under 100 concurrent holders", async () => {
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) => svc.hold(EVENT, [1], `user-${i}`, strategy))
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
    });

    it("is all-or-nothing for multi-seat holds", async () => {
      expect((await svc.hold(EVENT, [1, 2], "a", strategy)).ok).toBe(true);
      expect((await svc.hold(EVENT, [2, 3], "b", strategy)).ok).toBe(false);
      expect((await svc.availability(EVENT)).free).toBe(18);
    });

    it("invariant: no seat is held by two users, and held seats equal the sum of successful holds", async () => {
      // Deterministic pseudo-random overlapping sets of 1 to 3 seats out of 20, from 200 concurrent users.
      let x = 12345;
      const rnd = (n: number) => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x % n; };
      const wants = Array.from({ length: 200 }, (_, i) => {
        const size = 1 + rnd(3);
        const set = new Set<number>();
        while (set.size < size) set.add(1 + rnd(20));
        return { user: `u${i}`, seats: [...set] };
      });
      const results = await Promise.all(wants.map((w) => svc.hold(EVENT, w.seats, w.user, strategy)));
      const winners = wants.filter((_, i) => results[i].ok);
      const claimed = winners.flatMap((w) => w.seats);
      expect(new Set(claimed).size).toBe(claimed.length); // winners' seat sets are pairwise disjoint
      const rows = (await pool.query("SELECT seat_id, held_by FROM seats WHERE event_id=$1 AND status='held'", [EVENT])).rows;
      expect(rows).toHaveLength(claimed.length);
      for (const w of winners) for (const s of w.seats) expect(rows.find((r) => r.seat_id === s)?.held_by).toBe(w.user);
    });

    it("does not deadlock on overlapping seat sets in opposite order", async () => {
      const rs = await Promise.all(
        Array.from({ length: 40 }, (_, i) => svc.hold(EVENT, i % 2 ? [4, 5] : [5, 4], `u${i}`, strategy))
      );
      expect(rs.filter((r) => r.ok)).toHaveLength(1);
    });
  });
}

describe("lifecycle", () => {
  it("expired holds become free again", async () => {
    await svc.hold(EVENT, [7], "a");
    await pool.query("UPDATE seats SET hold_until = now() - interval '1 second' WHERE event_id=$1 AND seat_id=7", [EVENT]);
    expect((await svc.hold(EVENT, [7], "b")).ok).toBe(true);
  });

  it("only the holder can confirm, and not after expiry", async () => {
    await svc.hold(EVENT, [8], "a");
    expect(await svc.confirm(EVENT, [8], "intruder")).toBe(false);
    expect(await svc.confirm(EVENT, [8], "a")).toBe(true);
    expect(await svc.confirm(EVENT, [8], "a")).toBe(true); // retry after a lost response is safe
    expect(await svc.confirm(EVENT, [8], "intruder")).toBe(false);
    await svc.hold(EVENT, [9], "a");
    await pool.query("UPDATE seats SET hold_until = now() - interval '1 second' WHERE event_id=$1 AND seat_id=9", [EVENT]);
    expect(await svc.confirm(EVENT, [9], "a")).toBe(false);
  });
});

describe("hold duration (HOLD_SECONDS)", () => {
  it("defaults to 600 s and follows the configured value, for both strategies and for expiry", async () => {
    const e = 901;
    await seed(pool, e, 6);
    const def = await svc.hold(e, [1], "a");
    expect(def.ok && Math.round((def.holdUntil.getTime() - Date.now()) / 1000)).toBe(HOLD_SECONDS);
    const short = new InventoryService(pool, 1);
    for (const [strategy, seat] of [["atomic-update", 2], ["for-update", 3]] as const) {
      const r = await short.hold(e, [seat], "b", strategy);
      expect(r.ok && Math.round((r.holdUntil.getTime() - Date.now()) / 1000)).toBe(1);
    }
    expect(await short.confirm(e, [2], "b")).toBe(true);           // inside the hold
    await new Promise((r) => setTimeout(r, 1300));
    expect(await short.confirm(e, [3], "b")).toBe(false);           // expired: refused, as it must be
    expect((await svc.hold(e, [3], "c")).ok).toBe(true);            // and the seat can be taken by somebody else
    expect((await svc.hold(e, [1], "c")).ok).toBe(false);           // the default hold is still valid
  });
});

describe("verifyHolds (the read-only question payments asks before it charges)", () => {
  it("true only when the user holds every one of the seats now", async () => {
    await svc.hold(EVENT, [1, 2], "a", "atomic-update");
    await svc.hold(EVENT, [3], "b", "atomic-update");
    expect(await svc.verifyHolds(EVENT, [1, 2], "a")).toBe(true);
    expect(await svc.verifyHolds(EVENT, [2, 1], "a")).toBe(true);        // order does not matter
    expect(await svc.verifyHolds(EVENT, [1, 1, 2], "a")).toBe(true);     // duplicates do not count twice
    expect(await svc.verifyHolds(EVENT, [1, 2], "b")).toBe(false);       // somebody else's seats
    expect(await svc.verifyHolds(EVENT, [1, 3], "a")).toBe(false);       // one of them is someone else's
    expect(await svc.verifyHolds(EVENT, [1, 4], "a")).toBe(false);       // one of them is free
    expect(await svc.verifyHolds(EVENT, [999], "a")).toBe(false);        // no such seat
    expect(await svc.verifyHolds(EVENT + 1, [1, 2], "a")).toBe(false);   // another event
  });

  it("an expired hold is not a hold; a sold seat still belongs to its buyer", async () => {
    await svc.hold(EVENT, [5], "a", "atomic-update");
    await svc.hold(EVENT, [6], "a", "atomic-update");
    await svc.confirm(EVENT, [6], "a");
    await pool.query("UPDATE seats SET hold_until = now() - interval '1 second' WHERE event_id=$1 AND seat_id=5", [EVENT]);
    expect(await svc.verifyHolds(EVENT, [5], "a")).toBe(false);
    expect(await svc.verifyHolds(EVENT, [6], "a")).toBe(true);
    expect(await svc.verifyHolds(EVENT, [6], "b")).toBe(false);
  });

  it("takes no lock and writes nothing", async () => {
    await svc.hold(EVENT, [7], "a", "atomic-update");
    const before = (await pool.query("SELECT status, held_by, hold_until FROM seats WHERE event_id=$1 ORDER BY seat_id", [EVENT])).rows;
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM seats WHERE event_id=$1 AND seat_id=7 FOR UPDATE", [EVENT]); // a writer holds the row
      expect(await svc.verifyHolds(EVENT, [7], "a")).toBe(true);                                      // the read does not wait for it
    } finally { await holder.query("ROLLBACK"); holder.release(); }
    expect((await pool.query("SELECT status, held_by, hold_until FROM seats WHERE event_id=$1 ORDER BY seat_id", [EVENT])).rows).toEqual(before);
  });
});
