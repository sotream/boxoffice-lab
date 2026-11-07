import Redis from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { signAdmission } from "@boxoffice/admission";
import { verifyInternalRequest } from "@boxoffice/platform";
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
    { inventoryUrl: "http://inv", queueUrl: "http://q", paymentsUrl: "http://pay", secret, internalToken: "internal", inventoryInternalToken: "inventory-internal" },
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
    const g = new GatewayService({ inventoryUrl: "http://inv", queueUrl: "http://q", paymentsUrl: "http://pay", secret, internalToken: "internal", inventoryInternalToken: "inventory-internal" },
      new RateLimiter(redis, 1000, 1000), new RateLimiter(redis, 1000, 1000), async () => { throw new Error("timeout"); });
    expect((await g.handle("GET", "/events/1/availability", "", undefined, "ip")).status).toBe(504);
  });

  it("404 for unknown paths", async () => {
    expect((await make().handle("GET", "/admin", "", undefined, "ip")).status).toBe(404);
  });

  it("an admitted user cannot hold or confirm seats as somebody else", async () => {
    const g = make();
    // The check now runs after the per-user limiter (burst 2), so each case gets its own user bucket.
    let n = 0;
    const post = async (route: string, userId: string, body: string) => (await g.handle("POST", `/events/1/${route}`, "", body, "ip", signAdmission(userId, 1, 60, secret))).status;
    for (const route of ["holds", "confirm"]) {
      expect(await post(route, `a${n++}`, '{"userId":"victim","seatIds":[1]}')).toBe(403);
      expect(await post(route, `a${n++}`, '{"seatIds":[1]}')).toBe(403); // no userId at all
      expect(await post(route, `a${n++}`, '{"userId":["u"]}')).toBe(403);
      expect(await post(route, `a${n++}`, "not json")).toBe(400);
    }
  });

  it("malformed and mismatching bodies spend the user's tokens: 400/403 while tokens last, then 429; the upstream is never called", async () => {
    const g = make(); // user bucket: burst 2
    const t = signAdmission("u", 1, 60, secret);
    const codes = [];
    for (const b of ["not json", '{"userId":"victim"}', "not json", '{"userId":"u"}']) codes.push((await g.handle("POST", "/events/1/holds", "", b, "ip", t)).status);
    expect(codes).toEqual([400, 403, 429, 429]); // even a valid body is refused once the bucket is empty
    expect(calls).toHaveLength(0);
  });

  it("limiter store down and a malformed body: fail closed 503, the body is not even looked at", async () => {
    const broken = { take: async () => { throw new Error("redis down"); } } as unknown as RateLimiter;
    const g = new GatewayService({ inventoryUrl: "http://inv", queueUrl: "http://q", paymentsUrl: "http://pay", secret, internalToken: "internal", inventoryInternalToken: "inventory-internal" }, broken, broken, upstream);
    expect((await g.handle("POST", "/events/1/holds", "", "not json", "ip", signAdmission("u", 1, 60, secret))).status).toBe(503);
  });

  it("holds and confirms are POST-only: any other method with a valid token is a 405 and is never forwarded (it would skip the identity check)", async () => {
    const g = make();
    const t = signAdmission("u", 1, 60, secret);
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) for (const route of ["holds", "confirm"]) {
      const r = await g.handle(method, `/events/1/${route}`, "", '{"userId":"u"}', "ip", t);
      expect(r.status, `${method} ${route}`).toBe(405);
      expect(r.headers?.allow).toBe("POST");
    }
    expect(calls).toEqual([]);
    expect((await g.handle("GET", "/events/1/holds", "", undefined, "ip")).status).toBe(403); // without a token the answer is still 403, not 405
  });

  describe("POST /events/:id/pay", () => {
    const pay = (g: GatewayService, user: string, body: string, key: string | null = "idem-1", event = 1, token = signAdmission(user, event, 60, secret)) =>
      g.handle("POST", `/events/${event}/pay`, "", body, "ip", token, undefined, key ?? undefined);

    it("an admitted user cannot pay as somebody else: 403, nothing forwarded", async () => {
      const g = make();
      let n = 0;
      expect((await pay(g, `a${n++}`, '{"userId":"victim","seatIds":[1]}')).status).toBe(403);
      expect((await pay(g, `a${n++}`, '{"seatIds":[1]}')).status).toBe(403); // no userId at all
      expect((await pay(g, `a${n++}`, '{"userId":["a"]}')).status).toBe(403);
      expect((await pay(g, `a${n++}`, "not json")).status).toBe(400);
      expect(calls).toEqual([]);
    });

    it("the body eventId must be the path event: another event is a 400 and nothing is forwarded", async () => {
      const g = make();
      let n = 0;
      for (const eventId of [2, "1", 0, null]) {
        expect((await pay(g, `e${n++}`, JSON.stringify({ userId: `e${n - 1}`, eventId, seatIds: [1] }))).status, JSON.stringify(eventId)).toBe(400);
      }
      expect(calls).toEqual([]);
      expect((await pay(g, "ok", '{"userId":"ok","eventId":1,"seatIds":[1]}')).status).toBe(201); // equal is fine
      expect((await pay(g, "ok2", '{"userId":"ok2","seatIds":[1]}')).status).toBe(201); // absent is filled in from the path
      expect(calls).toEqual(["http://pay/payments", "http://pay/payments"]);
    });

    it("the Idempotency-Key header is required (400)", async () => {
      const g = make();
      expect((await pay(g, "k1", '{"userId":"k1","seatIds":[1]}', null)).status).toBe(400);
      expect((await pay(g, "k2", '{"userId":"k2","seatIds":[1]}', "  ")).status).toBe(400);
      expect(calls).toEqual([]);
    });

    it("a token for another event is a 403 even with a perfect body", async () => {
      const g = make();
      expect((await pay(g, "u", '{"userId":"u","seatIds":[1]}', "idem", 1, signAdmission("u", 2, 60, secret))).status).toBe(403);
      expect(calls).toEqual([]);
    });

    it("order of checks: token 403, then limiter 429, then body 400/403; the bucket is per user and spent by bad bodies", async () => {
      const g = make(); // user bucket: burst 2
      const t = signAdmission("u", 1, 60, secret);
      const codes = [];
      for (const b of ["not json", '{"userId":"victim"}', '{"userId":"u","seatIds":[1]}']) codes.push((await pay(g, "u", b, "idem", 1, t)).status);
      expect(codes).toEqual([400, 403, 429]);
      expect(calls).toEqual([]);
    });

    it("limiter store down: pay fails closed with a fast 503, the body is not looked at", async () => {
      const broken = { take: async () => { throw new Error("redis down"); } } as unknown as RateLimiter;
      const g = new GatewayService({ inventoryUrl: "http://inv", queueUrl: "http://q", paymentsUrl: "http://pay", secret, internalToken: "internal", inventoryInternalToken: "inventory-internal" }, broken, broken, upstream);
      const r = await pay(g, "u", "not json");
      expect(r.status).toBe(503);
      expect(r.headers?.["retry-after"]).toBe("1");
    });

    it("only POST: any other method with a valid token is 405, and without a token it is 403", async () => {
      const g = make();
      const t = signAdmission("u", 1, 60, secret);
      for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
        const r = await g.handle(method, "/events/1/pay", "", '{"userId":"u"}', "ip", t, undefined, "idem");
        expect(r.status, method).toBe(405);
        expect(r.headers?.allow).toBe("POST");
      }
      expect((await g.handle("GET", "/events/1/pay", "", undefined, "ip")).status).toBe(403);
      expect(calls).toEqual([]);
    });

    it("a signed request and the key reach payments; the secret itself is never sent; a client cannot supply its own signature", async () => {
      const seen: Record<string, string>[] = [];
      const g = new GatewayService({ inventoryUrl: "http://inv", queueUrl: "http://q", paymentsUrl: "http://pay", secret, internalToken: "internal", inventoryInternalToken: "inventory-internal" },
        new RateLimiter(redis, 1000, 1000), new RateLimiter(redis, 1000, 1000), async (_url, init) => { seen.push(init.headers); return { status: 200, body: "{}" }; });
      await pay(g, "u", '{"userId":"u","seatIds":[1]}', "key-9");
      expect(Object.values(seen[0])).not.toContain("internal");
      expect(seen[0]["x-internal-auth"]).toMatch(/^\d+\.[0-9a-f]{64}$/);
      expect(seen[0]["idempotency-key"]).toBe("key-9");
    });
  });

  it("limiter store down: public availability fails open, holds fail closed with a fast 503", async () => {
    const broken = { take: async () => { throw new Error("redis down"); } } as unknown as RateLimiter;
    const g = new GatewayService({ inventoryUrl: "http://inv", queueUrl: "http://q", paymentsUrl: "http://pay", secret, internalToken: "internal", inventoryInternalToken: "inventory-internal" }, broken, broken, upstream);
    expect((await g.handle("GET", "/events/1/availability", "", undefined, "ip")).status).toBe(201); // forwarded
    const t = signAdmission("u", 1, 60, secret);
    expect((await g.handle("POST", "/events/1/holds", "", '{"userId":"u"}', "ip", t)).status).toBe(503);
    expect((await g.handle("POST", "/events/1/queue/join", "", "{}", "ip")).status).toBe(503);
  });
});

describe("GatewayService signs what it forwards to inventory", () => {
  const secret = "s";
  const INV_KEY = "inventory-internal";
  type Seen = { url: string; method: string; body?: string; headers: Record<string, string> };
  const build = (seen: Seen[]) => new GatewayService(
    { inventoryUrl: "http://inv", queueUrl: "http://q", paymentsUrl: "http://pay", secret, internalToken: "payments-internal", inventoryInternalToken: INV_KEY },
    new RateLimiter(redis, 1000, 1000), new RateLimiter(redis, 1000, 1000),
    async (url, init) => { seen.push({ url, ...init }); return { status: 200, body: "{}" }; }
  );
  const valid = (r: Seen, key = INV_KEY) => verifyInternalRequest(r.headers["x-internal-auth"], [key], r.method, new URL(r.url).pathname, r.body ?? "");

  it("holds, confirm and availability carry a valid signature over the method, the path without the query and the exact body", async () => {
    const seen: Seen[] = [];
    const g = build(seen);
    const t = signAdmission("u", 1, 60, secret);
    const hold = '{"userId":"u","seatIds":[1, 2]}'; // spacing is kept: the signature is over the bytes that are sent
    await g.handle("POST", "/events/1/holds", "?strategy=for-update", hold, "ip", t);
    await g.handle("POST", "/events/1/confirm", "", hold, "ip", t);
    await g.handle("GET", "/events/1/availability", "?x=1", undefined, "ip");
    expect(seen.map((r) => [r.method, r.url, r.body])).toEqual([
      ["POST", "http://inv/events/1/holds?strategy=for-update", hold],
      ["POST", "http://inv/events/1/confirm", hold],
      ["GET", "http://inv/events/1/availability?x=1", undefined]
    ]);
    for (const r of seen) expect(valid(r), r.url).toBe(true);
  });

  it("the signature is made with inventory's key, not payments' key, and is bound to the request it was made for", async () => {
    const seen: Seen[] = [];
    await build(seen).handle("POST", "/events/1/confirm", "", '{"userId":"u"}', "ip", signAdmission("u", 1, 60, secret));
    expect(valid(seen[0], "payments-internal")).toBe(false);
    expect(verifyInternalRequest(seen[0].headers["x-internal-auth"], [INV_KEY], "POST", "/events/1/holds", '{"userId":"u"}')).toBe(false); // other path
    expect(verifyInternalRequest(seen[0].headers["x-internal-auth"], [INV_KEY], "POST", "/events/1/confirm", '{"userId":"v"}')).toBe(false); // other body
  });

  it("no key is ever sent, queue requests do not carry inventory's signature, and payments gets a signature made with its own key", async () => {
    const seen: Seen[] = [];
    const g = build(seen);
    const t = signAdmission("u", 1, 60, secret);
    await g.handle("POST", "/events/1/holds", "", '{"userId":"u"}', "ip", t);
    await g.handle("POST", "/events/1/queue/join", "", '{"userId":"u"}', "ip");
    await g.handle("POST", "/events/1/pay", "", '{"userId":"u","seatIds":[1]}', "ip", t, undefined, "k1");
    for (const r of seen) {
      expect(JSON.stringify(r.headers)).not.toContain(INV_KEY);
      expect(JSON.stringify(r.headers)).not.toContain("payments-internal");
    }
    expect(seen[1].headers["x-internal-auth"]).toBeUndefined();               // the waiting room is not authenticated by this scheme
    expect(valid(seen[2])).toBe(false);                                       // not made with inventory's key
    expect(verifyInternalRequest(seen[2].headers["x-internal-auth"], ["payments-internal"], "POST", "/payments", seen[2].body ?? "")).toBe(true);
  });
});
