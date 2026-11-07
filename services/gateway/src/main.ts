import Redis from "ioredis";
import { createShutdown, drainHttp, initService, loadConfigOrExit, Readiness, redisCheck, shutdownEnv, startOpsServer } from "@boxoffice/platform";
import { buildApp } from "./app";
import { GatewayService } from "./gateway.service";
import { RateLimiter } from "./rate-limiter";

const log = initService("gateway");
const cfg = loadConfigOrExit((e) => ({
  port: e.port("PORT", 3100),
  opsPort: e.port("OPS_PORT", 3106),
  // Loopback by default: the ops port exposes limiter counters and raw dependency errors and must not be reachable from wherever the public port is. Containers set 0.0.0.0 and keep the port off the public network.
  opsHost: e.str("OPS_HOST", "127.0.0.1"),
  redisUrl: e.url("REDIS_URL", "redis://localhost:56379", ["redis:", "rediss:"]),
  inventoryUrl: e.url("INVENTORY_URL", "http://localhost:3101"),
  queueUrl: e.url("QUEUE_URL", "http://localhost:3102"),
  paymentsUrl: e.url("PAYMENTS_URL", "http://localhost:3103"),
  secret: e.secret("ADMISSION_SECRET", "dev-secret"),
  // Shared secret sent to payments on every forwarded payment; must equal the payments service's. Refused with the dev default in production.
  internalToken: e.secret("PAYMENTS_INTERNAL_TOKEN", "dev-internal-token"),
  ipRate: e.num("IP_RATE", 50, { min: 0.0001 }), ipBurst: e.num("IP_BURST", 100, { min: 1 }),
  userRate: e.num("USER_RATE", 5, { min: 0.0001 }), userBurst: e.num("USER_BURST", 10, { min: 1 }),
  upstreamTimeoutMs: e.int("UPSTREAM_TIMEOUT_MS", 2000, { min: 1 }),
  trustProxy: e.list("TRUST_PROXY"),
  shutdown: shutdownEnv(e)
}));

const redis = new Redis(cfg.redisUrl, {
  // Fail fast when Redis is gone: no offline queue, 200 ms per command, so the gateway can apply its fail-open/closed policy.
  enableOfflineQueue: false, commandTimeout: 200, maxRetriesPerRequest: 1
});
redis.on("error", () => undefined); // reconnection is automatic; errors surface per request
const svc = new GatewayService(
  { inventoryUrl: cfg.inventoryUrl, queueUrl: cfg.queueUrl, paymentsUrl: cfg.paymentsUrl, secret: cfg.secret, internalToken: cfg.internalToken },
  new RateLimiter(redis, cfg.ipRate, cfg.ipBurst),
  new RateLimiter(redis, cfg.userRate, cfg.userBurst),
  async (url, init) => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(cfg.upstreamTimeoutMs) });
    return { status: res.status, body: await res.text() };
  }
);

// Redis is a soft dependency here: availability fails open, so a Redis outage degrades the gateway but must not pull every instance out of rotation.
const readiness = new Readiness([redisCheck(redis, "redis", false)], { cacheMs: 1000 });
const app = buildApp(svc, cfg.trustProxy);

const fatal = (what: string) => (e: unknown) => { log.fatal(`${what} failed`, { err: e }); process.exit(1); };

async function main() {
  await app.listen({ port: cfg.port, host: "0.0.0.0", backlog: 4096 });
  // /healthz, /readyz and /metrics are internal: they are served on their own port, never on the public listener.
  // Started after the public listener so "ops port answers" implies "gateway is serving". Unlike the notifications consumer,
  // a port clash is fatal here: a gateway nobody can scrape or probe must not take traffic.
  const ops = await startOpsServer(cfg.opsPort, readiness, cfg.opsHost);

  const shutdown = createShutdown({ ...cfg.shutdown, readiness });
  shutdown.add("http server (stop accepting, drain in-flight)", () => drainHttp(app.server, () => app.close()));
  shutdown.add("ops server", () => new Promise<void>((r) => { ops.close(() => r()); ops.closeAllConnections(); }));
  shutdown.add("redis", async () => { await redis.quit().catch(() => redis.disconnect()); });
  shutdown.install();
  log.info("listening", { port: cfg.port, opsPort: cfg.opsPort, opsHost: cfg.opsHost });
}
main().catch(fatal("startup"));
