import { verifyAdmission } from "@boxoffice/admission";
import { outgoingHeaders } from "@boxoffice/platform";
import { admissionRejected, limiterDecisions, upstreamDuration, upstreamErrors } from "./metrics";
import { RateLimiter } from "./rate-limiter";

/** Bounded route label for metrics: the gateway has one catch-all Fastify route, so the pattern is derived here, never the raw path. */
export function routeOf(path: string): string {
  const m = path.match(/^\/events\/\d+\/(queue\/(?:join|status)|holds|confirm|availability)$/);
  return m ? `/events/:eventId/${m[1]}` : "unmatched";
}

export type Upstream = (url: string, init: { method: string; body?: string; headers: Record<string, string> }) => Promise<{ status: number; body: string }>;
export interface Reply { status: number; body: string; headers?: Record<string, string> }

export interface GatewayConfig {
  inventoryUrl: string;
  queueUrl: string;
  secret: string;
}

/**
 * Edge policy:
 *  - /queue/*  -> waiting-room, rate limited per client IP (cheap, public)
 *  - /holds, /confirm -> inventory, needs a valid admission token, rate limited per user
 *  - availability -> inventory, per IP
 */
export class GatewayService {
  constructor(
    private readonly cfg: GatewayConfig,
    private readonly ipLimiter: RateLimiter,
    private readonly userLimiter: RateLimiter,
    private readonly upstream: Upstream
  ) {}

  /** `forwardedFor` is the x-forwarded-for value to send upstream (the chain, see app.ts); defaults to the single client ip. */
  async handle(method: string, path: string, query: string, body: string | undefined, ip: string, admission?: string, forwardedFor?: string): Promise<Reply> {
    const fwd = forwardedFor ?? ip;
    const m = path.match(/^\/events\/(\d+)\/(queue\/(?:join|status)|holds|confirm|availability)$/);
    if (!m) return { status: 404, body: '{"error":"not found"}' };
    const eventId = Number(m[1]);
    const route = m[2];

    if (route.startsWith("queue/")) return this.forward("queue", "ip", this.ipLimiter, `ip:${ip}`, path, query, method, body, fwd, false);
    // Public read: if the limiter store is down, serve anyway (fail open). Availability is cheap and cacheable.
    if (route === "availability") return this.forward("inventory", "ip", this.ipLimiter, `ip:${ip}`, path, query, method, body, fwd, true);

    const who = admission ? verifyAdmission(admission, eventId, this.cfg.secret) : null;
    if (!who) { admissionRejected.inc(); return { status: 403, body: '{"error":"admission required"}' }; }
    // Holds and confirms are POST-only: the identity check below needs a body, and forwarding any other method would
    // skip it (inventory has no other route on these paths today, but a future one would inherit the hole).
    if (method !== "POST") return { status: 405, body: '{"error":"method not allowed"}', headers: { allow: "POST" } };
    // Holds spend scarce inventory: fail closed, with a fast 503, if we cannot enforce the limit.
    // The token proves who was admitted; the body says who the seats are for. They must be the same person,
    // otherwise an admitted user could hold or confirm seats as somebody else. The check runs after the per-user
    // limiter allowed the request, so malformed bodies spend the user's tokens (429 wins over 400/403).
    const gate = (): Reply | null => {
      let bodyUser: unknown;
      try { bodyUser = JSON.parse(body ?? "")?.userId; } catch { return { status: 400, body: '{"error":"invalid json body"}' }; }
      if (bodyUser !== who.userId) { admissionRejected.inc(); return { status: 403, body: '{"error":"user does not match admission token"}' }; }
      return null;
    };
    return this.forward("inventory", "user", this.userLimiter, `user:${who.userId}`, path, query, method, body, fwd, false, gate);
  }

  private async forward(upstreamName: "queue" | "inventory", limiterName: "ip" | "user", limiter: RateLimiter, key: string, path: string, query: string, method: string, body: string | undefined, forwardedFor: string, failOpen: boolean, gate?: () => Reply | null): Promise<Reply> {
    let r: { allowed: boolean };
    let limiterDown = false;
    try { r = await limiter.take(key); }
    catch {
      limiterDown = true;
      if (!failOpen) { limiterDecisions.inc({ limiter: limiterName, decision: "fail_closed" }); return { status: 503, body: '{"error":"limiter unavailable"}', headers: { "retry-after": "1" } }; }
      limiterDecisions.inc({ limiter: limiterName, decision: "fail_open" });
      r = { allowed: true };
    }
    if (!r.allowed) { limiterDecisions.inc({ limiter: limiterName, decision: "limited" }); return { status: 429, body: '{"error":"rate limited"}', headers: { "retry-after": "1" } }; }
    if (!limiterDown) limiterDecisions.inc({ limiter: limiterName, decision: "allowed" });
    const rejected = gate?.();
    if (rejected) return rejected;
    const base = upstreamName === "queue" ? this.cfg.queueUrl : this.cfg.inventoryUrl;
    const t0 = process.hrtime.bigint();
    try {
      const res = await this.upstream(`${base}${path}${query}`, { method, body, headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor, ...outgoingHeaders() } });
      return { status: res.status, body: res.body };
    } catch (e) {
      upstreamErrors.inc({ upstream: upstreamName, reason: (e as Error)?.name === "TimeoutError" ? "timeout" : "unreachable" });
      return { status: 504, body: '{"error":"upstream timeout or unreachable"}' }; // bounded wait instead of a hanging connection
    } finally {
      upstreamDuration.observe({ upstream: upstreamName }, Number(process.hrtime.bigint() - t0) / 1e9);
    }
  }
}
