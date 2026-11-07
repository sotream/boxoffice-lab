import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { signAdmission } from "@boxoffice/admission";
import { GatewayService, Upstream } from "./gateway.service";
import { RateLimiter } from "./rate-limiter";

/**
 * Policy table of GatewayService: route x token state x limiter state -> documented status.
 * Limiters are in-memory fakes so every cell of the table is exercised deterministically (the real Lua limiter is
 * covered in rate-limiter.properties.test.ts).
 */
const SECRET = "policy-secret";
const EVENT = 7;
type LimiterState = "ok" | "limited" | "down";
type Route = "queue/join" | "queue/status" | "holds" | "confirm" | "pay" | "availability";
type TokenState = "none" | "garbage" | "valid" | "expired" | "wrong-event" | "wrong-secret";

const ROUTES: Route[] = ["queue/join", "queue/status", "holds", "confirm", "pay", "availability"];
const INTERNAL = "policy-internal-token";
const TOKENS: TokenState[] = ["none", "garbage", "valid", "expired", "wrong-event", "wrong-secret"];
const LIMITERS: LimiterState[] = ["ok", "limited", "down"];

const token = (s: TokenState): string | undefined => {
  switch (s) {
    case "none": return undefined;
    case "garbage": return "not-a-token";
    case "valid": return signAdmission("alice", EVENT, 60, SECRET);
    case "expired": return signAdmission("alice", EVENT, 60, SECRET, Date.now() - 120_000);
    case "wrong-event": return signAdmission("alice", EVENT + 1, 60, SECRET);
    case "wrong-secret": return signAdmission("alice", EVENT, 60, "other");
  }
};

function fakeLimiter(state: LimiterState, log: string[], name: string): RateLimiter {
  return {
    take: async (key: string) => {
      log.push(`${name}:${key}`);
      if (state === "down") throw new Error("redis down");
      return { allowed: state === "ok", remaining: 0 };
    }
  } as unknown as RateLimiter;
}

function build(limiter: LimiterState, upstream?: Upstream) {
  const limits: string[] = [];
  const calls: { url: string; init: Parameters<Upstream>[1] }[] = [];
  const up: Upstream = upstream ?? (async (url, init) => { calls.push({ url, init }); return { status: 202, body: '{"up":true}' }; });
  const wrapped: Upstream = async (url, init) => { if (!upstream) return up(url, init); calls.push({ url, init }); return upstream(url, init); };
  const svc = new GatewayService(
    { inventoryUrl: "http://inv", queueUrl: "http://q", paymentsUrl: "http://pay", secret: SECRET, internalToken: INTERNAL },
    fakeLimiter(limiter, limits, "ip"),
    fakeLimiter(limiter, limits, "user"),
    wrapped
  );
  return { svc, limits, calls };
}

/** The documented decision for one cell of the table. */
function expected(route: Route, t: TokenState, l: LimiterState): { status: number; limiter?: string; upstream: boolean } {
  const base = route.startsWith("queue/") ? "http://q" : "http://inv";
  void base;
  if (route.startsWith("queue/") || route === "availability") {
    // public routes: token is irrelevant, limited per client IP
    if (l === "limited") return { status: 429, limiter: "ip:ip:9.9.9.9", upstream: false };
    if (l === "down") return route === "availability" ? { status: 202, limiter: "ip:ip:9.9.9.9", upstream: true } : { status: 503, limiter: "ip:ip:9.9.9.9", upstream: false };
    return { status: 202, limiter: "ip:ip:9.9.9.9", upstream: true };
  }
  // holds, confirm and pay: a valid admission token is checked BEFORE the limiter is touched
  if (t !== "valid") return { status: 403, upstream: false };
  if (l === "limited") return { status: 429, limiter: "user:user:alice", upstream: false };
  if (l === "down") return { status: 503, limiter: "user:user:alice", upstream: false };
  return { status: 202, limiter: "user:user:alice", upstream: true };
}

describe("every (route x token x limiter) combination gives the documented status", () => {
  for (const route of ROUTES) for (const t of TOKENS) for (const l of LIMITERS) {
    it(`${route} | token ${t} | limiter ${l}`, async () => {
      const { svc, limits, calls } = build(l);
      const method = route === "holds" || route === "confirm" || route === "pay" || route === "queue/join" ? "POST" : "GET";
      const r = await svc.handle(method, `/events/${EVENT}/${route}`, "?x=1", method === "POST" ? '{"userId":"alice"}' : undefined, "9.9.9.9", token(t), undefined, "idem-1");
      const want = expected(route, t, l);
      expect(r.status).toBe(want.status);
      expect(limits).toEqual(want.limiter ? [want.limiter] : []); // 403 never spends limiter capacity
      expect(calls.length).toBe(want.upstream ? 1 : 0);
      if (want.upstream) {
        const host = route.startsWith("queue/") ? "http://q" : "http://inv";
        // payments is a different path on the upstream (/payments) and the query string is not forwarded
        expect(calls[0].url).toBe(route === "pay" ? "http://pay/payments" : `${host}/events/${EVENT}/${route}?x=1`);
        expect(calls[0].init.headers["x-forwarded-for"]).toBe("9.9.9.9");
        expect(calls[0].init.method).toBe(method);
        expect(r.body).toBe('{"up":true}');
      }
      if (want.status === 429 || want.status === 503) expect(r.headers?.["retry-after"]).toBe("1");
      if (want.status === 403) expect(JSON.parse(r.body)).toEqual({ error: "admission required" });
    });
  }
});

describe("pay: what is sent to payments", () => {
  it("adds the internal credential, passes the idempotency key and fills in the event from the path", async () => {
    const { svc, calls } = build("ok");
    const r = await svc.handle("POST", `/events/${EVENT}/pay`, "?ignored=1", '{"userId":"alice","seatIds":[3,4]}', "9.9.9.9", token("valid"), undefined, "idem-77");
    expect(r.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://pay/payments");
    expect(calls[0].init.headers["x-internal-token"]).toBe(INTERNAL);
    expect(calls[0].init.headers["idempotency-key"]).toBe("idem-77");
    expect(JSON.parse(calls[0].init.body!)).toEqual({ userId: "alice", seatIds: [3, 4], eventId: EVENT });
  });
  it("holds and confirms never get the internal credential or an idempotency key", async () => {
    for (const route of ["holds", "confirm"]) {
      const { svc, calls } = build("ok");
      await svc.handle("POST", `/events/${EVENT}/${route}`, "", '{"userId":"alice"}', "ip", token("valid"), undefined, "idem-1");
      expect(calls[0].init.headers["x-internal-token"]).toBeUndefined();
      expect(calls[0].init.headers["idempotency-key"]).toBeUndefined();
    }
  });
});

describe("upstream failures", () => {
  for (const route of ROUTES) {
    it(`${route}: an unreachable or slow upstream becomes 504 with the limiter ok`, async () => {
      const { svc } = build("ok", async () => { throw new Error("ETIMEDOUT"); });
      const r = await svc.handle("POST", `/events/${EVENT}/${route}`, "", '{"userId":"alice"}', "ip", token("valid"), undefined, "idem-1");
      expect(r.status).toBe(504);
    });
    it(`${route}: upstream error statuses and bodies are passed through unchanged`, async () => {
      const { svc } = build("ok", async () => ({ status: 409, body: '{"reason":"unavailable"}' }));
      const r = await svc.handle("POST", `/events/${EVENT}/${route}`, "", '{"userId":"alice"}', "ip", token("valid"), undefined, "idem-1");
      expect(r).toMatchObject({ status: 409, body: '{"reason":"unavailable"}' });
    });
  }
  it("availability with the limiter down AND upstream down is 504 (fail open reaches the upstream)", async () => {
    const { svc } = build("down", async () => { throw new Error("down"); });
    expect((await svc.handle("GET", `/events/${EVENT}/availability`, "", undefined, "ip")).status).toBe(504);
  });
});

describe("routing and fuzz", () => {
  it("per-user keys: two users behind one IP are limited separately; per-IP keys for public routes", async () => {
    const { svc, limits } = build("ok");
    await svc.handle("POST", `/events/${EVENT}/holds`, "", '{"userId":"u1"}', "1.1.1.1", signAdmission("u1", EVENT, 60, SECRET));
    await svc.handle("POST", `/events/${EVENT}/holds`, "", '{"userId":"u2"}', "1.1.1.1", signAdmission("u2", EVENT, 60, SECRET));
    await svc.handle("GET", `/events/${EVENT}/availability`, "", undefined, "1.1.1.1");
    expect(limits).toEqual(["user:user:u1", "user:user:u2", "ip:ip:1.1.1.1"]);
  });

  it("only the documented paths are routed: everything else is 404 without touching limiter or upstream", async () => {
    const paths = ["/", "/admin", "/events/x/holds", "/events/1/holds/", "/events//holds", "/events/1/hold", "/EVENTS/1/holds", "/events/1/queue", "/events/1/queue/leave", "/events/1/holds?x", "/events/1/holds/extra", "//events/1/holds"];
    for (const p of paths) {
      const { svc, limits, calls } = build("ok");
      expect((await svc.handle("GET", p, "", undefined, "ip", token("valid"))).status, p).toBe(404);
      expect(limits).toEqual([]);
      expect(calls).toEqual([]);
    }
  });

  it("fuzz: arbitrary path and admission strings never throw, never reach the limiter or upstream without a valid route/token", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 60 }), fc.option(fc.string({ maxLength: 200 }), { nil: undefined }), async (path, adm) => {
        const { svc, limits, calls } = build("ok");
        const r = await svc.handle("POST", path, "", "{}", "ip", adm);
        expect([404, 403]).toContain(r.status); // arbitrary text is never a valid route+token pair
        expect(limits).toEqual([]);
        expect(calls).toEqual([]);
      }),
      { numRuns: 500 }
    );
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 300 }), fc.uint8Array({ maxLength: 100 }), async (garbage, bytes) => {
        const { svc, limits, calls } = build("ok");
        for (const adm of [garbage, Buffer.from(bytes).toString("latin1"), Buffer.from(bytes).toString("hex")]) {
          for (const route of ["holds", "confirm", "pay"]) {
            expect((await svc.handle("POST", `/events/${EVENT}/${route}`, "", "{}", "ip", adm)).status).toBe(403);
          }
        }
        expect(limits).toEqual([]);
        expect(calls).toEqual([]);
      }),
      { numRuns: 300 }
    );
  });

  it("any single-character tamper of a valid token is a 403, never a forwarded hold", async () => {
    const valid = signAdmission("alice", EVENT, 60, SECRET);
    await fc.assert(
      fc.asyncProperty(fc.nat({ max: valid.length - 1 }), fc.integer({ min: 1, max: 0xffff }), async (i, xor) => {
        const c = String.fromCharCode((valid.charCodeAt(i) ^ xor) & 0xffff);
        fc.pre(c !== valid[i]);
        const { svc, calls } = build("ok");
        const r = await svc.handle("POST", `/events/${EVENT}/holds`, "", "{}", "ip", valid.slice(0, i) + c + valid.slice(i + 1));
        expect(r.status).toBe(403);
        expect(calls).toEqual([]);
      }),
      { numRuns: 300 }
    );
  });
});
