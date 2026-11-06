import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import Redis from "ioredis";
import { createShutdown, drainHttp, initService, loadConfigOrExit, Readiness, redisCheck, shutdownEnv, startLoop, wireNest } from "@boxoffice/platform";
import { AppModule } from "./app.module";
import { admissionErrors, registerQueueLengthGauge } from "./metrics";
import { QueueService, REDIS } from "./queue.service";

/** The admission tick serves one event (the sale being run). */
const ADMISSION_EVENT_ID = 1;

async function bootstrap() {
  const log = initService("waiting-room");
  const cfg = loadConfigOrExit((e) => {
    e.secret("ADMISSION_SECRET", "dev-secret"); // validated here; queue.controller reads it (and ADMIT_PER_SECOND, for the ETA) at import
    e.url("REDIS_URL", "redis://localhost:56379", ["redis:", "rediss:"]);
    return { port: e.port("PORT", 3102), admitPerSecond: e.int("ADMIT_PER_SECOND", 500, { min: 1 }), shutdown: shutdownEnv(e) };
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: ["error"] });
  const q = app.get(QueueService);
  const redis = app.get<Redis>(REDIS);
  registerQueueLengthGauge(q, ADMISSION_EVENT_ID);
  const readiness = new Readiness([redisCheck(redis)], { cacheMs: 1000 });
  wireNest(app, readiness);

  // Admission tick: every 100 ms release a tenth of the per-second budget.
  const tick = startLoop({
    name: "admission", intervalMs: 100,
    fn: () => q.admit(ADMISSION_EVENT_ID, Math.max(1, Math.round(cfg.admitPerSecond / 10))).then(() => undefined),
    onError: () => admissionErrors.inc()
  });

  const shutdown = createShutdown({ ...cfg.shutdown, readiness });
  shutdown.add("http server (stop accepting, drain in-flight)", () => drainHttp(app.getHttpServer(), () => app.close()));
  shutdown.add("admission tick", () => tick.stop());
  shutdown.add("redis", async () => { await redis.quit().catch(() => redis.disconnect()); });
  shutdown.install();

  await app.listen({ port: cfg.port, host: "0.0.0.0", backlog: 4096 });
  log.info("listening", { port: cfg.port });
}
bootstrap().catch((e) => { console.error(e); process.exit(1); });
