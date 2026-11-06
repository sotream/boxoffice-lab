import Redis from "ioredis";

export interface CacheStats { hits: number; misses: number; coalesced: number }

/**
 * Cache-aside with two protections against the thundering herd:
 *  - single-flight: concurrent misses for one key in this process share ONE loader call;
 *  - TTL jitter (+-20%): keys created together do not all expire together.
 * Across processes a miss is still possible once per instance per key, which is acceptable
 * (instances x 1 query, not requests x 1 query).
 */
export class Cache {
  readonly stats: CacheStats = { hits: 0, misses: 0, coalesced: 0 };
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly redis: Redis, private readonly ttlSeconds = 30) {}

  ttlWithJitter(): number {
    return Math.max(1, Math.round(this.ttlSeconds * (0.8 + Math.random() * 0.4)));
  }

  async getOrLoad<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = await this.redis.get(key);
    if (cached !== null) { this.stats.hits++; return JSON.parse(cached) as T; }

    const running = this.inflight.get(key);
    if (running) { this.stats.coalesced++; return running as Promise<T>; }

    this.stats.misses++;
    const p = (async () => {
      const value = await loader();
      await this.redis.set(key, JSON.stringify(value), "EX", this.ttlWithJitter());
      return value;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async invalidate(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
