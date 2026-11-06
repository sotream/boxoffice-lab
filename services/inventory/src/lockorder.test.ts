import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, migrate, seed } from "./db";
import { InventoryService, Strategy } from "./inventory.service";

/**
 * A multi-row UPDATE locks rows in the order its plan visits them. A hold and a confirm that run under different plans
 * (here forced: the confirming connections cannot use indexes) lock overlapping seats in different orders and Postgres
 * kills one of them with 40P01 deadlock detected. The service must not leak that: it locks in seat_id order first.
 */
const EVENT = 9777;
const SEATS = 40;
const pool = createPool(40);
const confirmPool = createPool(20);
confirmPool.on("connect", (c) => { void c.query("SET enable_indexscan=off; SET enable_bitmapscan=off; SET enable_indexonlyscan=off"); });
const holds = new InventoryService(pool);
const confirms = new InventoryService(confirmPool);

beforeAll(async () => { await migrate(pool); });
afterAll(async () => { await pool.end(); await confirmPool.end(); });

for (const strategy of ["atomic-update", "for-update"] as Strategy[]) {
  describe(`lock order, ${strategy}`, () => {
    it("holds and confirms under different plans never deadlock", async () => {
      const errors: string[] = [];
      for (let round = 0; round < 40; round++) {
        await seed(pool, EVENT, SEATS);
        for (let s = SEATS; s >= 1; s -= 3) await pool.query("UPDATE seats SET status='free' WHERE event_id=$1 AND seat_id=$2", [EVENT, s]); // heap order != seat_id order
        const jobs: Promise<unknown>[] = [];
        for (let i = 0; i < 40; i++) {
          const seats = [1 + (i * 7) % SEATS, 1 + (i * 11 + 3) % SEATS, 1 + (i * 13 + 5) % SEATS];
          jobs.push(holds.hold(EVENT, seats, `u${i % 5}`, strategy).catch((e) => errors.push(String(e.code ?? e.message))));
          jobs.push(confirms.confirm(EVENT, seats, `u${i % 5}`).catch((e) => errors.push(String(e.code ?? e.message))));
        }
        await Promise.all(jobs);
      }
      expect(errors).toEqual([]);
    }, 120_000);
  });
}
