import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, migrate, seed } from "./db";
import { InventoryService, Strategy } from "./inventory.service";

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
