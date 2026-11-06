import "reflect-metadata";
import fc from "fast-check";
import Redis from "ioredis";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cache } from "./cache";
import { CatalogController } from "./catalog.controller";
import { CatalogService, SearchStrategy } from "./catalog.service";
import { createPool, migrate, seed } from "./db";

/**
 * Cache-aside invariants and search-input fuzz. Redis keys use the prefix `t:prop:`; the cache under test is created with
 * a key prefix chosen by the test or, for HTTP tests, a Cache whose keys are cleaned by pattern at the end.
 * Re-run a failure with: FC_SEED=<seed> pnpm --filter @boxoffice/catalog test
 */
const SEED = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;
const pool = createPool(20);
const redis = new Redis("redis://localhost:56379");
const svc = new CatalogService(pool);
const RUN = `${process.pid}-${Date.now()}`;
const P = `t:prop:${RUN}:`;
let app: NestFastifyApplication;
const httpCache = new Cache(redis, 30);
const seenKeys: string[] = [];
// Spy on the keys the controller really uses, delegating to the real Cache.
const spyCache = Object.assign(Object.create(httpCache), {
  getOrLoad: <T,>(key: string, loader: () => Promise<T>) => { seenKeys.push(key); return httpCache.getOrLoad(`${P}${key}`, loader); }
}) as Cache;

// Decorator syntax is not transformed by the test toolchain, so apply the decorator function by hand.
class TestModule {}
Module({
  controllers: [CatalogController],
  providers: [{ provide: CatalogService, useValue: svc }, { provide: Cache, useValue: spyCache }]
})(TestModule);

beforeAll(async () => {
  await migrate(pool);
  await seed(pool, 800);
  app = await NestFactory.create<NestFastifyApplication>(TestModule, new FastifyAdapter(), { logger: false });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app.close();
  const keys = await redis.keys(`${P}*`);
  if (keys.length) await redis.del(...keys);
  await pool.end();
  await redis.quit();
});

const json = <T,>(x: T): unknown => JSON.parse(JSON.stringify(x));

describe("cache TTL and staleness bound", () => {
  it("jitter stays within +-20% (integer, at least 1 s) for any base TTL", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), (ttl) => {
        const c = new Cache(redis, ttl);
        for (let i = 0; i < 20; i++) {
          const j = c.ttlWithJitter();
          expect(Number.isInteger(j)).toBe(true);
          expect(j).toBeGreaterThanOrEqual(Math.max(1, Math.round(ttl * 0.8)));
          expect(j).toBeLessThanOrEqual(Math.max(1, Math.round(ttl * 1.2)));
        }
      }),
      { numRuns: 300, seed: SEED }
    );
  });

  it("the TTL really written to Redis is within +-20% of the configured TTL (staleness <= 1.2 x TTL)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 5, max: 600 }), async (ttl) => {
        const c = new Cache(redis, ttl);
        const key = `${P}ttl:${ttl}:${Math.random()}`;
        await c.getOrLoad(key, async () => ({ v: 1 }));
        const actual = await redis.ttl(key);
        expect(actual).toBeGreaterThanOrEqual(Math.round(ttl * 0.8) - 1);
        expect(actual).toBeLessThanOrEqual(Math.round(ttl * 1.2));
        await redis.del(key);
      }),
      { numRuns: 60, seed: SEED }
    );
  });

  it("a value changed in the database is served stale for at most the TTL, then fresh", async () => {
    const c = new Cache(redis, 1); // 1 s base: jitter rounds to exactly 1 s
    const key = `${P}stale`;
    const [before] = await pool.query("SELECT title FROM catalog.events WHERE id=2").then((r) => r.rows);
    await c.getOrLoad(key, () => svc.get(2));
    await svc.rename(2, "stale-check");
    try {
      expect((await c.getOrLoad(key, () => svc.get(2)))?.title).toBe(before.title); // within TTL: old value
      await new Promise((r) => setTimeout(r, 1200));
      expect((await c.getOrLoad(key, () => svc.get(2)))?.title).toBe("stale-check"); // after TTL: refilled from the DB
    } finally {
      await svc.rename(2, before.title);
    }
  });
});

describe("a cached response equals the database response at fill time", () => {
  const word = fc.constantFrom("rock", "jazz", "opera", "ballet", "night", "show", "Arena", "zzzz-no-match", "1", "7");
  const city = fc.option(fc.constantFrom("Berlin", "Paris", "Lviv", "Nowhere"), { nil: undefined });
  const strat = fc.constantFrom<SearchStrategy>("fts", "fts-date", "ilike");

  it("miss returns the loader value, the hit returns the same JSON, and both equal a direct database query", async () => {
    await fc.assert(
      fc.asyncProperty(word, city, strat, fc.integer({ min: 1, max: 30 }), async (q, c, s, limit) => {
        const cache = new Cache(redis, 30);
        const key = `${P}fill:${s}:${c ?? ""}:${q}:${limit}`;
        await redis.del(key);
        const direct = json(await svc.search(q, c, limit, s));
        const miss = await cache.getOrLoad(key, () => svc.search(q, c, limit, s));
        const hit = await cache.getOrLoad(key, async () => { throw new Error("loader must not run on a hit"); });
        expect(json(miss)).toEqual(direct);
        expect(hit).toEqual(direct);
        expect(JSON.parse((await redis.get(key))!)).toEqual(direct);
      }),
      { numRuns: 40, seed: SEED }
    );
  });

  it("a loader error is not cached and the next call retries the loader", async () => {
    const cache = new Cache(redis, 30);
    const key = `${P}err`;
    await redis.del(key);
    await expect(cache.getOrLoad(key, async () => { throw new Error("db down"); })).rejects.toThrow("db down");
    expect(await redis.exists(key)).toBe(0);
    expect(await cache.getOrLoad(key, async () => "ok")).toBe("ok");
  });

  it("a null result (unknown id) is cached as null, so a miss storm on a missing event hits the DB once", async () => {
    const cache = new Cache(redis, 30);
    const key = `${P}null`;
    await redis.del(key);
    let loads = 0;
    const loader = async () => { loads++; return null; };
    await Promise.all(Array.from({ length: 50 }, () => cache.getOrLoad(key, loader)));
    expect(await cache.getOrLoad(key, loader)).toBeNull();
    expect(loads).toBe(1);
  });
});

describe("thundering herd protection", () => {
  it("for any number of concurrent callers on any number of keys, the loader runs once per key", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 1, maxLength: 80 }), async (picks) => {
        const cache = new Cache(redis, 30);
        const loads = new Map<number, number>();
        const run = `${Math.random()}`;
        const results = await Promise.all(picks.map((k) => cache.getOrLoad(`${P}herd:${run}:${k}`, async () => {
          loads.set(k, (loads.get(k) ?? 0) + 1);
          await new Promise((r) => setTimeout(r, 5));
          return { k };
        })));
        results.forEach((r, i) => expect(r).toEqual({ k: picks[i] }));
        for (const [k, n] of loads) expect(n, `key ${k} loaded ${n} times`).toBe(1);
        expect(cache.stats.misses).toBe(new Set(picks).size);
        expect(cache.stats.hits + cache.stats.coalesced + cache.stats.misses).toBe(picks.length);
        for (const k of new Set(picks)) await redis.del(`${P}herd:${run}:${k}`);
      }),
      { numRuns: 25, seed: SEED }
    );
  });

  it("a failing loader fails all coalesced waiters and clears the in-flight entry (no stuck key)", async () => {
    const cache = new Cache(redis, 30);
    const key = `${P}herd-fail`;
    await redis.del(key);
    const rs = await Promise.allSettled(Array.from({ length: 10 }, () => cache.getOrLoad(key, async () => { await new Promise((r) => setTimeout(r, 5)); throw new Error("boom"); })));
    expect(rs.every((r) => r.status === "rejected")).toBe(true);
    expect(await cache.getOrLoad(key, async () => "recovered")).toBe("recovered");
  });
});

describe("cache keys of the search endpoint", () => {
  const tuple = fc.record({
    strategy: fc.constantFrom("fts", "ilike", "fts-date"),
    city: fc.option(fc.oneof(fc.string({ maxLength: 8 }), fc.constantFrom("Berlin", "a:b", "a", ":", "b:c", "")), { nil: undefined }),
    q: fc.oneof(fc.string({ minLength: 1, maxLength: 12 }), fc.constantFrom("c", "b:c", "y:z", "z", ":", "b"))
  });
  // what the key must be a function of: the effective query parameters
  const canon = (t: { strategy: string; city?: string; q: string }) => JSON.stringify([t.strategy, t.city || null, t.q.toLowerCase()]);
  const keyOf = async (t: { strategy: string; city?: string; q: string }) => {
    seenKeys.length = 0;
    const qs = new URLSearchParams({ q: t.q, strategy: t.strategy });
    if (t.city !== undefined) qs.set("city", t.city);
    await app.inject({ method: "GET", url: `/search?${qs.toString()}` });
    return seenKeys[0];
  };

  it("different parameter tuples never share a cache key (and equal tuples always do)", async () => {
    await fc.assert(
      fc.asyncProperty(tuple, tuple, async (a, b) => {
        fc.pre(!a.q.includes("\u0000") && !b.q.includes("\u0000"));
        const [ka, kb] = [await keyOf(a), await keyOf(b)];
        expect(ka, "controller did not use the cache").toBeTypeOf("string");
        if (canon(a) === canon(b)) expect(ka).toBe(kb);
        else expect(ka, `key collision: ${canon(a)} vs ${canon(b)} -> ${ka}`).not.toBe(kb);
      }),
      { numRuns: 300, seed: SEED }
    );
  });

  it("regression: city 'a:b' + q 'c' must not share a key with city 'a' + q 'b:c'", async () => {
    const k1 = await keyOf({ strategy: "fts", city: "a:b", q: "c" });
    const k2 = await keyOf({ strategy: "fts", city: "a", q: "b:c" });
    expect(k1).not.toBe(k2);
  });

  it("the event key is derived from the integer id only", async () => {
    seenKeys.length = 0;
    await app.inject({ method: "GET", url: "/events/3" });
    await app.inject({ method: "GET", url: "/events/03" });
    expect(seenKeys).toEqual(["event:3", "event:3"]);
  });
});

describe("search input fuzz: no 5xx, no injection", () => {
  const nasty = [
    "'; DROP TABLE catalog.events; --", "' OR '1'='1", "\" OR \"\"=\"", "1; SELECT pg_sleep(5)", "$1", "$$", "\\", "\\'", "%", "_", "%%%", "\\%",
    "&", "|", "!", ":*", "(", ")", "<->", "a & b | !c", "'''", "--", "/*", "*/", "😀", "‮", "ǅ", "İ", "ß", "日本語", "\n", "\t", " ",
    "'; UPDATE catalog.events SET title='pwned'; --", "a".repeat(100), "é".repeat(100), "😀".repeat(50)
  ];
  const get = (qs: string) => app.inject({ method: "GET", url: `/search?${qs}` });
  const count = async () => Number((await pool.query("SELECT count(*) FROM catalog.events")).rows[0].count);
  const pwned = async () => Number((await pool.query("SELECT count(*) FROM catalog.events WHERE title='pwned'")).rows[0].count);

  it("curated hostile strings on every strategy answer 200 or 400, and leave the table intact", async () => {
    const before = await count();
    for (const q of nasty) for (const strategy of ["fts", "ilike", "fts-date"]) for (const cache of ["1", "0"]) {
      const res = await get(new URLSearchParams({ q, strategy, cache }).toString());
      expect([200, 400], `q=${JSON.stringify(q)} strategy=${strategy} -> ${res.statusCode} ${res.body.slice(0, 120)}`).toContain(res.statusCode);
      if (res.statusCode === 200) expect(Array.isArray(res.json())).toBe(true);
    }
    expect(await count()).toBe(before);
    expect(await pwned()).toBe(0);
  });

  it("random strings (any unicode), random cities, random strategies: never a 5xx", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: "binary", maxLength: 130 }), fc.option(fc.string({ unit: "binary", maxLength: 30 }), { nil: undefined }), fc.string({ maxLength: 10 }), async (q, city, strategy) => {
        const qs = new URLSearchParams({ q, strategy });
        if (city !== undefined) qs.set("city", city);
        const res = await get(qs.toString());
        expect(res.statusCode, `q=${JSON.stringify(q)} city=${JSON.stringify(city)} -> ${res.body.slice(0, 160)}`).toBeLessThan(500);
        if (res.statusCode === 200) expect(Array.isArray(res.json())).toBe(true);
      }),
      { numRuns: 300, seed: SEED }
    );
  }, 60_000);

  it("empty, missing, over-long q are 400; the limit is exactly 100 characters", async () => {
    expect((await get("q=")).statusCode).toBe(400);
    expect((await get("")).statusCode).toBe(400);
    expect((await get(`q=${"a".repeat(101)}`)).statusCode).toBe(400);
    expect((await get(`q=${"a".repeat(100)}`)).statusCode).toBe(200);
  });

  it("raw percent-encoded bytes (NUL, invalid UTF-8, lone surrogates) never produce a 5xx", async () => {
    for (const raw of ["%00", "a%00b", "%ff%fe", "%ed%a0%80", "%c0%af", "%", "%zz", "q%00", "%u0041"]) {
      const res = await app.inject({ method: "GET", url: `/search?q=${raw}` });
      expect(res.statusCode, `raw q=${raw} -> ${res.body.slice(0, 160)}`).toBeLessThan(500);
    }
    const res = await app.inject({ method: "GET", url: "/search?q=a&city=%00" });
    expect(res.statusCode).toBeLessThan(500);
  });

  it("SQL text in the search term is data: it matches nothing and changes nothing", async () => {
    const before = await count();
    const res = await get(new URLSearchParams({ q: "x'; DELETE FROM catalog.events; --", cache: "0" }).toString());
    expect(res.statusCode).toBe(200);
    expect(await count()).toBe(before);
    expect(before).toBeGreaterThan(0);
  });

  it("the query text is bound as parameters, never concatenated (read from the source)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${__dirname}/catalog.service.ts`, "utf8");
    const sqlStrings = (src.match(/`[^`]*`/g) ?? []).filter((t) => /\b(SELECT|UPDATE|INSERT|DELETE)\b/.test(t));
    expect(sqlStrings.length).toBeGreaterThanOrEqual(3);
    for (const t of sqlStrings) expect(t, "SQL text with an interpolated value").not.toContain("${");
  });

  it("event ids: non-numeric and huge ids are 4xx or 404, never 5xx", async () => {
    for (const id of ["abc", "-1", "0", "1.5", "99999999999999999999", "1e3", "%00"]) {
      const res = await app.inject({ method: "GET", url: `/events/${id}` });
      expect(res.statusCode, `id=${id} -> ${res.body.slice(0, 100)}`).toBeLessThan(500);
    }
  });
});
