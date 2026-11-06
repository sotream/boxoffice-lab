import "reflect-metadata";
import Fastify from "fastify";
import Redis from "ioredis";
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
    const res = await fetch(url, init);
    return { status: res.status, body: await res.text() };
  }
);

const app = Fastify({ logger: false });
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
app.all("/*", async (req, reply) => {
  const [path, qs] = req.url.split("?");
  const r = await svc.handle(req.method, path, qs ? `?${qs}` : "", req.body as string | undefined, req.ip, req.headers["x-admission"] as string | undefined);
  reply.status(r.status).headers({ "content-type": "application/json", ...r.headers }).send(r.body);
});
app.listen({ port: Number(process.env.PORT ?? 3100), host: "0.0.0.0", backlog: 4096 });
