import Redis from "ioredis";

/**
 * Token bucket in Redis, one Lua script = one atomic round trip.
 * State per key: tokens + last refill time. Refill is computed lazily from elapsed time,
 * so there is no background job and idle keys expire by themselves.
 * Redis TIME is used instead of the app clock so all gateway instances agree.
 */
const SCRIPT = `
local key, rate, burst, cost = KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1]) or burst
local ts = tonumber(data[2]) or now
tokens = math.min(burst, tokens + (now - ts) * rate / 1000)
local allowed = 0
if tokens >= cost then tokens = tokens - cost; allowed = 1 end
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil(burst / rate * 1000) + 1000)
return {allowed, math.floor(tokens)}
`;

export class RateLimiter {
  constructor(private readonly redis: Redis, private readonly ratePerSecond: number, private readonly burst: number) {
    this.redis.defineCommand("bucket", { numberOfKeys: 1, lua: SCRIPT });
  }

  async take(key: string, cost = 1): Promise<{ allowed: boolean; remaining: number }> {
    const [allowed, remaining] = (await (this.redis as any).bucket(`rl:${key}`, this.ratePerSecond, this.burst, cost)) as [number, number];
    return { allowed: allowed === 1, remaining };
  }
}
