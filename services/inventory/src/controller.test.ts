import { BadRequestException, ConflictException } from "@nestjs/common";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, migrate, seed } from "./db";
import { InventoryController } from "./inventory.controller";
import { InventoryService } from "./inventory.service";

/** Controller contract on its own event id (9050): 409 on conflict, 400 on malformed bodies, strategy whitelist. */
const E = 9050;
const pool = createPool(10);
const ctl = new InventoryController(new InventoryService(pool));
beforeAll(async () => { await migrate(pool); await seed(pool, E, 12); });
afterAll(async () => { await pool.query("DELETE FROM seats WHERE event_id=$1", [E]); await pool.end(); });

describe("InventoryController", () => {
  it("hold -> conflict -> confirm -> availability", async () => {
    const h = await ctl.hold(E, { seatIds: [1, 2], userId: "a" }, "for-update");
    expect(h.seatIds).toEqual([1, 2]);
    await expect(ctl.hold(E, { seatIds: [2, 3], userId: "b" })).rejects.toBeInstanceOf(ConflictException);
    await expect(ctl.confirm(E, { seatIds: [1, 2], userId: "b" })).rejects.toBeInstanceOf(ConflictException);
    expect(await ctl.confirm(E, { seatIds: [1, 2], userId: "a" })).toEqual({ sold: [1, 2] });
    expect(await ctl.availability(E)).toEqual({ free: 10, held: 0, sold: 2 });
  });

  it("holds/verify: 200 for the holder, 409 for anybody else, 400 on a malformed body; it changes nothing", async () => {
    await ctl.hold(E, { seatIds: [5, 6], userId: "v1" });
    const before = await ctl.availability(E);
    expect(await ctl.verifyHolds(E, { seatIds: [5, 6], userId: "v1" })).toEqual({ held: [5, 6] });
    await expect(ctl.verifyHolds(E, { seatIds: [5, 6], userId: "v2" })).rejects.toBeInstanceOf(ConflictException);
    await expect(ctl.verifyHolds(E, { seatIds: [], userId: "v1" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctl.verifyHolds(E, { seatIds: [5], userId: 1 as never })).rejects.toBeInstanceOf(BadRequestException);
    expect(await ctl.availability(E)).toEqual(before);
  });

  it("any malformed hold body is a 400 (never reaches the database)", async () => {
    const before = await ctl.availability(E);
    await fc.assert(
      fc.asyncProperty(fc.oneof(
        fc.constant(undefined), fc.constant(null), fc.constant({}),
        fc.record({ seatIds: fc.constant([]), userId: fc.string() }),
        fc.record({ seatIds: fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 9, maxLength: 20 }), userId: fc.string() }),
        fc.record({ seatIds: fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 3 }), userId: fc.oneof(fc.integer(), fc.constant(null)) }),
        fc.record({ seatIds: fc.string(), userId: fc.string() })
      ), async (body) => {
        await expect(ctl.hold(E, body as never)).rejects.toBeInstanceOf(BadRequestException);
        await expect(ctl.confirm(E, body as never)).rejects.toBeInstanceOf(BadRequestException); // regression: used to be a 500 or an empty "success"
      }),
      { numRuns: 100 }
    );
    expect(await ctl.availability(E)).toEqual(before);
  });
});
