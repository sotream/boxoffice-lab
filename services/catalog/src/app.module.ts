import { Module } from "@nestjs/common";
import Redis from "ioredis";
import { Cache } from "./cache";
import { CatalogController } from "./catalog.controller";
import { CatalogService } from "./catalog.service";
import { createPool } from "./db";

@Module({
  controllers: [CatalogController],
  providers: [
    { provide: CatalogService, useFactory: () => new CatalogService(createPool(Number(process.env.PG_POOL ?? 20))) },
    { provide: Cache, useFactory: () => new Cache(new Redis(process.env.REDIS_URL ?? "redis://localhost:56379"), Number(process.env.CACHE_TTL ?? 30)) }
  ]
})
export class AppModule {}
