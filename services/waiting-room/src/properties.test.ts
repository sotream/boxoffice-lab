import fc from "fast-check";
import Redis from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { ADMIT_TTL_SECONDS, QueueService } from "./queue.service";

/**
 * Property tests of the queue against the real Redis. Event ids 9100-9199 are ours; reset() only deletes `wr:<id>:*`,
 * never the whole database. Re-run a failure with: FC_SEED=<seed> pnpm --filter @boxoffice/waiting-room test
 */
const SEED = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;
const redis = new Redis("redis://localhost:56379");
const q = new QueueService(redis);
const RATE = 7;
let nextEvent = 9100;
const fresh = async () => { const e = nextEvent++; await q.reset(e); return e; };
afterAll(async () => {
  for (let e = 9100; e < nextEvent; e++) await q.reset(e);
  await redis.quit();
});

const USERS = ["a", "b", "c", "d", "e", "f"];
type Cmd =
  | { k: "join"; u: string }
  | { k: "status"; u: string }
  | { k: "admit"; n: number }
  | { k: "ttl"; u: string }; // the admitted key expires (simulated by deleting it)
const userArb = fc.constantFrom(...USERS);
const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  { weight: 6, arbitrary: userArb.map((u) => ({ k: "join" as const, u })) },
  { weight: 4, arbitrary: fc.oneof(userArb, fc.string({ maxLength: 8 }).map((s) => `x${s}`)).map((u) => ({ k: "status" as const, u })) },
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 4 }).map((n) => ({ k: "admit" as const, n })) },
  { weight: 1, arbitrary: userArb.map((u) => ({ k: "ttl" as const, u })) }
);

describe("queue model (sequential interleavings)", () => {
  it("every operation agrees with a list+set reference model; FIFO, idempotent join, budget and no double admission hold", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(cmdArb, { minLength: 1, maxLength: 40 }), async (cmds) => {
        const E = await fresh();
        const queue: string[] = [];
        const admitted = new Set<string>();
        const lastPos = new Map<string, number>();

        for (const c of cmds) {
          if (c.k === "join") {
            const r = await q.join(E, c.u);
            if (admitted.has(c.u)) expect(r.position).toBe(0);
            else {
              if (!queue.includes(c.u)) { queue.push(c.u); }
              expect(r.position).toBe(queue.indexOf(c.u) + 1);
            }
          } else if (c.k === "status") {
            const s = await q.status(E, c.u, RATE);
            if (admitted.has(c.u)) {
              expect(s.state).toBe("admitted");
              if (s.state === "admitted") { expect(s.ttl).toBeGreaterThan(0); expect(s.ttl).toBeLessThanOrEqual(ADMIT_TTL_SECONDS); }
            } else if (queue.includes(c.u)) {
              const pos = queue.indexOf(c.u) + 1;
              expect(s).toEqual({ state: "waiting", position: pos, etaSeconds: Math.ceil(pos / RATE) });
            } else expect(s).toEqual({ state: "unknown" });
          } else if (c.k === "admit") {
            const got = await q.admit(E, c.n);
            const expected = queue.splice(0, c.n);
            expect(got, "FIFO: exactly the head of the queue, in order").toEqual(expected);
            expect(got.length).toBeLessThanOrEqual(c.n); // never more than the budget
            for (const id of got) {
              expect(admitted.has(id), `${id} admitted twice`).toBe(false);
              admitted.add(id);
            }
          } else {
            await redis.del(`wr:${E}:admitted:${c.u}`);
            admitted.delete(c.u);
          }
          // invariants after every step
          expect(await q.length(E)).toBe(queue.length);
          expect(new Set(queue).size).toBe(queue.length); // join idempotent: no duplicates in the queue
          for (const u of queue) expect(admitted.has(u), `${u} both waiting and admitted`).toBe(false);
          // positions are monotone: a waiting user's position never gets worse, and positions are exactly 1..k
          for (const [i, u] of queue.entries()) {
            const prev = lastPos.get(u);
            if (prev !== undefined) expect(i + 1).toBeLessThanOrEqual(prev);
            lastPos.set(u, i + 1);
          }
          for (const u of USERS) if (!queue.includes(u)) lastPos.delete(u);
          for (const u of USERS) expect(await q.isAdmitted(E, u)).toBe(admitted.has(u));
        }
      }),
      { numRuns: 60, seed: SEED }
    );
  }, 60_000);

  it("status of an unknown user is well defined for any id, and never leaks into other events", async () => {
    const E = await fresh();
    const other = await fresh();
    await q.join(other, "someone");
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.string({ maxLength: 40 }), fc.constantFrom("", "*", "queue", "seq", "admitted:x", "a:b:c", "\u0000", "💥")), async (id) => {
        expect(await q.status(E, id, RATE)).toEqual({ state: "unknown" });
        expect(await q.isAdmitted(E, id)).toBe(false);
      }),
      { numRuns: 200, seed: SEED }
    );
    expect(await q.status(other, "someone", RATE)).toMatchObject({ state: "waiting", position: 1 });
    expect(await q.length(E)).toBe(0);
  });

  it("admit on an empty queue or with n = 0 admits nobody", async () => {
    const E = await fresh();
    expect(await q.admit(E, 5)).toEqual([]);
    await q.join(E, "a");
    expect(await q.admit(E, 0)).toEqual([]);
    expect(await q.length(E)).toBe(1);
  });
});

describe("queue under concurrency", () => {
  it("joins that finished before others started are admitted first (happens-before FIFO), across random phases", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 5 }), fc.integer({ min: 1, max: 6 }), async (phaseSizes, budget) => {
        const E = await fresh();
        const phases: string[][] = [];
        let id = 0;
        for (const size of phaseSizes) {
          const users = Array.from({ length: size }, () => `u${id++}`);
          phases.push(users);
          await Promise.all(users.map((u) => q.join(E, u))); // concurrent within a phase, ordered across phases
        }
        const all = phases.flat();
        const order: string[] = [];
        while (order.length < all.length) {
          const got = await q.admit(E, budget);
          expect(got.length).toBeLessThanOrEqual(budget);
          order.push(...got);
        }
        expect(new Set(order).size).toBe(all.length); // nobody twice, nobody lost
        const phaseOf = new Map(phases.flatMap((p, i) => p.map((u) => [u, i] as const)));
        const phaseSeq = order.map((u) => phaseOf.get(u)!);
        expect(phaseSeq).toEqual([...phaseSeq].sort((a, b) => a - b));
      }),
      { numRuns: 30, seed: SEED }
    );
  }, 60_000);

  it("simultaneous joins, re-joins, admits and status calls: no duplicates, budget respected, nobody lost", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof(
          fc.record({ k: fc.constant("join" as const), u: fc.integer({ min: 0, max: 15 }) }),
          fc.record({ k: fc.constant("admit" as const), n: fc.integer({ min: 1, max: 5 }) }),
          fc.record({ k: fc.constant("status" as const), u: fc.integer({ min: 0, max: 15 }) })
        ), { minLength: 5, maxLength: 60 }),
        async (ops) => {
          const E = await fresh();
          const joinedUsers = new Set<string>();
          const admits: string[][] = [];
          const budgets: number[] = [];
          const positions = new Map<string, number[]>();
          await Promise.all(ops.map(async (o) => {
            if (o.k === "join") {
              joinedUsers.add(`u${o.u}`);
              const r = await q.join(E, `u${o.u}`);
              expect(r.position).toBeGreaterThanOrEqual(0);
              const l = positions.get(`u${o.u}`) ?? []; l.push(r.position); positions.set(`u${o.u}`, l);
            } else if (o.k === "admit") {
              budgets.push(o.n);
              admits.push(await q.admit(E, o.n));
            } else {
              const s = await q.status(E, `u${o.u}`, RATE);
              expect(["waiting", "admitted", "unknown"]).toContain(s.state);
            }
          }));
          admits.forEach((a, i) => expect(a.length).toBeLessThanOrEqual(budgets[i]));
          const flat = admits.flat();
          expect(new Set(flat).size, "a user was admitted twice").toBe(flat.length);
          const remaining = await redis.zrange(`wr:${E}:queue`, 0, -1);
          expect(new Set(remaining).size).toBe(remaining.length);
          for (const u of flat) expect(remaining).not.toContain(u);
          // conservation: every joined user is either still waiting or admitted (never lost, never both)
          expect([...new Set([...flat, ...remaining])].sort()).toEqual([...joinedUsers].sort());
          for (const u of flat) expect(await q.isAdmitted(E, u)).toBe(true);
        }
      ),
      { numRuns: 40, seed: SEED }
    );
  }, 60_000);

  it("20 simultaneous joins by the same user leave exactly one queue entry", async () => {
    const E = await fresh();
    const rs = await Promise.all(Array.from({ length: 20 }, () => q.join(E, "same")));
    expect(await q.length(E)).toBe(1);
    expect(rs.every((r) => r.position === 1)).toBe(true);
  });

  it("an admitted user who re-joins is not queued again", async () => {
    const E = await fresh();
    await q.join(E, "a");
    await q.admit(E, 1);
    expect((await q.join(E, "a")).position).toBe(0);
    expect(await q.length(E)).toBe(0);
  });
});
