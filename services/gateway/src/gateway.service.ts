import { verifyAdmission } from "@boxoffice/admission";
import { RateLimiter } from "./rate-limiter";

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

  async handle(method: string, path: string, query: string, body: string | undefined, ip: string, admission?: string): Promise<Reply> {
    const m = path.match(/^\/events\/(\d+)\/(queue\/(?:join|status)|holds|confirm|availability)$/);
    if (!m) return { status: 404, body: '{"error":"not found"}' };
    const eventId = Number(m[1]);
    const route = m[2];

    if (route.startsWith("queue/")) return this.forward(this.ipLimiter, `ip:${ip}`, this.cfg.queueUrl, path, query, method, body, ip);
    if (route === "availability") return this.forward(this.ipLimiter, `ip:${ip}`, this.cfg.inventoryUrl, path, query, method, body, ip);

    const who = admission ? verifyAdmission(admission, eventId, this.cfg.secret) : null;
    if (!who) return { status: 403, body: '{"error":"admission required"}' };
    return this.forward(this.userLimiter, `user:${who.userId}`, this.cfg.inventoryUrl, path, query, method, body, ip);
  }

  private async forward(limiter: RateLimiter, key: string, base: string, path: string, query: string, method: string, body: string | undefined, ip: string): Promise<Reply> {
    const r = await limiter.take(key);
    if (!r.allowed) return { status: 429, body: '{"error":"rate limited"}', headers: { "retry-after": "1" } };
    const res = await this.upstream(`${base}${path}${query}`, { method, body, headers: { "content-type": "application/json", "x-forwarded-for": ip } });
    return { status: res.status, body: res.body };
  }
}
