import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, migrate, seed } from "./db";
import { InventoryService, Strategy } from "./inventory.service";

/**
 * Model-based and concurrent invariant tests against the real Postgres.
 * Own event id range (9000+) so nothing collides with inventory.test.ts or the other services.
 * Re-run a failure with the seed fast-check prints:  FC_SEED=<seed> pnpm --filter @boxoffice/inventory test
 */
const SEED = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;
const pool = createPool(50);
const svc = new InventoryService(pool);
const SEATS = 6;
const USERS = ["u0", "u1", "u2"];

beforeAll(async () => { await migrate(pool); });
afterAll(async () => { await pool.query("DELETE FROM seats WHERE event_id >= 9000 AND event_id < 9100"); await pool.end(); });

// ---------- reference model ----------
type Cell = { st: "free" } | { st: "held"; by: string; expired: boolean } | { st: "sold"; by: string };
class Model {
  cells = new Map<number, Cell>();
  constructor() { for (let s = 1; s <= SEATS; s++) this.cells.set(s, { st: "free" }); }
  private takeable(c: Cell) { return c.st === "free" || (c.st === "held" && c.expired); }
  hold(user: string, seats: number[]): boolean {
    const ids = [...new Set(seats)];
    if (!ids.every((s) => this.takeable(this.cells.get(s)!))) return false;
    for (const s of ids) this.cells.set(s, { st: "held", by: user, expired: false });
    return true;
  }
  confirm(user: string, seats: number[]): boolean {
    const ids = [...new Set(seats)];
    const ok = ids.every((s) => {
      const c = this.cells.get(s)!;
      return (c.st === "held" && c.by === user && !c.expired) || (c.st === "sold" && c.by === user);
    });
    if (!ok) return false; // all-or-nothing: a failed confirm must leave every seat untouched
    for (const s of ids) this.cells.set(s, { st: "sold", by: user });
    return true;
  }
  expire(seats: number[]) {
    for (const s of seats) { const c = this.cells.get(s)!; if (c.st === "held") c.expired = true; }
  }
  availability() {
    let free = 0, held = 0, sold = 0;
    for (const c of this.cells.values()) {
      if (c.st === "sold") sold++; else if (c.st === "held" && !c.expired) held++; else free++;
    }
    return { free, held, sold };
  }
}

// ---------- commands ----------
type Cmd =
  | { k: "hold"; user: string; seats: number[] }
  | { k: "confirm"; user: string; seats: number[] }
  | { k: "expire"; seats: number[] }
  | { k: "availability" };

const seatsArb = fc.uniqueArray(fc.integer({ min: 1, max: SEATS }), { minLength: 1, maxLength: 3 });
const userArb = fc.constantFrom(...USERS);
const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ k: fc.constant("hold" as const), user: userArb, seats: seatsArb }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("confirm" as const), user: userArb, seats: seatsArb }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("expire" as const), seats: seatsArb }) },
  { weight: 1, arbitrary: fc.constant({ k: "availability" as const }) }
);

async function expireInDb(eventId: number, seats: number[]) {
  await pool.query("UPDATE seats SET hold_until = now() - interval '1 second' WHERE event_id=$1 AND seat_id = ANY($2) AND status='held'", [eventId, seats]);
}
async function dbCells(eventId: number) {
  return (await pool.query(
    "SELECT seat_id, status, held_by, hold_until < now() AS expired FROM seats WHERE event_id=$1 ORDER BY seat_id", [eventId])).rows as
    { seat_id: number; status: string; held_by: string | null; expired: boolean | null }[];
}

describe.each([["atomic-update", 9000], ["for-update", 9010]] as [Strategy, number][])("%s", (strategy, EVENT) => {
  it("model-based: every command agrees with the in-memory reference model, step by step", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(cmdArb, { minLength: 1, maxLength: 30 }), async (cmds) => {
        await seed(pool, EVENT, SEATS);
        const m = new Model();
        for (const c of cmds) {
          if (c.k === "hold") {
            const r = await svc.hold(EVENT, c.seats, c.user, strategy);
            expect(r.ok, JSON.stringify(c)).toBe(m.hold(c.user, c.seats));
          } else if (c.k === "confirm") {
            expect(await svc.confirm(EVENT, c.seats, c.user), JSON.stringify(c)).toBe(m.confirm(c.user, c.seats));
          } else if (c.k === "expire") {
            await expireInDb(EVENT, c.seats);
            m.expire(c.seats);
          } else {
            expect(await svc.availability(EVENT), "availability").toEqual(m.availability());
          }
          // full state comparison after every command, not only the commands that report it
          expect(await svc.availability(EVENT)).toEqual(m.availability());
          for (const row of await dbCells(EVENT)) {
            const c2 = m.cells.get(row.seat_id)!;
            expect(row.status === "sold" ? "sold" : row.status === "held" && row.expired ? "free" : row.status).toBe(c2.st === "held" && c2.expired ? "free" : c2.st);
            if (c2.st === "sold") expect(row.held_by).toBe(c2.by);
            if (c2.st === "held" && !c2.expired) expect(row.held_by).toBe(c2.by);
          }
        }
      }),
      { numRuns: 100, seed: SEED }
    );
  }, 60_000);
});

// ---------- concurrent variant ----------
describe.each([["atomic-update", 9020], ["for-update", 9030]] as [Strategy, number][])("%s under concurrency", (strategy, EVENT) => {
  const batchArb = fc.array(
    fc.oneof(
      { weight: 6, arbitrary: fc.record({ k: fc.constant("hold" as const), user: userArb, seats: seatsArb }) },
      { weight: 3, arbitrary: fc.record({ k: fc.constant("confirm" as const), user: userArb, seats: seatsArb }) },
      { weight: 1, arbitrary: fc.constant({ k: "availability" as const }) }
    ),
    { minLength: 2, maxLength: 14 }
  );

  it("random batches of simultaneous commands keep every invariant", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(batchArb, fc.array(fc.integer({ min: 1, max: SEATS }), { maxLength: 3 })), { minLength: 1, maxLength: 5 }), async (batches) => {
        await seed(pool, EVENT, SEATS);
        for (const [batch, toExpire] of batches) {
          const before = await dbCells(EVENT);
          const soldBefore = new Map(before.filter((r) => r.status === "sold").map((r) => [r.seat_id, r.held_by]));
          const heldBefore = (await svc.availability(EVENT)).held;

          const results = await Promise.all(batch.map(async (c) => {
            if (c.k === "hold") return { c, ok: (await svc.hold(EVENT, c.seats, c.user, strategy)).ok };
            if (c.k === "confirm") return { c, ok: await svc.confirm(EVENT, c.seats, c.user) };
            const a = await svc.availability(EVENT);
            expect(a.free + a.held + a.sold, "availability adds up while racing").toBe(SEATS);
            return { c, ok: true };
          }));

          const wonHolds = results.filter((r) => r.c.k === "hold" && r.ok).map((r) => r.c as Extract<Cmd, { k: "hold" }>);
          // 1. no seat is won by two holds of one batch
          const claimed = wonHolds.flatMap((w) => w.seats);
          expect(new Set(claimed).size, "a seat was held by two users").toBe(claimed.length);

          const after = await dbCells(EVENT);
          const avail = await svc.availability(EVENT);
          // 2. counts add up to total
          expect(avail.free + avail.held + avail.sold).toBe(SEATS);
          // 3. a sold seat is never re-held or re-assigned
          for (const r of after) if (soldBefore.has(r.seat_id)) {
            expect(r.status).toBe("sold");
            expect(r.held_by).toBe(soldBefore.get(r.seat_id));
          }
          // 4. every seat held/sold after the batch belongs to a user that was entitled to it
          for (const r of after) {
            if (r.status === "free") continue;
            const winners = wonHolds.filter((w) => w.seats.includes(r.seat_id));
            if (soldBefore.has(r.seat_id)) continue;
            if (winners.length === 0) { // untouched by this batch: must be as before
              const b = before.find((x) => x.seat_id === r.seat_id)!;
              expect(r.held_by).toBe(b.held_by);
              continue;
            }
            expect(r.held_by).toBe(winners[0].user);
          }
          // 5. a successful confirm means all its seats are sold to that user
          for (const { c, ok } of results) if (c.k === "confirm" && ok) {
            for (const s of c.seats) {
              const row = after.find((x) => x.seat_id === s)!;
              expect(row.status).toBe("sold");
              expect(row.held_by).toBe(c.user);
            }
          }
          // 6. held == held_before + sum of successful holds - seats that moved held -> sold in this batch
          const soldAfter = after.filter((r) => r.status === "sold").length;
          expect(avail.held).toBe(heldBefore + claimed.length - (soldAfter - soldBefore.size));
          // 7. confirm is idempotent for the owner and never succeeds for anybody else
          for (const r of after.filter((x) => x.status === "sold")) {
            expect(await svc.confirm(EVENT, [r.seat_id], r.held_by!)).toBe(true);
            expect(await svc.confirm(EVENT, [r.seat_id], r.held_by!)).toBe(true);
            for (const other of USERS.filter((u) => u !== r.held_by)) expect(await svc.confirm(EVENT, [r.seat_id], other)).toBe(false);
          }
          if (toExpire.length) await expireInDb(EVENT, toExpire);
        }
      }),
      { numRuns: 40, seed: SEED }
    );
  }, 90_000);

  it("contention stress: 150 users, overlapping 1-3 seat sets over 10 seats, never an overlap and totals match", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.uniqueArray(fc.integer({ min: 1, max: 10 }), { minLength: 1, maxLength: 3 }), { minLength: 50, maxLength: 150 }), async (wants) => {
        await seed(pool, EVENT, 10);
        const res = await Promise.all(wants.map((s, i) => svc.hold(EVENT, s, `w${i}`, strategy)));
        const won = wants.flatMap((s, i) => (res[i].ok ? [{ u: `w${i}`, s }] : []));
        const claimed = won.flatMap((w) => w.s);
        expect(new Set(claimed).size).toBe(claimed.length);
        const a = await svc.availability(EVENT);
        expect(a.held).toBe(claimed.length);
        expect(a.free).toBe(10 - claimed.length);
        // maximality: a losing request must conflict with at least one won seat (no spurious rejection)
        const taken = new Set(claimed);
        wants.forEach((s, i) => { if (!res[i].ok) expect(s.some((x) => taken.has(x))).toBe(true); });
      }),
      { numRuns: 8, seed: SEED }
    );
  }, 60_000);
});

describe("regression: confirm is all-or-nothing", () => {
  // Found by the model test: hold u1 [3]; confirm u1 [3,1] answered false but had already sold seat 3.
  it("a partially matching confirm sells nothing and reports false", async () => {
    const E = 9040;
    await seed(pool, E, SEATS);
    expect((await svc.hold(E, [3], "u1")).ok).toBe(true);
    expect(await svc.confirm(E, [3, 1], "u1")).toBe(false);
    expect(await svc.availability(E)).toEqual({ free: SEATS - 1, held: 1, sold: 0 });
    expect(await svc.confirm(E, [3, 3], "u1")).toBe(true); // duplicate ids are one seat
    expect(await svc.availability(E)).toEqual({ free: SEATS - 1, held: 0, sold: 1 });
  });
});

describe("lock ordering contract (for-update)", () => {
  // With a handful of rows the planner happens to lock in key order anyway, so deadlocks cannot be provoked reliably on a
  // laptop-sized table. The documented guarantee is "ordered locking": assert it on the statements actually sent.
  it("locks rows with ORDER BY seat_id and passes the ids sorted and de-duplicated, whatever order the caller used", async () => {
    const seen: { text: string; values?: unknown[] }[] = [];
    const spyPool = {
      connect: async () => {
        const c = await pool.connect();
        const orig = c.query.bind(c) as (...a: unknown[]) => unknown;
        (c as unknown as { query: unknown }).query = (...a: unknown[]) => {
          if (typeof a[0] === "string") seen.push({ text: a[0], values: a[1] as unknown[] | undefined });
          return orig(...a);
        };
        return c;
      }
    };
    const spied = new InventoryService(spyPool as never);
    await seed(pool, 9060, 10);
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 1, maxLength: 6 }), async (ids) => {
        seen.length = 0;
        await spied.hold(9060, ids, "lock-order", "for-update");
        const lock = seen.find((q) => /FOR UPDATE/.test(q.text))!;
        expect(lock.text).toMatch(/ORDER BY seat_id\s+FOR UPDATE/);
        const sent = lock.values![1] as number[];
        expect(sent).toEqual([...new Set(ids)].sort((a, b) => a - b));
        await seed(pool, 9060, 10);
      }),
      { numRuns: 25 }
    );
  });
});
