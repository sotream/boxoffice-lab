import Redis from "ioredis";

export interface CacheStats { hits: number; misses: number; coalesced: number; errors: number }

/**
 * Cache-aside with two protections against the thundering herd:
 *  - single-flight: concurrent misses for one key in this process share ONE loader call;
 *  - TTL jitter (+-20%): keys created together do not all expire together.
 * Across processes a miss is still possible once per instance per key, which is acceptable
 * (instances x 1 query, not requests x 1 query).
 */
export class Cache {
  readonly stats: CacheStats = { hits: 0, misses: 0, coalesced: 0, errors: 0 };
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly redis: Redis, private readonly ttlSeconds = 30) {}

  ttlWithJitter(): number {
    return Math.max(1, Math.round(this.ttlSeconds * (0.8 + Math.random() * 0.4)));
  }

  async getOrLoad<T>(key: string, loader: () => Promise<T>): Promise<T> {
    let cached: string | null = null;
    try { cached = await this.redis.get(key); } catch { this.stats.errors++; } // cache down: act as a miss, never fail the read
    if (cached !== null) { this.stats.hits++; return JSON.parse(cached) as T; }

    const running = this.inflight.get(key);
    if (running) { this.stats.coalesced++; return running as Promise<T>; }

    this.stats.misses++;
    const p = (async () => {
      const value = await loader();
      try { await this.redis.set(key, JSON.stringify(value), "EX", this.ttlWithJitter()); } catch { this.stats.errors++; }
      return value;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async invalidate(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
