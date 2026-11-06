import fc from "fast-check";
import Redis from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limiter";

/**
 * Token bucket against the real Redis + Lua. Keys are `rl:prop:<run>:<n>:*` (unique per run, deleted afterwards).
 *
 * Controllable clock: the script computes `now - ts` with `ts` read from the hash, so before each take we move the stored
 * `ts` back by the virtual delay (HINCRBY-free: read ts, write ts - delay). The model then advances by exactly that delay.
 * The only error is the real wall time between our calls (about a millisecond), which only ever ADDS refill. The
 * generators keep every quantity an integer number of tokens and the tests assert that this drift stays below one token,
 * so the model is exact: allowed/denied and the reported `remaining` must match it on every step.
 *
 * Re-run a failure with: FC_SEED=<seed> pnpm --filter @boxoffice/gateway test
 */
const SEED = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;
const redis = new Redis("redis://localhost:56379");
const RUN = `${process.pid}-${Date.now()}`;
let counter = 0;
const created: string[] = [];
const freshKey = (suffix: string) => { const k = `prop:${RUN}:${counter++}:${suffix}`; created.push(`rl:${k}`); return k; };
afterAll(async () => {
  if (created.length) await redis.del(...created);
  await redis.quit();
});

describe("token bucket vs exact model (virtual clock)", () => {
  it("allowed/denied and remaining equal the model for random (delay, cost, key) sequences; keys are isolated", async () => {
    const step = fc.record({
      key: fc.integer({ min: 0, max: 2 }),
      delayTokens: fc.integer({ min: 0, max: 5 }), // virtual wait, in tokens' worth of time
      cost: fc.integer({ min: 1, max: 4 })
    });
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(1, 2), fc.integer({ min: 1, max: 6 }), fc.array(step, { minLength: 1, maxLength: 30 }), async (rate, burst, steps) => {
        const rl = new RateLimiter(redis, rate, burst);
        const keys = [freshKey("a"), freshKey("b"), freshKey("c")];
        const tokens = [burst, burst, burst]; // model state per key
        const seen = [false, false, false];
        for (const s of steps) {
          if (seen[s.key] && s.delayTokens > 0) {
            const k = `rl:${keys[s.key]}`;
            const ts = Number(await redis.hget(k, "ts"));
            await redis.hset(k, "ts", ts - (s.delayTokens / rate) * 1000);
            tokens[s.key] = Math.min(burst, tokens[s.key] + s.delayTokens);
          }
          const r = await rl.take(keys[s.key], s.cost);
          seen[s.key] = true;
          const expectAllowed = tokens[s.key] >= s.cost;
          if (expectAllowed) tokens[s.key] -= s.cost;
          expect(r.allowed, `key ${s.key} cost ${s.cost} model tokens ${tokens[s.key]}`).toBe(expectAllowed);
          expect(r.remaining).toBe(tokens[s.key]);
          const stored = Number(await redis.hget(`rl:${keys[s.key]}`, "tokens"));
          expect(stored - tokens[s.key], "state drifted from the model").toBeGreaterThanOrEqual(-1e-9);
          expect(stored - tokens[s.key], "real elapsed time exceeded the one-token tolerance").toBeLessThan(1);
          expect(stored).toBeLessThanOrEqual(burst);
        }
      }),
      { numRuns: 40, seed: SEED }
    );
  }, 60_000);

  it("with a negligible refill, the allowed count of any random cost sequence equals greedy consumption of the burst", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 30 }), fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 60 }), async (burst, costs) => {
        const rl = new RateLimiter(redis, 0.0001, burst);
        const key = freshKey("greedy");
        let left = burst;
        for (const c of costs) {
          const want = left >= c;
          if (want) left -= c;
          expect((await rl.take(key, c)).allowed).toBe(want);
        }
      }),
      { numRuns: 40, seed: SEED }
    );
  }, 60_000);

  it("a cost larger than the burst is never allowed and does not consume tokens", async () => {
    const rl = new RateLimiter(redis, 100, 3);
    const k = freshKey("big");
    for (let i = 0; i < 5; i++) expect((await rl.take(k, 4)).allowed).toBe(false);
    expect((await rl.take(k, 3)).allowed).toBe(true);
  });
});

describe("token bucket with real time: never more than burst + rate x window", () => {
  const TOL_MS = 3; // Redis TIME is floored to whole milliseconds at both ends of a window, plus one scheduling tick

  it("for every window of consecutive calls, spent tokens <= burst + rate x window + tolerance", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(50, 200, 1000), fc.integer({ min: 1, max: 6 }),
        fc.array(fc.record({ delayMs: fc.integer({ min: 0, max: 8 }), cost: fc.integer({ min: 1, max: 3 }) }), { minLength: 5, maxLength: 24 }),
        async (rate, burst, steps) => {
          const rl = new RateLimiter(redis, rate, burst);
          const key = freshKey("win");
          const calls: { start: number; end: number; spent: number }[] = [];
          for (const s of steps) {
            if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
            const start = performance.now();
            const r = await rl.take(key, s.cost);
            calls.push({ start, end: performance.now(), spent: r.allowed ? s.cost : 0 });
          }
          for (let i = 0; i < calls.length; i++) {
            let spent = 0;
            for (let j = i; j < calls.length; j++) {
              spent += calls[j].spent;
              const windowMs = calls[j].end - calls[i].start;
              const bound = burst + (rate * (windowMs + TOL_MS)) / 1000;
              expect(spent, `calls ${i}..${j} spent ${spent} in ${windowMs.toFixed(1)} ms (rate ${rate}/s burst ${burst})`).toBeLessThanOrEqual(bound);
            }
          }
          // the limiter is not merely strict: the first `burst` worth of cost-1 tokens is always available on a fresh key
          expect(calls[0].spent > 0 || steps[0].cost > burst).toBe(true);
        }
      ),
      { numRuns: 25, seed: SEED }
    );
  }, 60_000);

  it("concurrent takes from many callers never exceed the burst (atomicity), for random burst and caller counts", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 1, max: 150 }), async (burst, callers) => {
        const rl = new RateLimiter(redis, 0.0001, burst);
        const key = freshKey("conc");
        const rs = await Promise.all(Array.from({ length: callers }, () => rl.take(key)));
        expect(rs.filter((r) => r.allowed).length).toBe(Math.min(burst, callers));
      }),
      { numRuns: 25, seed: SEED }
    );
  }, 60_000);

  it("an idle key refills to the burst and never beyond it", async () => {
    const rl = new RateLimiter(redis, 10, 3);
    const k = freshKey("idle");
    for (let i = 0; i < 3; i++) await rl.take(k);
    expect((await rl.take(k)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 600)); // 6 tokens of refill, capped at 3
    const spent = [];
    for (let i = 0; i < 6; i++) spent.push((await rl.take(k)).allowed);
    expect(spent.filter(Boolean).length).toBe(3); // the cap holds even though 6 tokens of time passed (loop takes ~ms: 0.01 tokens)
    expect(spent.slice(0, 3)).toEqual([true, true, true]);
  });
});
