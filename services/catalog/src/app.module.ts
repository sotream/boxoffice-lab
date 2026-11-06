import { Module } from "@nestjs/common";
import Redis from "ioredis";
import { registerPoolMetrics } from "@boxoffice/platform";
import { Cache } from "./cache";
import { CatalogController } from "./catalog.controller";
import { CatalogService } from "./catalog.service";
import { createPool } from "./db";

export const PG_POOL = "CATALOG_PG_POOL";
export const REDIS_CLIENT = "CATALOG_REDIS";

@Module({
  controllers: [CatalogController],
  providers: [
    { provide: PG_POOL, useFactory: () => { const p = createPool(Number(process.env.PG_POOL ?? 20)); registerPoolMetrics(p, "main"); return p; } },
    { provide: REDIS_CLIENT, useFactory: () => new Redis(process.env.REDIS_URL ?? "redis://localhost:56379") },
    { provide: CatalogService, useFactory: (pool) => new CatalogService(pool), inject: [PG_POOL] },
    { provide: Cache, useFactory: (redis) => new Cache(redis, Number(process.env.CACHE_TTL ?? 30)), inject: [REDIS_CLIENT] }
  ]
})
export class AppModule {}
