import Redis from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { signAdmission } from "@boxoffice/admission";
import { GatewayService, Upstream } from "./gateway.service";
import { RateLimiter } from "./rate-limiter";

const redis = new Redis("redis://localhost:56379");
afterAll(() => redis.quit());
beforeEach(async () => { const k = await redis.keys("rl:*"); if (k.length) await redis.del(...k); });

describe("RateLimiter (token bucket)", () => {
  it("is atomic: 300 concurrent takes on a burst of 100 allow exactly 100", async () => {
    const rl = new RateLimiter(redis, 0.001, 100); // refill is negligible, so the count is exact
    const rs = await Promise.all(Array.from({ length: 300 }, () => rl.take("k")));
    expect(rs.filter((r) => r.allowed).length).toBe(100);
  });

  it("refills over time", async () => {
    const rl = new RateLimiter(redis, 20, 2);
    expect((await rl.take("t")).allowed).toBe(true);
    expect((await rl.take("t")).allowed).toBe(true);
    expect((await rl.take("t")).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 120)); // 20 tokens/s x 0.12 s = 2.4 tokens
    expect((await rl.take("t")).allowed).toBe(true);
  });

  it("keeps keys independent", async () => {
    const rl = new RateLimiter(redis, 1, 1);
    expect((await rl.take("a")).allowed).toBe(true);
    expect((await rl.take("b")).allowed).toBe(true);
    expect((await rl.take("a")).allowed).toBe(false);
  });
});

describe("GatewayService", () => {
  const calls: string[] = [];
  const upstream: Upstream = async (url) => { calls.push(url); return { status: 201, body: "{}" }; };
  const secret = "s";
  const make = () => new GatewayService(
    { inventoryUrl: "http://inv", queueUrl: "http://q", secret },
    new RateLimiter(redis, 1000, 1000),
    new RateLimiter(redis, 1, 2),
    upstream
  );
  beforeEach(() => { calls.length = 0; });

  it("rejects holds without admission, never calling upstream", async () => {
    const r = await make().handle("POST", "/events/1/holds", "", "{}", "1.1.1.1");
    expect(r.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("rejects a token for another event or a forged token", async () => {
    const g = make();
    const other = signAdmission("u", 2, 60, secret);
    expect((await g.handle("POST", "/events/1/holds", "", "{}", "ip", other)).status).toBe(403);
    expect((await g.handle("POST", "/events/1/holds", "", "{}", "ip", signAdmission("u", 1, 60, "wrong"))).status).toBe(403);
  });

  it("forwards admitted holds and limits per user (burst 2, then 429)", async () => {
    const g = make();
    const t = signAdmission("u", 1, 60, secret);
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await g.handle("POST", "/events/1/holds", "?strategy=atomic-update", '{"userId":"u"}', "ip", t)).status);
    expect(codes).toEqual([201, 201, 429, 429]);
    expect(calls[0]).toBe("http://inv/events/1/holds?strategy=atomic-update");
  });

  it("routes queue calls to the waiting room without admission", async () => {
    const r = await make().handle("POST", "/events/1/queue/join", "", "{}", "ip");
    expect(r.status).toBe(201);
    expect(calls[0]).toBe("http://q/events/1/queue/join");
  });

  it("a hanging or failing upstream becomes a 504, not a hung request", async () => {
    const g = new GatewayService({ inventoryUrl: "http://inv", queueUrl: "http://q", secret },
      new RateLimiter(redis, 1000, 1000), new RateLimiter(redis, 1000, 1000), async () => { throw new Error("timeout"); });
    expect((await g.handle("GET", "/events/1/availability", "", undefined, "ip")).status).toBe(504);
  });

  it("404 for unknown paths", async () => {
    expect((await make().handle("GET", "/admin", "", undefined, "ip")).status).toBe(404);
  });

  it("an admitted user cannot hold or confirm seats as somebody else", async () => {
    const g = make();
    const t = signAdmission("u", 1, 60, secret);
    for (const route of ["holds", "confirm"]) {
      expect((await g.handle("POST", `/events/1/${route}`, "", '{"userId":"victim","seatIds":[1]}', "ip", t)).status).toBe(403);
      expect((await g.handle("POST", `/events/1/${route}`, "", '{"seatIds":[1]}', "ip", t)).status).toBe(403); // no userId at all
      expect((await g.handle("POST", `/events/1/${route}`, "", '{"userId":["u"]}', "ip", t)).status).toBe(403);
      expect((await g.handle("POST", `/events/1/${route}`, "", "not json", "ip", t)).status).toBe(400);
    }
  });

  it("limiter store down: public availability fails open, holds fail closed with a fast 503", async () => {
    const broken = { take: async () => { throw new Error("redis down"); } } as unknown as RateLimiter;
    const g = new GatewayService({ inventoryUrl: "http://inv", queueUrl: "http://q", secret }, broken, broken, upstream);
    expect((await g.handle("GET", "/events/1/availability", "", undefined, "ip")).status).toBe(201); // forwarded
    const t = signAdmission("u", 1, 60, secret);
    expect((await g.handle("POST", "/events/1/holds", "", '{"userId":"u"}', "ip", t)).status).toBe(503);
    expect((await g.handle("POST", "/events/1/queue/join", "", "{}", "ip")).status).toBe(503);
  });
});
