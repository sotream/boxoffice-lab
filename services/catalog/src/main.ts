import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import Redis from "ioredis";
import { Pool } from "pg";
import { createPool as createSharedPool, createShutdown, drainHttp, initService, loadConfigOrExit, pgCheck, Readiness, redisCheck, shutdownEnv, wireNest } from "@boxoffice/platform";
import { AppModule, PG_POOL, REDIS_CLIENT } from "./app.module";
import { createPool, migrate, seed } from "./db";

async function bootstrap() {
  const log = initService("catalog");
  const cfg = loadConfigOrExit((e) => {
    e.int("PG_POOL", 20, { min: 1 }); e.int("CACHE_TTL", 30, { min: 1 }); e.url("REDIS_URL", "redis://localhost:56379", ["redis:", "rediss:"]);
    return { port: e.port("PORT", 3104), seedEvents: e.int("SEED_EVENTS", 0, { min: 0 }), shutdown: shutdownEnv(e) };
  });
  const pool = createPool(2, 0); // migrations and seeding: no statement timeout
  await migrate(pool);
  if (cfg.seedEvents) await seed(pool, cfg.seedEvents);
  await pool.end();

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: ["error"] });
  const healthPool = createSharedPool({ max: 1, applicationName: "catalog-health" });
  const redis = app.get<Redis>(REDIS_CLIENT);
  // Redis is only a cache here (a failure acts as a miss), so it is reported but does not make the service not-ready.
  const readiness = new Readiness([pgCheck(healthPool), redisCheck(redis, "redis", false)], { cacheMs: 1000 });
  wireNest(app, readiness);

  const workPool = app.get<Pool>(PG_POOL);
  const shutdown = createShutdown({ ...cfg.shutdown, readiness });
  shutdown.add("http server (stop accepting, drain in-flight)", () => drainHttp(app.getHttpServer(), () => app.close()));
  shutdown.add("postgres pools", async () => { await Promise.all([workPool.end(), healthPool.end()]); });
  shutdown.add("redis", async () => { await redis.quit().catch(() => redis.disconnect()); });
  shutdown.install();

  await app.listen({ port: cfg.port, host: "0.0.0.0", backlog: 4096 });
  log.info("listening", { port: cfg.port });
}
bootstrap().catch((e) => { console.error(e); process.exit(1); });
