import { connect } from "node:net";
import type { Pool } from "pg";

export interface Check {
  name: string;
  /** A non-critical dependency is reported but does not make the service not-ready (it degrades, it does not stop). */
  critical?: boolean;
  run: () => Promise<unknown>;
}

export interface CheckResult { ok: boolean; critical: boolean; latencyMs: number; error?: string }
export interface ReadyBody { status: "ready" | "not_ready" | "shutting_down"; checks: Record<string, CheckResult> }

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/**
 * Readiness = "should the load balancer send me traffic". Liveness (/healthz) never calls a dependency, because restarting
 * a healthy process cannot fix a dead database. While draining, readiness is false so traffic moves away first.
 */
export class Readiness {
  private draining = false;
  private cached?: { at: number; res: { ok: boolean; body: ReadyBody } };

  constructor(private readonly checks: Check[], private readonly o: { timeoutMs?: number; cacheMs?: number } = {}) {}

  setDraining(): void { this.draining = true; this.cached = undefined; }
  get isDraining(): boolean { return this.draining; }

  async evaluate(): Promise<{ ok: boolean; body: ReadyBody }> {
    if (this.draining) return { ok: false, body: { status: "shutting_down", checks: {} } };
    const now = Date.now();
    if (this.cached && now - this.cached.at < (this.o.cacheMs ?? 0)) return this.cached.res;
    const timeoutMs = this.o.timeoutMs ?? 1000;
    const entries = await Promise.all(this.checks.map(async (c): Promise<[string, CheckResult]> => {
      const t0 = Date.now();
      const critical = c.critical !== false;
      try { await withTimeout(c.run(), timeoutMs, c.name); return [c.name, { ok: true, critical, latencyMs: Date.now() - t0 }]; }
      catch (e) { return [c.name, { ok: false, critical, latencyMs: Date.now() - t0, error: (e as Error).message }]; }
    }));
    const checks = Object.fromEntries(entries);
    const ok = entries.every(([, r]) => r.ok || !r.critical);
    const res = { ok, body: { status: ok ? "ready" : "not_ready", checks } as ReadyBody };
    this.cached = { at: now, res };
    return res;
  }
}

export const pgCheck = (pool: Pick<Pool, "query">, name = "postgres", critical = true): Check => ({ name, critical, run: () => pool.query("SELECT 1") });
export const redisCheck = (redis: { ping(): Promise<unknown> }, name = "redis", critical = true): Check => ({ name, critical, run: () => redis.ping() });

/** Reachability of a TCP endpoint (used for the Kafka broker: cheap, no protocol round trip, no consumer-group side effects). */
export function tcpCheck(hostPort: string, name: string, critical = true): Check {
  const i = hostPort.lastIndexOf(":");
  const host = hostPort.slice(0, i), port = Number(hostPort.slice(i + 1));
  return {
    name, critical,
    run: () => new Promise<void>((resolve, reject) => {
      const s = connect({ host, port });
      s.once("connect", () => { s.destroy(); resolve(); });
      s.once("error", (e) => { s.destroy(); reject(e); });
    })
  };
}
