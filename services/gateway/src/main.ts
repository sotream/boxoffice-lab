import Redis from "ioredis";
import { createShutdown, drainHttp, initService, loadConfigOrExit, Readiness, redisCheck, shutdownEnv } from "@boxoffice/platform";
import { buildApp } from "./app";
import { GatewayService } from "./gateway.service";
import { RateLimiter } from "./rate-limiter";

const log = initService("gateway");
const cfg = loadConfigOrExit((e) => ({
  port: e.port("PORT", 3100),
  redisUrl: e.url("REDIS_URL", "redis://localhost:56379", ["redis:", "rediss:"]),
  inventoryUrl: e.url("INVENTORY_URL", "http://localhost:3101"),
  queueUrl: e.url("QUEUE_URL", "http://localhost:3102"),
  secret: e.secret("ADMISSION_SECRET", "dev-secret"),
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
  { inventoryUrl: cfg.inventoryUrl, queueUrl: cfg.queueUrl, secret: cfg.secret },
  new RateLimiter(redis, cfg.ipRate, cfg.ipBurst),
  new RateLimiter(redis, cfg.userRate, cfg.userBurst),
  async (url, init) => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(cfg.upstreamTimeoutMs) });
    return { status: res.status, body: await res.text() };
  }
);

// Redis is a soft dependency here: availability fails open, so a Redis outage degrades the gateway but must not pull every instance out of rotation.
const readiness = new Readiness([redisCheck(redis, "redis", false)], { cacheMs: 1000 });
const app = buildApp(svc, cfg.trustProxy, { readiness });

const shutdown = createShutdown({ ...cfg.shutdown, readiness });
shutdown.add("http server (stop accepting, drain in-flight)", () => drainHttp(app.server, () => app.close()));
shutdown.add("redis", async () => { await redis.quit().catch(() => redis.disconnect()); });
shutdown.install();

app.listen({ port: cfg.port, host: "0.0.0.0", backlog: 4096 }).then(() => log.info("listening", { port: cfg.port }), (e) => { log.fatal("listen failed", { err: e }); process.exit(1); });
