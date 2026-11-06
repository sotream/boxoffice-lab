import Redis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Cache } from "./cache";
import { CatalogService } from "./catalog.service";
import { createPool, migrate, seed } from "./db";

const pool = createPool(20);
const redis = new Redis("redis://localhost:56379");
const svc = new CatalogService(pool);
beforeAll(async () => { await migrate(pool); await seed(pool, 5000); });
beforeEach(async () => { const k = await redis.keys("t:*"); if (k.length) await redis.del(...k); svc.dbQueries = 0; });
afterAll(async () => { await pool.end(); await redis.quit(); });

describe("search strategies", () => {
  it("fts finds events by word and respects the city filter", async () => {
    const r = await svc.search("jazz", "Berlin", 10, "fts");
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((e) => e.city === "Berlin")).toBe(true);
  });
  it("fts and ilike agree on whole-word matches in titles", async () => {
    const a = (await svc.search("opera", undefined, 1000, "fts")).map((e) => e.id);
    const b = (await svc.search("opera", undefined, 1000, "ilike")).map((e) => e.id);
    expect(new Set(a)).toEqual(new Set(b));
  });
  it("ranks title matches above description matches", async () => {
    const r = await svc.search("ballet", undefined, 50, "fts");
    expect(r[0].title.toLowerCase()).toContain("ballet");
  });
});

describe("cache-aside", () => {
  it("Redis failure degrades to the database instead of failing the read", async () => {
    const broken = { get: async () => { throw new Error("down"); }, set: async () => { throw new Error("down"); } } as unknown as Redis;
    const c = new Cache(broken, 30);
    expect(await c.getOrLoad("t:x", async () => 42)).toBe(42);
    expect(c.stats.errors).toBe(2);
  });

  it("second call is a hit and does not touch the database", async () => {
    const c = new Cache(redis, 30);
    await c.getOrLoad("t:a", () => svc.search("rock", undefined, 5));
    await c.getOrLoad("t:a", () => svc.search("rock", undefined, 5));
    expect(svc.dbQueries).toBe(1);
    expect(c.stats).toMatchObject({ hits: 1, misses: 1 });
  });
  it("single-flight: 100 concurrent misses run one query", async () => {
    const c = new Cache(redis, 30);
    await Promise.all(Array.from({ length: 100 }, () => c.getOrLoad("t:b", () => svc.search("metal", undefined, 5))));
    expect(svc.dbQueries).toBe(1);
    expect(c.stats.misses).toBe(1);
    expect(c.stats.coalesced + c.stats.hits).toBe(99);
  });
  it("TTL carries +-20% jitter so keys do not expire together", () => {
    const c = new Cache(redis, 100);
    const ttls = Array.from({ length: 200 }, () => c.ttlWithJitter());
    expect(Math.min(...ttls)).toBeGreaterThanOrEqual(80);
    expect(Math.max(...ttls)).toBeLessThanOrEqual(120);
    expect(new Set(ttls).size).toBeGreaterThan(10);
  });
  it("invalidation after a write shows the new value", async () => {
    const c = new Cache(redis, 30);
    await c.getOrLoad("t:e1", () => svc.get(1));
    await svc.rename(1, "Renamed show");
    expect((await c.getOrLoad("t:e1", () => svc.get(1)))?.title).not.toBe("Renamed show"); // stale until invalidated: the trade-off
    await c.invalidate("t:e1");
    expect((await c.getOrLoad("t:e1", () => svc.get(1)))?.title).toBe("Renamed show");
  });
});
