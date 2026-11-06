import Redis from "ioredis";
import { buildApp } from "./app";
import { GatewayService } from "./gateway.service";
import { RateLimiter } from "./rate-limiter";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:56379", {
  // Fail fast when Redis is gone: no offline queue, 200 ms per command, so the gateway can apply its fail-open/closed policy.
  enableOfflineQueue: false, commandTimeout: 200, maxRetriesPerRequest: 1
});
redis.on("error", () => undefined); // reconnection is automatic; errors surface per request
const svc = new GatewayService(
  {
    inventoryUrl: process.env.INVENTORY_URL ?? "http://localhost:3101",
    queueUrl: process.env.QUEUE_URL ?? "http://localhost:3102",
    secret: process.env.ADMISSION_SECRET ?? "dev-secret"
  },
  new RateLimiter(redis, Number(process.env.IP_RATE ?? 50), Number(process.env.IP_BURST ?? 100)),
  new RateLimiter(redis, Number(process.env.USER_RATE ?? 5), Number(process.env.USER_BURST ?? 10)),
  async (url, init) => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(Number(process.env.UPSTREAM_TIMEOUT_MS ?? 2000)) });
    return { status: res.status, body: await res.text() };
  }
);

const app = buildApp(svc, (process.env.TRUST_PROXY ?? "").split(",").map((x) => x.trim()).filter(Boolean));
app.listen({ port: Number(process.env.PORT ?? 3100), host: "0.0.0.0", backlog: 4096 });
