import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { createPool as createSharedPool, createShutdown, drainHttp, initService, loadConfigOrExit, pgCheck, Readiness, shutdownEnv, wireNest } from "@boxoffice/platform";
import { Pool } from "pg";
import { AppModule } from "./app.module";
import { createPool, migrate, seed } from "./db";
import { installInternalAuth } from "./internal-auth";
import { HOLD_SECONDS, PG } from "./inventory.service";

async function bootstrap() {
  const log = initService("inventory");
  const cfg = loadConfigOrExit((e) => ({
    port: e.port("PORT", 3101),
    pgPool: e.int("PG_POOL", 20, { min: 1 }),
    holdSeconds: e.int("HOLD_SECONDS", HOLD_SECONDS, { min: 1 }), // read again by app.module.ts; validated here so a bad value exits 78
    seedSeats: e.int("SEED_SEATS", 0, { min: 0 }),
    shutdown: shutdownEnv(e),
    // Key of the service-to-service request signature (the gateway and payments sign with it, the secret itself is never sent); the development
    // default is refused with NODE_ENV=production. The previous key is accepted as well while it is being rotated out.
    internalToken: e.secret("INVENTORY_INTERNAL_TOKEN", "dev-inventory-internal-token"),
    internalTokenPrevious: e.optionalSecret("INVENTORY_INTERNAL_TOKEN_PREVIOUS", ["dev-inventory-internal-token"])
  }));
  const pool = createPool(2, 0); // migrations and seeding: no statement timeout
  await migrate(pool);
  if (cfg.seedSeats) await seed(pool, 1, cfg.seedSeats);
  await pool.end();

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: ["error"] });
  // Readiness uses its own single connection, so a saturated work pool cannot flap readiness and pull every instance out at once.
  const healthPool = createSharedPool({ max: 1, applicationName: "inventory-health" });
  const readiness = new Readiness([pgCheck(healthPool)], { cacheMs: 1000 });
  const fastify = wireNest(app, readiness);
  installInternalAuth(fastify, cfg.internalTokenPrevious ? [cfg.internalToken, cfg.internalTokenPrevious] : [cfg.internalToken]); // after the instrumentation hooks, so 401s are counted; before any body parsing or handler

  const shutdown = createShutdown({ ...cfg.shutdown, readiness });
  shutdown.add("http server (stop accepting, drain in-flight)", () => drainHttp(app.getHttpServer(), () => app.close()));
  const workPool = app.get<Pool>(PG);
  shutdown.add("postgres pools", async () => { await Promise.all([workPool.end(), healthPool.end()]); });
  shutdown.install();

  await app.listen(cfg.port, "0.0.0.0");
  log.info("listening", { port: cfg.port });
}
bootstrap().catch((e) => { console.error(e); process.exit(1); });
