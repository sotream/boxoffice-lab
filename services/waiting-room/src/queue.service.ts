import { Inject, Injectable } from "@nestjs/common";
import Redis from "ioredis";

export const REDIS = "REDIS";
export const ADMIT_TTL_SECONDS = 300;

export type Status = { state: "waiting"; position: number; etaSeconds: number } | { state: "admitted"; ttl: number } | { state: "unknown" };

/**
 * Virtual waiting room. Queue = Redis sorted set scored by arrival order (INCR sequence, not clock,
 * so equal timestamps and clock skew cannot reorder users). Admission = ZPOPMIN N per tick into
 * per-user keys with a TTL. N is derived from the protected service's capacity, see CAPACITY.md.
 */
@Injectable()
export class QueueService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private qKey(eventId: number) { return `wr:${eventId}:queue`; }
  private aKey(eventId: number, id: string) { return `wr:${eventId}:admitted:${id}`; }

  async join(eventId: number, userId: string): Promise<{ position: number }> {
    if (await this.redis.exists(this.aKey(eventId, userId))) return { position: 0 };
    const seq = await this.redis.incr(`wr:${eventId}:seq`);
    await this.redis.zadd(this.qKey(eventId), "NX", seq, userId); // idempotent: re-join keeps the old place
    const rank = await this.redis.zrank(this.qKey(eventId), userId);
    return { position: (rank ?? 0) + 1 };
  }

  async status(eventId: number, userId: string, admitPerSecond: number): Promise<Status> {
    const ttl = await this.redis.ttl(this.aKey(eventId, userId));
    if (ttl > 0) return { state: "admitted", ttl };
    const rank = await this.redis.zrank(this.qKey(eventId), userId);
    if (rank === null) return { state: "unknown" };
    return { state: "waiting", position: rank + 1, etaSeconds: Math.ceil((rank + 1) / admitPerSecond) };
  }

  /** Move the next `n` users from the queue to admitted. Returns who was admitted. */
  async admit(eventId: number, n: number): Promise<string[]> {
    const popped = await this.redis.zpopmin(this.qKey(eventId), n);
    const ids = popped.filter((_, i) => i % 2 === 0);
    if (ids.length) {
      const p = this.redis.pipeline();
      for (const id of ids) p.set(this.aKey(eventId, id), "1", "EX", ADMIT_TTL_SECONDS);
      await p.exec();
    }
    return ids;
  }

  async isAdmitted(eventId: number, userId: string): Promise<boolean> {
    return (await this.redis.exists(this.aKey(eventId, userId))) === 1;
  }

  async length(eventId: number): Promise<number> {
    return this.redis.zcard(this.qKey(eventId));
  }

  async reset(eventId: number): Promise<void> {
    const keys = await this.redis.keys(`wr:${eventId}:*`);
    if (keys.length) await this.redis.del(...keys);
  }
}
